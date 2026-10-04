import assert from 'node:assert/strict'

import { buildStandSeed } from '../src/data/stand-seed'
import {
  allocateStand,
  buildTimeline,
  changeStandStatus,
  listAllocations,
  listBridgeChecks,
  releaseAllocation,
} from '../src/domain/stand'
import { listRows, saveRows } from '../src/data/local-store'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, value: string) => {
    store[key] = value
  },
}
;(globalThis as { window?: unknown }).window = { localStorage: localStorageMock }

function seed() {
  for (const key of Object.keys(store)) delete store[key]
  const bundle = buildStandSeed()
  saveRows('stand', bundle.stand)
  saveRows('bridge', bundle.bridge)
  saveRows('flight', bundle.flight)
  saveRows('standAllocation', bundle.allocation as unknown as never[])
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
function isoAt(offsetMin: number): string {
  const date = new Date(Date.now() + offsetMin * 60_000)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function today(): string {
  return isoAt(0).slice(0, 10)
}

let passed = 0
function check(name: string, fn: () => void) {
  seed()
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 视图空档与机位状态同源：占用中的机位必有覆盖当前时刻的生效占用，空闲机位当前时刻必落在空档里。
check('占用视图空档与机位状态一致', () => {
  const { groups, stands } = buildTimeline(today())
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  for (const group of groups) {
    for (const row of group.rows) {
      const status = row.stand.status
      if (status === '占用中') {
        const covering = row.active.some((seg) => seg.startMin <= nowMin && seg.endMin > nowMin)
        assert.equal(covering, true, `机位 ${row.stand['机位编号']} 占用中但时间轴当前时刻没有占用段`)
      }
      if (status === '空闲') {
        const inGap = row.gaps.some((gap) => gap.startMin <= nowMin && gap.endMin > nowMin)
        assert.equal(inGap, true, `机位 ${row.stand['机位编号']} 空闲但时间轴当前时刻不在空档里`)
      }
    }
  }
  assert.ok(stands.length === 8)
})

// 2. 机型不匹配整条拒绝：窄体机位不收宽体机，数据不发生任何变化。
check('机型与机位类型不匹配整条拒绝', () => {
  const before = listAllocations().length
  const bridgesBefore = listRows('bridge').length
  const result = allocateStand({
    standCode: '102',
    flight: 'TEST-WIDE',
    aircraft: 'B777',
    priority: '要客',
    startISO: isoAt(400),
    endISO: isoAt(460),
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /机型不匹配/)
  assert.equal(listAllocations().length, before, '被拒绝后占用台账不应增加')
  assert.equal(listRows('bridge').length, bridgesBefore, '被拒绝后廊桥作业不应增加')
})

// 3. 同一机位同一时段只保留一条生效占用：低优先级申请被拒；高优先级可以让位低优先级并撤回其廊桥待办。
check('冲突仲裁：低等级被高等级让位，同级先到先得', () => {
  const stand = '101'
  const common = { standCode: stand }
  // 先到的普通
  const first = allocateStand({ ...common, flight: 'LOW-1', aircraft: 'A320', priority: '普通', startISO: isoAt(600), endISO: isoAt(660) })
  assert.equal(first.ok, true, first.message)
  const firstJob = listAllocations().find((r) => r['航班号'] === 'LOW-1')!['廊桥作业编号']
  assert.ok(firstJob, '近机位分配后应生成廊桥作业编号')

  // 同级后到被拒
  const sameLevel = allocateStand({ ...common, flight: 'LOW-2', aircraft: 'A320', priority: '普通', startISO: isoAt(610), endISO: isoAt(650) })
  assert.equal(sameLevel.ok, false)
  assert.match(sameLevel.message, /重叠/)

  // 高等级后到，原占用让位且廊桥待办撤回
  const vip = allocateStand({ ...common, flight: 'VIP-1', aircraft: 'A320', priority: '要客', startISO: isoAt(605), endISO: isoAt(655) })
  assert.equal(vip.ok, true, vip.message)
  const activeAtSlot = listAllocations().filter(
    (r) => r.status === '生效' && String(r['机位编号']) === stand && r['航班号'] === 'VIP-1',
  )
  assert.equal(activeAtSlot.length, 1)
  const displaced = listAllocations().find((r) => r['航班号'] === 'LOW-1')!
  assert.equal(displaced.status, '已让位')
  const staleJob = listRows('bridge').find((r) => String(r['作业编号']) === firstJob)
  assert.equal(staleJob, undefined, '让位航班的廊桥待办应被撤回')
})

// 4. 重复分配幂等：同机位同航班同时段再提交只留一条。
check('重复分配只保留一条占用', () => {
  const payload = {
    standCode: '102',
    flight: 'DUP-1',
    aircraft: 'A320',
    priority: '普通',
    startISO: isoAt(500),
    endISO: isoAt(560),
  }
  assert.equal(allocateStand(payload).ok, true)
  const again = allocateStand(payload)
  assert.equal(again.ok, false)
  assert.match(again.message, /重复/)
  const copies = listAllocations().filter((r) => r['航班号'] === 'DUP-1')
  assert.equal(copies.length, 1)
})

// 5. 状态逐级流转：空闲→维护中、空闲→已封闭等越级全部拒绝；相邻一级放行。
check('机位状态越级变更拒绝受理', () => {
  const idle = listRows('stand').find((r) => r.status === '空闲')!
  assert.equal(changeStandStatus(idle.id, '开始维护').ok, false, '空闲→维护中是越级')
  assert.equal(changeStandStatus(idle.id, '封闭机位').ok, false, '空闲→已封闭是越级')

  const busy = listRows('stand').find((r) => r.status === '占用中')!
  assert.equal(changeStandStatus(busy.id, '封闭机位').ok, false, '占用中→已封闭是越级，应拒绝')
  const toMaint = changeStandStatus(busy.id, '开始维护')
  assert.equal(toMaint.ok, true, toMaint.message)
  assert.equal(changeStandStatus(busy.id, '封闭机位').ok, true, '维护中→已封闭是相邻一级，应受理')
})

// 6. 封闭/维护中的机位拒绝分配；维护中完成维保但无在停占用时拒绝（不得越级回空闲）。
check('维护中完成维保无在停占用时拒绝', () => {
  const busy = listRows('stand').find((r) => r.status === '占用中')!
  assert.equal(changeStandStatus(busy.id, '开始维护').ok, true)
  const finish = changeStandStatus(busy.id, '完成维保')
  // 该维护机位（101 有在停段）——101 当前确实在停，应能回到占用中；改用 301（维护中且无在停）验证拒绝
  const maint301 = listRows('stand').find((r) => String(r['机位编号']) === '301')!
  const finish301 = changeStandStatus(maint301.id, '完成维保')
  assert.equal(finish301.ok, false)
  assert.match(finish301.message, /没有在停航班占用|越级/)
  void finish
})

check('封闭机位拒绝分配', () => {
  const result = allocateStand({
    standCode: '302',
    flight: 'X-1',
    aircraft: 'A320',
    priority: '普通',
    startISO: isoAt(300),
    endISO: isoAt(360),
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /已封闭/)
})

// 7. 分配结果反映到廊桥待办：近机位生成待靠接，远机位无廊桥不生成；释放占用后廊桥置已撤离。
check('廊桥待办联动：生成与释放', () => {
  const near = allocateStand({
    standCode: '102',
    flight: 'BR-1',
    aircraft: 'A320',
    priority: '普通',
    startISO: isoAt(500),
    endISO: isoAt(560),
  })
  assert.equal(near.ok, true, near.message)
  const job = listRows('bridge').find((r) => r['航班号'] === 'BR-1')!
  assert.ok(job)
  assert.equal(job.status, '待靠接')
  assert.equal(String(job['对应机位']), '102')

  const remote = allocateStand({
    standCode: '103',
    flight: 'BR-2',
    aircraft: 'B737',
    priority: '普通',
    startISO: isoAt(500),
    endISO: isoAt(560),
  })
  assert.equal(remote.ok, true, remote.message)
  assert.equal(listRows('bridge').some((r) => r['航班号'] === 'BR-2'), false, '无廊桥远机位不生成廊桥作业')

  const alloc = listAllocations().find((r) => r['航班号'] === 'BR-1')!
  assert.equal(releaseAllocation(alloc.id).ok, true)
  const after = listRows('bridge').find((r) => r['航班号'] === 'BR-1')!
  assert.equal(after.status, '已撤离')
})

// 8. 廊桥两侧核对一致：种子数据中每条桥载作业都能在机位台账对上。
check('廊桥作业与机位占用台账核对一致', () => {
  const checks = listBridgeChecks()
  assert.ok(checks.length > 0)
  for (const item of checks) {
    assert.equal(item.consistent, true, `${item.job['作业编号']}: ${item.reason}`)
  }
})

// 9. 释放后机位状态自动回到空闲，台账段进入已释放，时间轴空档重新出现。
check('释放占用后机位回到空闲且空档恢复', () => {
  const busy = listRows('stand').find((r) => String(r['机位编号']) === '201')!
  assert.equal(busy.status, '占用中')
  const active = listAllocations().find(
    (r) => r.status === '生效' && String(r['机位编号']) === '201' && r['航班号'] === 'CK235',
  )!
  assert.equal(releaseAllocation(active.id).ok, true)
  const stand = listRows('stand').find((r) => String(r['机位编号']) === '201')!
  assert.equal(stand.status, '空闲')
  const row = buildTimeline(today()).groups.flatMap((g) => g.rows).find((r) => String(r.stand['机位编号']) === '201')!
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  assert.ok(row.gaps.some((gap) => gap.startMin <= nowMin && gap.endMin > nowMin))
})

console.log(`\n全部 ${passed} 条业务规则测试通过`)

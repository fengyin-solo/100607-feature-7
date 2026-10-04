// 服务层集成测试：Node 环境下 local-store 走无 localStorage 的内存分支。
import { saveRows, __resetForTest } from '@/data/local-store'
import {
  __setClockForTest,
  allocateStand,
  buildTimeline,
  checkBridgeConsistency,
  listStands,
  performStandAction,
  reconcileStands,
  removeOccupancy,
} from './stand-service'
import type { AllocateInput, GuaranteeLevel } from '@/data/types'

let passed = 0
let failed = 0
function assert(condition: boolean, message: string) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error('✗', message)
  }
}

function day(): string {
  const d = new Date()
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function input(over: Partial<AllocateInput>): AllocateInput {
  return {
    standId: 1,
    date: day(),
    startMin: 300,
    endMin: 360,
    航班号: 'TEST1',
    机型: 'A320',
    保障等级: '普通',
    ...over,
  }
}

// 初始种子：廊桥机位占用必须都有廊桥作业
__resetForTest()
__setClockForTest(720) // 12:00
assert(checkBridgeConsistency().length === 0, `种子数据廊桥对账应无异常，实际：${checkBridgeConsistency().map((i) => i.message).join('；')}`)
reconcileStands(720)
const seedStands = listStands()
assert(seedStands.find((s) => s.机位编号 === '101')?.status === '占用中', '对账后 101 在 12:00 应有占用（11:20-12:40）')
assert(seedStands.find((s) => s.机位编号 === '102')?.status === '空闲', '对账后 102 在 12:00 应空闲')
assert(seedStands.find((s) => s.机位编号 === '302')?.status === '维护中', '维护中机位不受对账影响')

// 机型不匹配整条拒绝
const wideOnNarrow = allocateStand(input({ standId: 1, 航班号: 'WIDE1', 机型: 'B777', startMin: 900, endMin: 960 }))
assert(!wideOnNarrow.ok && wideOnNarrow.message.includes('窄体机位'), '窄体机位分配 B777 应整条拒绝')

// 维护中机位拒绝分配
const onMaint = allocateStand(input({ standId: 9, 航班号: 'X', 机型: 'A320' }))
assert(!onMaint.ok && onMaint.message.includes('维护中'), '维护中机位不接受分配')

// 同机位同时段重复分配只留一条
saveRows('standOccupancy', [])
saveRows('bridge', [])
saveRows('stand', listStands().map((s) => (s.机位编号 === '101' ? { ...s, status: '空闲' } : s)))
const first = allocateStand(input({}))
assert(first.ok, '首次分配应成功')
const again = allocateStand(input({}))
assert(!again.ok && again.message.includes('重复分配'), '同航班同时段重复分配应被识别且只留一条')
assert(checkBridgeConsistency().length === 0, '重复分配后廊桥对账仍应正常（只生成一条待办）')

// 同机位两条占用抢时段：要客挤掉普通，并联动生成/中止廊桥待办
const vip = allocateStand(input({ 航班号: 'VIP1', 保障等级: '要客' as GuaranteeLevel }))
assert(vip.ok && (vip.displaced ?? []).includes('TEST1'), '要客航班应挤掉同时段普通航班')
const jobsAfter = checkBridgeConsistency()
assert(jobsAfter.length === 0, '挤占后廊桥待办应与最终占用一致，对账无异常')

// 普通航班抢不过已有的要客
const weak = allocateStand(input({ 航班号: 'NORMAL2', 保障等级: '普通' as GuaranteeLevel, startMin: 330, endMin: 350 }))
assert(!weak.ok && weak.message.includes('让位'), '普通航班抢要客时段应让位拒绝')

// 释放占用
const release = removeOccupancy(vip.occupancy!.id)
assert(release.ok, '待靠接阶段应可释放占用')
assert(checkBridgeConsistency().length === 0, '释放廊桥机位占用后其待办应一并撤销，对账无异常')

// 状态机：越级拒绝
const stand1 = listStands().find((s) => s.机位编号 === '101')!
assert(stand1.status === '空闲', '释放后机位应回到空闲')
const idleClose = performStandAction(stand1.id, '封闭机位')
assert(!idleClose.ok && idleClose.message.includes('越级'), '空闲直封应被拒绝')
const idleMaint = performStandAction(stand1.id, '送维护')
assert(!idleMaint.ok && idleMaint.message.includes('越级'), '空闲直送维护应被拒绝')

// 逐级走完：空闲→占用中→维护中→已封闭
__setClockForTest(330)
const occ = allocateStand(input({ standId: stand1.id, startMin: 300, endMin: 400, 航班号: 'FLOW1' }))
assert(occ.ok, '逐级流程：再次分配成功')
assert(performStandAction(stand1.id, '送维护').ok, '占用中→维护中 应允许')
assert(performStandAction(stand1.id, '封闭机位').ok, '维护中→已封闭 应允许')
const finalStand = listStands().find((s) => s.id === stand1.id)!
assert(finalStand.status === '已封闭', '机位应到达已封闭')
// 维护/封闭机位时间轴整条不可用、无空档
const groups = buildTimeline(day(), 330)
const day101 = groups.flatMap((g) => g.days).find((d) => d.stand.机位编号 === '101')
assert(day101!.gaps.length === 0 && day101!.occupancies.length === 0, '已封闭机位时间轴无空档也不展示占用')

// 解除封闭恢复空闲
assert(performStandAction(stand1.id, '解除封闭').ok, '解除封闭应允许')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}

import { listRows, resetRows, saveRows } from '@/data/local-store'
import { buildStandSeed } from '@/data/stand-seed'
import type { StandAllocation } from '@/data/stand-seed'
import type { ActionResult, EntryRow } from '@/data/types'

export const ALLOCATION_KEY = 'standAllocation'

// 机位状态只能沿这条链逐级走，越级变更一律拒绝。
export const STAND_STATUS_LEVEL = ['空闲', '占用中', '维护中', '已封闭'] as const
const STICKY_STATUS = ['维护中', '已封闭']
const PRIORITY_RANK: Record<string, number> = { 要客: 3, 重要: 2, 普通: 1 }

export type AllocationInput = {
  standCode: string
  flight: string
  aircraft: string
  priority: string
  startISO: string
  endISO: string
}

export type TimelineGap = { startMin: number; endMin: number }
export type TimelineAllocation = StandAllocation & { startMin: number; endMin: number }
export type StandTimeline = {
  stand: EntryRow
  active: TimelineAllocation[]
  gaps: TimelineGap[]
}
export type TimelineGroup = {
  standType: string
  bridge: string
  rows: StandTimeline[]
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function minuteOf(iso: string): number {
  const date = new Date(iso)
  return date.getHours() * 60 + date.getMinutes()
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

export function hm(minute: number): string {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

export function listAllocations(): StandAllocation[] {
  return listRows(ALLOCATION_KEY) as unknown as StandAllocation[]
}

function persistAllocations(rows: StandAllocation[]): void {
  saveRows(ALLOCATION_KEY, rows as unknown as EntryRow[])
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

// 机型必须落在机位「适用机型」里：窄体机位收宽体机整条拒绝。
export function aircraftMatches(accepts: string, aircraft: string): boolean {
  const family = accepts.split(',').map((item) => item.trim()).filter(Boolean)
  return family.some((item) => aircraft.toUpperCase().startsWith(item.toUpperCase()))
}

function findStand(stands: EntryRow[], code: string): EntryRow | undefined {
  return stands.find((row) => String(row['机位编号']) === code)
}

function sameSlot(a: AllocationInput, b: StandAllocation): boolean {
  return (
    b.status === '生效' &&
    b['机位编号'] === a.standCode &&
    b['航班号'] === a.flight &&
    b['开始时间'] === a.startISO &&
    b['结束时间'] === a.endISO
  )
}

function priorityOf(value: string): number {
  return PRIORITY_RANK[value] ?? PRIORITY_RANK['普通']
}

// 台账是视图空档和机位状态的唯一数据源：占用中必有覆盖当前时刻的生效占用，空闲则一条都没有。
function reconcileStands(): EntryRow[] {
  const stands = listRows('stand')
  const active = listAllocations().filter((row) => row.status === '生效')
  const now = new Date()
  const nowMin = now.getTime()
  let changed = false

  const next = stands.map((stand) => {
    const status = String(stand.status)
    if (STICKY_STATUS.includes(status)) {
      return stand
    }
    const code = String(stand['机位编号'])
    const covering = active.find((row) => {
      const start = new Date(row['开始时间'] as string).getTime()
      const end = new Date(row['结束时间'] as string).getTime()
      return String(row['机位编号']) === code && start <= nowMin && end > nowMin
    })
    const derived = covering ? '占用中' : '空闲'
    if (derived !== status) {
      changed = true
    }
    const summary = active
      .filter((row) => String(row['机位编号']) === code)
      .sort((a, b) => String(a['开始时间']).localeCompare(String(b['开始时间'])))
      .map((row) => `${hm(minuteOf(row['开始时间'] as string))}-${hm(minuteOf(row['结束时间'] as string))} ${row['航班号']}`)
      .join('；')
    const patch: EntryRow = {
      ...stand,
      status: derived,
      pending: true,
      当前航班: covering ? covering['航班号'] : '—',
      占用时段: summary || '—',
      机位状态: derived,
    }
    return changed || JSON.stringify(patch) !== JSON.stringify(stand) ? patch : stand
  })

  if (next.some((row, index) => row !== stands[index])) {
    saveRows('stand', next)
  }
  return next
}

// 模块一被访问就先校准一次，避免列表与台账各说各话。
reconcileStands()

function bridgeConfigured(stand: EntryRow): boolean {
  return String(stand['廊桥配置']) !== '无廊桥' && String(stand['廊桥编号'] ?? '') !== ''
}

function createBridgeJob(
  bridges: EntryRow[],
  stand: EntryRow,
  input: AllocationInput,
  jobCode: string,
): void {
  const day = dayOf(input.startISO)
  bridges.push({
    id: nextId(bridges),
    status: '待靠接',
    pending: true,
    abnormal: false,
    作业编号: jobCode,
    航班号: input.flight,
    廊桥编号: stand['廊桥编号'],
    对应机位: input.standCode,
    靠桥时间: `${day} ${hm(minuteOf(input.startISO))}`,
    撤桥时间: '',
    操作人员: '待派工',
    对接检查项: '待检查',
    作业状态: '待靠接',
  })
}

function removeBridgeJob(bridges: EntryRow[], jobCode: string): EntryRow[] {
  return bridges.filter((row) => String(row['作业编号']) !== jobCode)
}

function refreshStandSummary(stands: EntryRow[], code: string): EntryRow[] {
  const active = listAllocations().filter((row) => row.status === '生效')
  return stands.map((stand) => {
    if (String(stand['机位编号']) !== code) {
      return stand
    }
    const list = active
      .filter((row) => String(row['机位编号']) === code)
      .sort((a, b) => String(a['开始时间']).localeCompare(String(b['开始时间'])))
    return { ...stand, 占用时段: list.length ? list.map((row) => `${hm(minuteOf(row['开始时间'] as string))}-${hm(minuteOf(row['结束时间'] as string))} ${row['航班号']}`).join('；') : '—' }
  })
}

export type AllocateResult = ActionResult & { allocationId?: number }

// 分配机位：机型不匹配整条拒绝；同槽位重复分配幂等返回；时段重叠按保障等级让位，同级先到先得。
export function allocateStand(input: AllocationInput): AllocateResult {
  reconcileStands()
  const flight = input.flight.trim()
  const aircraft = input.aircraft.trim()
  if (!flight || !aircraft) {
    return { ok: false, message: '请填写航班号与机型' }
  }
  const start = new Date(input.startISO).getTime()
  const end = new Date(input.endISO).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return { ok: false, message: '占用时段不合法，请检查开始、结束时间' }
  }

  const stands = listRows('stand')
  const stand = findStand(stands, input.standCode)
  if (!stand) {
    return { ok: false, message: `机位 ${input.standCode} 不存在` }
  }
  const standStatus = String(stand.status)
  if (standStatus === '已封闭') {
    return { ok: false, message: `机位 ${input.standCode} 已封闭，不再受理分配` }
  }
  if (standStatus === '维护中') {
    return { ok: false, message: `机位 ${input.standCode} 维护中，暂不能分配` }
  }
  if (!aircraftMatches(String(stand['适用机型'] ?? ''), aircraft)) {
    return {
      ok: false,
      message: `机型不匹配：${stand['机位类型']}（适用 ${stand['适用机型']}）不能接收 ${aircraft}，整条拒绝分配`,
    }
  }

  const allocations = listAllocations()
  const duplicated = allocations.find((row) => sameSlot(input, row))
  if (duplicated) {
    return { ok: false, message: `该占用已登记（台账编号 ${duplicated.id}），重复分配只保留一条` }
  }

  const startMin = minuteOf(input.startISO)
  const endMin = minuteOf(input.endISO)
  const day = dayOf(input.startISO)
  if (dayOf(input.endISO) !== day) {
    return { ok: false, message: '占用时段必须在同一天内，跨天请拆成两条占用' }
  }
  const incomingRank = priorityOf(input.priority)
  const rivals = allocations.filter(
    (row) =>
      row.status === '生效' &&
      String(row['机位编号']) === input.standCode &&
      dayOf(row['开始时间'] as string) === day &&
      overlaps(startMin, endMin, minuteOf(row['开始时间'] as string), minuteOf(row['结束时间'] as string)),
  )

  // 同等级先到先得：存在等级不低于本次申请的重叠占用时，本次申请拒绝。
  const blocker = rivals.find((row) => priorityOf(String(row['保障等级'])) >= incomingRank)
  if (blocker) {
    return {
      ok: false,
      message: `时段与 ${blocker['航班号']}（${blocker['保障等级']}，${hm(minuteOf(blocker['开始时间'] as string))}-${hm(minuteOf(blocker['结束时间'] as string))}）重叠，保障等级不高于对方，本次分配被拒绝`,
    }
  }

  const bridges = listRows('bridge')
  const displacedFlights: string[] = []
  // 先记下编号水位：让位会删掉旧廊桥作业，编号不能因为删除而被复用。
  const jobSeq = nextId(bridges)
  const nextAllocations = allocations.map((row) => {
    if (rivals.includes(row)) {
      displacedFlights.push(String(row['航班号']))
      const job = String(row['廊桥作业编号'] ?? '')
      if (job) {
        const index = bridges.findIndex((item) => String(item['作业编号']) === job)
        if (index >= 0) {
          bridges.splice(index, 1) // 让位的廊桥待办同步撤回，靠接那边看不到对不上的单
        }
      }
      return { ...row, status: '已让位', pending: true, abnormal: true } as StandAllocation
    }
    return row
  })

  const id = nextId(nextAllocations)
  const needBridge = bridgeConfigured(stand)
  const jobCode = needBridge ? `BRDG-${pad2(jobSeq)}` : ''
  const created: StandAllocation = {
    id,
    status: '生效',
    pending: false,
    abnormal: false,
    机位编号: input.standCode,
    航班号: flight,
    机型: aircraft,
    保障等级: input.priority,
    开始时间: input.startISO,
    结束时间: input.endISO,
    廊桥作业编号: jobCode,
    创建时刻: new Date().toISOString().slice(0, 16),
  }
  nextAllocations.push(created)
  persistAllocations(nextAllocations)

  if (needBridge) {
    createBridgeJob(bridges, stand, input, jobCode)
  }
  saveRows('bridge', bridges)
  saveRows('stand', refreshStandSummary(stands, input.standCode))
  reconcileStands()

  const displaced = displacedFlights.length ? `；${displacedFlights.join('、')} 因保障等级较低让位，其廊桥待办已撤回` : ''
  const bridgeNote = needBridge ? `，廊桥待办 ${jobCode} 已生成` : '，该机位无廊桥配置，不生成靠接待办'
  return { ok: true, message: `机位 ${input.standCode} 已分配给 ${flight}${bridgeNote}${displaced}`, allocationId: id }
}

// 释放占用：台账置为已释放，廊桥作业置已撤离，机位状态回到空闲。
export function releaseAllocation(id: number): ActionResult {
  reconcileStands()
  const allocations = listAllocations()
  const target = allocations.find((row) => row.id === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的机位占用` }
  }
  if (target.status !== '生效') {
    return { ok: false, message: `该占用当前为「${target.status}」，不能重复释放` }
  }

  const bridges = listRows('bridge')
  const jobCode = String(target['廊桥作业编号'] ?? '')
  let bridgeChanged = false
  const nextBridges = bridges.map((row) => {
    if (String(row['作业编号']) === jobCode && row.status !== '已撤离') {
      bridgeChanged = true
      return {
        ...row,
        status: '已撤离',
        pending: false,
        撤桥时间: `${dayOf(target['结束时间'] as string)} ${hm(minuteOf(target['结束时间'] as string))}`,
        作业状态: '已撤离',
      }
    }
    return row
  })

  const nextAllocations = allocations.map((row) =>
    row.id === id ? { ...row, status: '已释放', pending: false } as StandAllocation : row,
  )
  persistAllocations(nextAllocations)
  if (bridgeChanged || jobCode) {
    saveRows('bridge', nextBridges)
  }
  const stands = listRows('stand')
  saveRows('stand', refreshStandSummary(stands, String(target['机位编号'])))
  reconcileStands()
  return { ok: true, message: `${target['航班号']} 的占用已释放${jobCode ? `，廊桥作业 ${jobCode} 已置为已撤离` : ''}` }
}

// 人工变更机位状态：空闲 → 占用中 → 维护中 → 已封闭，只受理相邻一级。
export function changeStandStatus(id: number, action: string): ActionResult {
  reconcileStands()
  const stands = listRows('stand')
  const index = stands.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停机位` }
  }
  const stand = stands[index]
  const from = String(stand.status)
  const fromLevel = STAND_STATUS_LEVEL.indexOf(from as (typeof STAND_STATUS_LEVEL)[number])
  const forward: Record<string, string> = { 开始维护: '维护中', 封闭机位: '已封闭' }
  const backward: Record<string, string> = { 完成维保: '占用中', 解除封闭: '维护中', 释放机位: '空闲' }
  let target = forward[action] ?? backward[action]
  if (!target) {
    return { ok: false, message: `停机位没有登记「${action}」这个动作` }
  }
  const targetLevel = STAND_STATUS_LEVEL.indexOf(target as (typeof STAND_STATUS_LEVEL)[number])
  if (Math.abs(targetLevel - fromLevel) !== 1) {
    return { ok: false, message: `机位状态只能逐级流转：${from} 不能越级变更为 ${target}，已拒绝受理` }
  }
  if (action === '开始维护' && from !== '占用中') {
    return { ok: false, message: '只有占用中的机位可以开始维护' }
  }
  if (action === '完成维保') {
    const active = listAllocations().find(
      (row) =>
        row.status === '生效' &&
        String(row['机位编号']) === String(stand['机位编号']) &&
        new Date(row['开始时间'] as string).getTime() <= Date.now() &&
        new Date(row['结束时间'] as string).getTime() > Date.now(),
    )
    if (!active) {
      return { ok: false, message: '该时段没有在停航班占用，维保完成后没有可承接的占用，暂不能变更（不得越级回到空闲）' }
    }
  }
  if (action === '释放机位') {
    const active = listAllocations().find(
      (row) =>
        row.status === '生效' &&
        String(row['机位编号']) === String(stand['机位编号']) &&
        new Date(row['开始时间'] as string).getTime() <= Date.now() &&
        new Date(row['结束时间'] as string).getTime() > Date.now(),
    )
    if (!active) {
      return { ok: false, message: '该机位当前没有在停占用，无需释放' }
    }
    return releaseAllocation(active.id)
  }

  const next = stands.slice()
  next[index] = {
    ...stand,
    status: target,
    pending: target !== '已封闭',
    机位状态: target,
  }
  saveRows('stand', next)
  reconcileStands()
  return { ok: true, message: `机位 ${stand['机位编号']} 已${action}，当前状态「${target}」` }
}

// 占用视图：按机位类型、廊桥配置分组；空档由生效占用反推，与机位状态同源。
export function buildTimeline(day: string): { groups: TimelineGroup[]; stands: EntryRow[] } {
  const stands = reconcileStands()
  const active = listAllocations().filter(
    (row) => row.status === '生效' && dayOf(row['开始时间'] as string) === day,
  )

  const rows: StandTimeline[] = stands.map((stand) => {
    const code = String(stand['机位编号'])
    const segs = active
      .filter((row) => String(row['机位编号']) === code)
      .map((row) => ({
        ...row,
        startMin: minuteOf(row['开始时间'] as string),
        endMin: minuteOf(row['结束时间'] as string),
      }))
      .sort((a, b) => a.startMin - b.startMin)
    const gaps: TimelineGap[] = []
    let cursor = 0
    for (const seg of segs) {
      if (seg.startMin > cursor) {
        gaps.push({ startMin: cursor, endMin: seg.startMin })
      }
      cursor = Math.max(cursor, seg.endMin)
    }
    if (cursor < 24 * 60) {
      gaps.push({ startMin: cursor, endMin: 24 * 60 })
    }
    return { stand, active: segs, gaps }
  })

  const groupsMap = new Map<string, TimelineGroup>()
  for (const row of rows) {
    const key = `${row.stand['机位类型']}|${row.stand['廊桥配置']}`
    const group = groupsMap.get(key) ?? {
      standType: String(row.stand['机位类型']),
      bridge: String(row.stand['廊桥配置']),
      rows: [],
    }
    group.rows.push(row)
    groupsMap.set(key, group)
  }
  const groups = [...groupsMap.values()].map((group) => ({
    ...group,
    rows: group.rows.sort((a, b) =>
      String(a.stand['机位编号']).localeCompare(String(b.stand['机位编号']), 'zh-Hans-CN', { numeric: true }),
    ),
  }))
  groups.sort((a, b) => a.standType.localeCompare(b.standType, 'zh-Hans-CN') || a.bridge.localeCompare(b.bridge, 'zh-Hans-CN'))
  return { groups, stands }
}

export type BridgeCheck = {
  job: EntryRow
  consistent: boolean
  reason: string
}

// 廊桥两侧核对：对应机位必须真实存在、廊桥编号与机位配置一致、占用台账里能对上同一作业编号。
export function listBridgeChecks(): BridgeCheck[] {
  const stands = reconcileStands()
  const allocations = listAllocations()
  return listRows('bridge').map((job) => {
    const code = String(job['对应机位'] ?? '')
    const stand = stands.find((row) => String(row['机位编号']) === code)
    if (!stand) {
      return { job, consistent: false, reason: `机位 ${code} 不存在` }
    }
    if (String(stand['廊桥编号'] ?? '') !== String(job['廊桥编号'] ?? '')) {
      return { job, consistent: false, reason: `廊桥编号与机位配置（${stand['廊桥编号'] || '无'}）不一致` }
    }
    const linked = allocations.find(
      (row) =>
        String(row['廊桥作业编号']) === String(job['作业编号']) &&
        String(row['机位编号']) === code,
    )
    if (!linked) {
      return { job, consistent: false, reason: '机位占用台账中找不到对应作业编号' }
    }
    return { job, consistent: true, reason: `与机位 ${code}、占用 ${linked['航班号']} 对得上` }
  })
}

export function resetStandDemo(): void {
  const bundle = buildStandSeed()
  resetRows('stand')
  resetRows('bridge')
  resetRows('flight')
  saveRows('stand', bundle.stand)
  saveRows('bridge', bundle.bridge)
  saveRows('flight', bundle.flight)
  persistAllocations(bundle.allocation)
  reconcileStands()
}

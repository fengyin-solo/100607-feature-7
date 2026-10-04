import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  AllocateInput,
  AllocateResult,
  BridgeJobRow,
  ConsistencyIssue,
  OccupancyDoc,
  StandDay,
  StandDoc,
  StandStatus,
  TimelineGroup,
} from '@/data/types'
import {
  buildDay,
  canTransition,
  comparePriority,
  effectiveStatus,
  groupDays,
  mismatchReason,
  overlaps,
  toHHMM,
  todayString,
  transitionRejection,
} from './stand-logic'

// 机位领域服务：所有对机位、占用、廊桥待办的写操作都走这里，
// 保证状态机、冲突仲裁、廊桥联动只有一份实现，页面之间不会各说各话。

const STAND_KEY = 'stand'
const OCC_KEY = 'standOccupancy'
const BRIDGE_KEY = 'bridge'

export function listStands(): StandDoc[] {
  return listRows<EntryRowLike>(STAND_KEY).map(rowToStand)
}

export function listOccupancies(): OccupancyDoc[] {
  return listRows<OccupancyDoc>(OCC_KEY)
}

type EntryRowLike = Record<string, string | number | boolean>

function rowToStand(row: EntryRowLike): StandDoc {
  return {
    id: Number(row.id),
    status: String(row.status) as StandStatus,
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    机位编号: String(row.机位编号 ?? ''),
    机位类型: String(row.机位类型 ?? ''),
    适用机型: String(row.适用机型 ?? ''),
    廊桥配置: String(row.廊桥配置 ?? ''),
    近远机位: String(row.近远机位 ?? ''),
  }
}

function findStand(stands: StandDoc[], standId: number): StandDoc | undefined {
  return stands.find((stand) => stand.id === standId)
}

function findStandByCode(stands: StandDoc[], code: string): StandDoc | undefined {
  return stands.find((stand) => stand.机位编号 === code)
}

export function occupanciesOf(date: string): (stand: StandDoc) => OccupancyDoc[] {
  const all = listOccupancies().filter((item) => item.date === date)
  return (stand) => all.filter((item) => item.standId === stand.id)
}

// ── 状态对账：机位行上的空闲/占用中与占用数据强制同源 ───────────────────────

/**
 * 按当天实际占用重算每个机位的「空闲/占用中」。
 * 维护中、已封闭是机位生命周期状态，对账不碰它们。
 */
export function reconcileStands(referenceMinute?: number): StandDoc[] {
  const stands = listStands()
  const minute = referenceMinute ?? currentMinute()
  const date = todayString()
  const todayBlocks = listOccupancies().filter((item) => item.date === date)
  let changed = false
  const next = stands.map((stand) => {
    if (stand.status === '维护中' || stand.status === '已封闭') {
      return stand
    }
    const derived = effectiveStatus(stand, todayBlocks.filter((b) => b.standId === stand.id), minute)
    if (derived !== stand.status) {
      changed = true
      return { ...stand, status: derived, pending: derived !== '已封闭' }
    }
    return stand
  })
  if (changed) {
    persistStands(next)
  }
  return next
}

function currentMinute(): number {
  if (clockOverride !== null) {
    return clockOverride
  }
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

// 仅供领域测试注入「当前时刻」，生产代码不设置。
let clockOverride: number | null = null
export function __setClockForTest(minute: number | null): void {
  clockOverride = minute
}

// ── 时间轴读取 ─────────────────────────────────────────────────────────────

export function buildTimeline(date: string, referenceMinute?: number): TimelineGroup[] {
  const stands = reconcileStands(referenceMinute)
  const pick = occupanciesOf(date)
  const minute = referenceMinute ?? currentMinute()
  const days: StandDay[] = stands.map((stand) => buildDay(stand, pick(stand), minute))
  return groupDays(days)
}

// ── 分配：机型校验 + 冲突仲裁 + 廊桥联动 ───────────────────────────────────

function validateWindow(input: AllocateInput): string | null {
  if (!input.航班号.trim()) {
    return '航班号不能为空'
  }
  if (input.startMin < 0 || input.endMin > 1440 || input.startMin >= input.endMin) {
    return '占用时段不合法：开始须早于结束，且都在 00:00–24:00 之内'
  }
  return null
}

/**
 * 分配机位：
 * 1. 维护中/已封闭机位直接拒绝；
 * 2. 机位类型与机型不匹配整条拒绝；
 * 3. 同一机位同一时段重复分配（同航班同时段）只留一条占用；
 * 4. 两条占用抢同一机位时，保障等级高者优先（要客 > 重要 > 普通），同级先到先得；
 * 5. 廊桥机位分配成功后，廊桥靠接待办自动生成对应作业，两处机位对得上。
 */
export function allocateStand(input: AllocateInput): AllocateResult {
  const stands = listStands()
  const stand = findStand(stands, input.standId)
  if (!stand) {
    return { ok: false, message: '没有找到该机位' }
  }
  if (stand.status === '维护中' || stand.status === '已封闭') {
    return { ok: false, message: `${stand.机位编号}当前「${stand.status}」，不接受分配` }
  }
  const windowError = validateWindow(input)
  if (windowError) {
    return { ok: false, message: windowError }
  }
  const mismatch = mismatchReason(stand, input.机型)
  if (mismatch) {
    return { ok: false, message: mismatch }
  }

  const all = listOccupancies()
  const sameDay = all.filter((item) => item.standId === stand.id && item.date === input.date)
  const candidate: OccupancyDoc = {
    id: `OCC-${stand.id}-${Date.now()}`,
    standId: stand.id,
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    航班号: input.航班号.trim(),
    机型: input.机型.trim().toUpperCase(),
    保障等级: input.保障等级,
    createdAt: Date.now(),
  }

  // 同一机位同一时段重复分配：同航班同时段视为重复，只留一条。
  const duplicate = sameDay.find(
    (item) =>
      item.航班号 === candidate.航班号
      && item.startMin === candidate.startMin
      && item.endMin === candidate.endMin,
  )
  if (duplicate) {
    return { ok: false, message: `${candidate.航班号} 已占用 ${stand.机位编号} ${toHHMM(duplicate.startMin)}-${toHHMM(duplicate.endMin)}，重复分配只保留一条占用` }
  }

  const clash = sameDay.filter((item) => overlaps(item, candidate))
  const keepers: OccupancyDoc[] = []
  const displaced: OccupancyDoc[] = []
  for (const keeper of clash) {
    // comparePriority > 0：守方保留，新分配让位；< 0：新分配挤掉守方。
    if (comparePriority(candidate, keeper) > 0) {
      keepers.push(keeper)
    } else {
      displaced.push(keeper)
    }
  }
  if (keepers.length > 0) {
    const detail = keepers
      .map((item) => `${item.航班号}（${item.保障等级} ${toHHMM(item.startMin)}-${toHHMM(item.endMin)}）`)
      .join('、')
    return {
      ok: false,
      message: `${stand.机位编号} ${toHHMM(candidate.startMin)}-${toHHMM(candidate.endMin)} 已被 ${detail} 占用；${candidate.保障等级}保障不高于现有安排，让位拒绝分配`,
    }
  }

  const nextOccupancies = all.filter((item) => !displaced.some((d) => d.id === item.id))
  nextOccupancies.push(candidate)
  saveRows(OCC_KEY, nextOccupancies)

  // 被挤掉的占用：撤销其廊桥待办，作业留痕为异常中止。
  if (displaced.length > 0) {
    cancelBridgeJobs(displaced)
  }

  // 廊桥机位：分配结果直接进廊桥靠接待办。
  if (stand.廊桥配置 === '有廊桥') {
    createBridgeTodo(stand, candidate)
  }

  // 分配的是当前时刻正在发生的占用，机位状态置占用中；未来的排班等时间到了自然对账。
  const minute = currentMinute()
  if (input.date === todayString() && input.startMin <= minute && minute < input.endMin && stand.status === '空闲') {
    updateStandStatus(stand.id, '占用中')
  }

  const displacedNames = displaced.map((item) => item.航班号)
  const message = displaced.length > 0
    ? `${candidate.航班号} 已分配到 ${stand.机位编号}，高优先级挤掉原占用：${displacedNames.join('、')}`
    : `${candidate.航班号} 已分配到 ${stand.机位编号} ${toHHMM(candidate.startMin)}-${toHHMM(candidate.endMin)}`
  return { ok: true, message, occupancy: candidate, displaced: displacedNames }
}

// ── 释放 / 维护 / 封闭：状态机逐级流转 ─────────────────────────────────────

/**
 * 机位动作状态机：空闲 → 占用中 → 维护中 → 已封闭 逐级走完。
 * 越级（空闲直送维护、空闲直封、占用直封）拒绝受理；
 * 释放机位、维护完成、解除封闭属于恢复动作，复位到空闲。
 */
export function performStandAction(
  standId: number,
  action: '释放机位' | '送维护' | '维护完成' | '封闭机位' | '解除封闭',
): ActionResult {
  const stands = listStands()
  const stand = findStand(stands, standId)
  if (!stand) {
    return { ok: false, message: '没有找到该机位' }
  }
  const from = stand.status
  switch (action) {
    case '释放机位':
      return releaseCurrent(stand)
    case '送维护':
      if (from !== '占用中') {
        return { ok: false, message: from === '空闲'
          ? transitionRejection(from, '维护中')
          : `机位当前为「${from}」，只有占用中的机位可以送维护` }
      }
      if (!canTransition(from, '维护中')) {
        return { ok: false, message: transitionRejection(from, '维护中') }
      }
      return { ok: updateStandStatus(stand.id, '维护中'), message: `${stand.机位编号}已送维护，逐级进入「维护中」` }
    case '维护完成':
      if (from !== '维护中') {
        return { ok: false, message: `机位当前为「${from}」，没有进行中的维护` }
      }
      updateStandStatus(stand.id, '空闲')
      return { ok: true, message: `${stand.机位编号}维护完成，恢复为「空闲」` }
    case '封闭机位':
      if (from !== '维护中') {
        return { ok: false, message: from === '空闲' || from === '占用中'
          ? transitionRejection(from, '已封闭')
          : '机位已经封闭，不用重复操作' }
      }
      updateStandStatus(stand.id, '已封闭')
      return { ok: true, message: `${stand.机位编号}已封闭，逐级走完「已封闭」` }
    case '解除封闭':
      if (from !== '已封闭') {
        return { ok: false, message: `机位当前为「${from}」，没有需要解除的封闭` }
      }
      updateStandStatus(stand.id, '空闲')
      return { ok: true, message: `${stand.机位编号}已解除封闭，恢复为「空闲」` }
  }
}

function releaseCurrent(stand: StandDoc): ActionResult {
  if (stand.status !== '占用中') {
    return { ok: false, message: `机位当前为「${stand.status}」，没有占用可释放` }
  }
  const minute = currentMinute()
  const date = todayString()
  const active = listOccupancies().find(
    (item) => item.standId === stand.id && item.date === date && item.startMin <= minute && minute < item.endMin,
  )
  if (!active) {
    updateStandStatus(stand.id, '空闲')
    return { ok: true, message: `${stand.机位编号}当前无生效占用，已恢复为「空闲」` }
  }
  const result = removeOccupancy(active.id)
  if (!result.ok) {
    return result
  }
  return { ok: true, message: `已释放 ${stand.机位编号} 上的 ${active.航班号}，机位恢复「空闲」` }
}

/**
 * 删除一条占用（时间轴上释放某一段）：
 * 廊桥已靠上的占用不允许直接释放，必须先走廊桥撤离；待靠接待办随占用一并撤销。
 */
export function removeOccupancy(occupancyId: string): ActionResult {
  const all = listOccupancies()
  const target = all.find((item) => item.id === occupancyId)
  if (!target) {
    return { ok: false, message: '没有找到该占用记录' }
  }
  const jobs = listRows<BridgeJobRow>(BRIDGE_KEY)
  const linked = jobs.filter((job) => job.关联占用 === occupancyId)
  const docked = linked.find((job) => job.status === '已靠桥')
  if (docked) {
    return { ok: false, message: `${target.航班号} 的廊桥 ${docked.廊桥编号} 已靠桥，请先在廊桥靠接里确认撤离，再释放机位` }
  }
  if (linked.some((job) => job.status === '异常中止')) {
    // 已经中止过的作业只留痕，不再拦。
  }
  saveRows(OCC_KEY, all.filter((item) => item.id !== occupancyId))
  // 待靠接待办随占用一起撤销；已撤离的作业保留历史。
  const nextJobs = jobs.filter((job) => !(job.关联占用 === occupancyId && job.status === '待靠接'))
  saveRows(BRIDGE_KEY, nextJobs)
  syncStandAfterOccupancyChange(target.standId, target.date)
  return { ok: true, message: `已释放 ${target.航班号} 在该时段的占用` }
}

function syncStandAfterOccupancyChange(standId: number, date: string): void {
  // 只同步今天的变更：未来排班的增删不影响机位此刻的空闲/占用中状态。
  if (date !== todayString()) {
    return
  }
  const stands = listStands()
  const stand = findStand(stands, standId)
  if (!stand || stand.status === '维护中' || stand.status === '已封闭') {
    return
  }
  const minute = currentMinute()
  const blocks = listOccupancies().filter((item) => item.standId === standId && item.date === date)
  const derived = effectiveStatus(stand, blocks, minute)
  if (derived !== stand.status) {
    updateStandStatus(standId, derived)
  }
}

function updateStandStatus(standId: number, status: StandStatus): boolean {
  const stands = listStands()
  const index = stands.findIndex((stand) => stand.id === standId)
  if (index < 0) {
    return false
  }
  const raw = listRows<EntryRowLike>(STAND_KEY)
  const rawIndex = raw.findIndex((row) => Number(row.id) === standId)
  if (rawIndex < 0) {
    return false
  }
  raw[rawIndex] = { ...raw[rawIndex], status, pending: status !== '已封闭' }
  saveRows(STAND_KEY, raw)
  return true
}

function persistStands(stands: StandDoc[]): void {
  saveRows(STAND_KEY, stands.map((stand) => ({
    id: stand.id,
    status: stand.status,
    pending: stand.pending,
    abnormal: stand.abnormal,
    机位编号: stand.机位编号,
    机位类型: stand.机位类型,
    适用机型: stand.适用机型,
    廊桥配置: stand.廊桥配置,
    近远机位: stand.近远机位,
  })))
}

// ── 廊桥联动 ───────────────────────────────────────────────────────────────

function nextBridgeId(): number {
  const jobs = listRows<BridgeJobRow>(BRIDGE_KEY)
  return jobs.reduce((max, job) => Math.max(max, Number(job.id) || 0), 0) + 1
}

function createBridgeTodo(stand: StandDoc, occupancy: OccupancyDoc): void {
  const jobs = listRows<BridgeJobRow>(BRIDGE_KEY)
  const id = nextBridgeId()
  const job: BridgeJobRow = {
    id,
    status: '待靠接',
    pending: true,
    abnormal: false,
    作业编号: `BRID-${String(id).padStart(4, '0')}`,
    廊桥编号: `JB${stand.机位编号}`,
    对应机位: stand.机位编号,
    航班号: occupancy.航班号,
    关联占用: occupancy.id,
    靠桥时间: `${occupancy.date} ${toHHMM(Math.max(0, occupancy.startMin - 5))}`,
    撤桥时间: `${occupancy.date} ${toHHMM(Math.min(1440, occupancy.endMin + 5))}`,
    操作人员: '—',
    对接检查项: '待检查',
    作业状态: '待靠接',
  }
  saveRows(BRIDGE_KEY, [...jobs, job])
}

function cancelBridgeJobs(occupancies: OccupancyDoc[]): void {
  const ids = new Set(occupancies.map((item) => item.id))
  const jobs = listRows<BridgeJobRow>(BRIDGE_KEY)
  const next = jobs
    // 被挤掉的占用，待靠接的作业直接撤销；已进入靠接的不允许静默删除，中止留痕。
    .filter((job) => !(ids.has(String(job.关联占用)) && job.status === '待靠接'))
    .map((job) =>
      ids.has(String(job.关联占用)) && job.status !== '异常中止'
        ? { ...job, status: '异常中止', pending: false, abnormal: true, 作业状态: '异常中止（机位分配被高优先级航班挤占）' }
        : job,
    )
  saveRows(BRIDGE_KEY, next)
}

// ── 廊桥 ↔ 机位 两处一致性对账 ─────────────────────────────────────────────

/**
 * 校验廊桥待办与机位占用两处对得上：
 * - 廊桥作业的对应机位必须存在；
 * - 关联占用必须存在，且占用的机位与廊桥作业的对应机位一致；
 * - 廊桥机位的每一段占用都必须有一条廊桥作业（含已中止/已撤离历史）。
 */
export function checkBridgeConsistency(): ConsistencyIssue[] {
  const stands = listStands()
  const occupancies = listOccupancies()
  const jobs = listRows<BridgeJobRow>(BRIDGE_KEY)
  const issues: ConsistencyIssue[] = []

  for (const job of jobs) {
    const stand = findStandByCode(stands, String(job.对应机位 ?? ''))
    if (!stand) {
      issues.push({ bridgeJobId: Number(job.id), standCode: String(job.对应机位), message: `廊桥作业 ${job.作业编号} 的对应机位「${job.对应机位}」在机位表中不存在` })
      continue
    }
    const occId = String(job.关联占用 ?? '')
    if (!occId) {
      issues.push({ bridgeJobId: Number(job.id), standCode: stand.机位编号, message: `廊桥作业 ${job.作业编号}（${job.航班号 ?? ''}）没有关联机位占用` })
      continue
    }
    const occupancy = occupancies.find((item) => item.id === occId)
    if (!occupancy) {
      issues.push({ bridgeJobId: Number(job.id), standCode: stand.机位编号, message: `廊桥作业 ${job.作业编号} 关联的占用 ${occId} 已不存在` })
      continue
    }
    if (occupancy.standId !== stand.id) {
      const actual = findStand(stands, occupancy.standId)
      issues.push({ bridgeJobId: Number(job.id), standCode: stand.机位编号, occupancyId: occupancy.id, message: `廊桥作业 ${job.作业编号} 写的机位是 ${stand.机位编号}，关联占用 ${occupancy.航班号} 实际在机位 ${actual?.机位编号 ?? occupancy.standId}` })
    }
  }

  for (const occupancy of occupancies) {
    const stand = findStand(stands, occupancy.standId)
    if (!stand || stand.廊桥配置 !== '有廊桥') {
      continue
    }
    const linked = jobs.find((job) => job.关联占用 === occupancy.id)
    if (!linked) {
      issues.push({ occupancyId: occupancy.id, standCode: stand.机位编号, message: `廊桥机位 ${stand.机位编号} 的占用 ${occupancy.航班号}（${toHHMM(occupancy.startMin)}-${toHHMM(occupancy.endMin)}）在廊桥靠接待办里没有对应作业` })
    }
  }
  return issues
}

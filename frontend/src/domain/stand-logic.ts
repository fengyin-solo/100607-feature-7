import type {
  GuaranteeLevel,
  OccupancyDoc,
  StandDay,
  StandDoc,
  StandStatus,
  TimelineGap,
  TimelineGroup,
} from '@/data/types'

// 机位领域纯逻辑：不碰 localStorage，页面与种子都用同一套算法，
// 保证「时间轴空档」和「机位自身状态」永远从同一份占用数据推出。

export const STAND_STATUS_FLOW: StandStatus[] = ['空闲', '占用中', '维护中', '已封闭']

export const DAY_START = 0
export const DAY_END = 1440

// ── 机型与机位匹配 ─────────────────────────────────────────────────────────

const NARROW_BODY = new Set([
  'A318', 'A319', 'A320', 'A321', 'A220',
  'B733', 'B734', 'B735', 'B736', 'B737', 'B738', 'B739',
  'ARJ21', 'CRJ900', 'E190', 'E195',
])
const WIDE_BODY = new Set([
  'A300', 'A310', 'A330', 'A340', 'A350',
  'B747', 'B757', 'B767', 'B777', 'B787',
])

/** 机型与机位不匹配时返回拒绝原因，匹配返回 null。机位类型与机型不匹配整条拒绝分配。 */
export function mismatchReason(stand: StandDoc, aircraft: string): string | null {
  const model = aircraft.trim().toUpperCase()
  if (!model) {
    return '机型不能为空'
  }
  const whitelist = String(stand.适用机型 ?? '')
    .split(/[/、,，\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)

  if (whitelist.includes('全部') || whitelist.includes(model)) {
    return null
  }
  // 白名单没有明确列出时，按机位类型兜底：窄体位不接待宽体机，宽体位不接待窄体机。
  if (stand.机位类型 === '窄体机位' && WIDE_BODY.has(model)) {
    return `${stand.机位编号}是窄体机位，不能安排宽体机型 ${model}`
  }
  if (stand.机位类型 === '宽体机位' && NARROW_BODY.has(model)) {
    return `${stand.机位编号}是宽体机位，不能安排窄体机型 ${model}`
  }
  if (whitelist.length > 0 && !whitelist.includes(model)) {
    return `${stand.机位编号}适用机型为 ${stand.适用机型}，不含 ${model}`
  }
  return null
}

// ── 时段与优先级 ───────────────────────────────────────────────────────────

export function overlaps(a: Pick<OccupancyDoc, 'startMin' | 'endMin'>, b: Pick<OccupancyDoc, 'startMin' | 'endMin'>): boolean {
  // 端点相接不算抢机位：前一班 10:00 走，后一班 10:00 来可以。
  return a.startMin < b.endMin && b.startMin < a.endMin
}

const LEVEL_RANK: Record<GuaranteeLevel, number> = { 普通: 1, 重要: 2, 要客: 3 }

/**
 * 同一机位时段冲突的让位裁决（由调度规则裁定）：
 * 保障等级高的航班优先（要客 > 重要 > 普通）；同级先到先得。
 * 返回正数表示 challenger 应当让位（守方保留），负数表示 challenger 可以挤攻守方。
 */
export function comparePriority(challenger: OccupancyDoc | { 保障等级: GuaranteeLevel; createdAt: number }, keeper: OccupancyDoc): number {
  const byLevel = LEVEL_RANK[challenger.保障等级] - LEVEL_RANK[keeper.保障等级]
  if (byLevel !== 0) {
    return -byLevel
  }
  // 同级：先到先得，后来者让位
  return challenger.createdAt >= keeper.createdAt ? 1 : -1
}

// ── 空档与时间轴 ───────────────────────────────────────────────────────────

/** 把一天的占用块求并集后，剩下的就是空档；维护中/已封闭机位不产出空档。 */
export function buildGaps(blocks: OccupancyDoc[]): TimelineGap[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin)
  const gaps: TimelineGap[] = []
  let cursor = DAY_START
  for (const block of sorted) {
    if (block.startMin > cursor) {
      gaps.push({ startMin: cursor, endMin: Math.min(block.startMin, DAY_END) })
    }
    cursor = Math.max(cursor, block.endMin)
  }
  if (cursor < DAY_END) {
    gaps.push({ startMin: cursor, endMin: DAY_END })
  }
  return gaps
}

export function activeBlockAt(blocks: OccupancyDoc[], minuteOfDay: number): OccupancyDoc | undefined {
  return blocks.find((block) => block.startMin <= minuteOfDay && minuteOfDay < block.endMin)
}

/**
 * 机位在某一时刻的有效状态，一律从占用数据推导：
 * 维护中/已封闭是机位生命周期状态，不受当天排班影响；
 * 空闲/占用中完全由「这一刻有没有占用块盖着」决定——
 * 图上这一格是空档，点进去就一定是空闲。
 */
export function effectiveStatus(
  stand: StandDoc,
  dayBlocks: OccupancyDoc[],
  minuteOfDay: number,
): StandStatus {
  if (stand.status === '维护中' || stand.status === '已封闭') {
    return stand.status
  }
  return activeBlockAt(dayBlocks, minuteOfDay) ? '占用中' : '空闲'
}

export function buildDay(stand: StandDoc, blocks: OccupancyDoc[], minuteOfDay: number): StandDay {
  const lifeStatus: StandStatus = stand.status
  if (lifeStatus === '维护中' || lifeStatus === '已封闭') {
    // 维护/封闭当天整条不可用：不展示历史块、不产出空档，与机位状态完全一致。
    return { stand, effectiveStatus: lifeStatus, occupancies: [], gaps: [] }
  }
  return {
    stand,
    effectiveStatus: effectiveStatus(stand, blocks, minuteOfDay),
    occupancies: [...blocks].sort((a, b) => a.startMin - b.startMin),
    gaps: buildGaps(blocks),
  }
}

/** 按机位类型 → 廊桥配置两级分组，调度看图时同类型机位排在一起。 */
export function groupDays(days: StandDay[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>()
  for (const day of days) {
    const key = `${day.stand.机位类型}__${day.stand.廊桥配置}`
    let group = groups.get(key)
    if (!group) {
      group = { standType: day.stand.机位类型, bridgeConfig: day.stand.廊桥配置, days: [] }
      groups.set(key, group)
    }
    group.days.push(day)
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      days: group.days.sort((a, b) => String(a.stand.机位编号).localeCompare(String(b.stand.机位编号), 'zh-Hans-CN')),
    }))
    .sort((a, b) =>
      a.standType.localeCompare(b.standType, 'zh-Hans-CN')
      || a.bridgeConfig.localeCompare(b.bridgeConfig, 'zh-Hans-CN'),
    )
}

// ── 状态机 ─────────────────────────────────────────────────────────────────

/**
 * 机位状态沿 空闲 → 占用中 → 维护中 → 已封闭 逐级推进。
 * 正向越级（空闲直封、空闲直送维护、占用直封）一律拒绝；
 * 释放/维护完成/解封属于恢复性操作，复位到空闲，不走越级推进。
 */
export function canTransition(from: StandStatus, to: StandStatus): boolean {
  if (from === to) {
    return false
  }
  const forward = STAND_STATUS_FLOW.indexOf(to) - STAND_STATUS_FLOW.indexOf(from)
  return forward === 1
}

export function transitionRejection(from: StandStatus, to: StandStatus): string {
  const forward = STAND_STATUS_FLOW.indexOf(to) - STAND_STATUS_FLOW.indexOf(from)
  if (forward > 1) {
    return `机位状态越级变更不受理：不能从「${from}」直接改为「${to}」，须逐级走完`
  }
  return `机位当前为「${from}」，不能变更为「${to}」`
}

// ── 时间工具 ───────────────────────────────────────────────────────────────

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function toHHMM(minute: number): string {
  const clamped = Math.max(0, Math.min(DAY_END, minute))
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`
}

export function fromHHMM(text: string): number | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim())
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    return null
  }
  return hour * 60 + minute
}

export function todayString(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function minuteOfNow(date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes()
}

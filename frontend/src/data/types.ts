/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ── 机位分配 / 占用视图 领域模型 ────────────────────────────────────────────

/** 机位生命周期状态，只能沿 空闲 → 占用中 → 维护中 → 已封闭 逐级推进 */
export type StandStatus = '空闲' | '占用中' | '维护中' | '已封闭'

/** 停机位主表：只描述机位自身属性，不再把占用时段塞在这张表里 */
export type StandDoc = {
  id: number
  status: StandStatus
  pending: boolean
  abnormal: boolean
  机位编号: string
  机位类型: '窄体机位' | '宽体机位' | '混合机位' | string
  适用机型: string
  廊桥配置: '有廊桥' | '无廊桥' | string
  近远机位: '近机位' | '远机位' | string
}

/** 保障等级决定同一机位时段冲突时的让位优先级 */
export type GuaranteeLevel = '普通' | '重要' | '要客'

/** 一条机位占用：同一机位同一天同一时段只允许存在一条 */
export type OccupancyDoc = {
  id: string
  standId: number
  /** 占用日期 YYYY-MM-DD */
  date: string
  /** 起始分钟（0-1440） */
  startMin: number
  /** 结束分钟（0-1440） */
  endMin: number
  航班号: string
  机型: string
  保障等级: GuaranteeLevel
  /** 分配先后，用于同优先级时先到先得 */
  createdAt: number
}

export type AllocateInput = {
  standId: number
  date: string
  startMin: number
  endMin: number
  航班号: string
  机型: string
  保障等级: GuaranteeLevel
}

export type AllocateResult = {
  ok: boolean
  message: string
  occupancy?: OccupancyDoc
  /** 被优先级挤掉的原有航班号 */
  displaced?: string[]
}

/** 时间轴空档（视图上能点的空白段，与机位状态同源算出） */
export type TimelineGap = { startMin: number; endMin: number }

/** 一个机位在选定日期的完整铺排：占用块 + 由同一份数据推出的空档 */
export type StandDay = {
  stand: StandDoc
  effectiveStatus: StandStatus
  occupancies: OccupancyDoc[]
  gaps: TimelineGap[]
}

/** 按机位类型 + 廊桥配置分组后的时间轴数据 */
export type TimelineGroup = {
  standType: string
  bridgeConfig: string
  days: StandDay[]
}

export type ConsistencyIssue = {
  bridgeJobId?: number
  occupancyId?: string
  standCode?: string
  message: string
}

/** 廊桥作业行：靠接待办通过「关联占用」与机位占用一一对应 */
export type BridgeJobRow = EntryRow & {
  航班号?: string
  关联占用?: string
}

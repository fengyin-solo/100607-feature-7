import type { EntryRow } from './types'

// 机位占用台账：一个机位一天可以有多段占用，每段对应一趟航班；廊桥作业编号把占用与廊桥待办串起来。
export type StandAllocation = {
  id: number
  status: '生效' | '已让位' | '已释放'
  pending: boolean
  abnormal: boolean
  机位编号: string
  航班号: string
  机型: string
  保障等级: string
  开始时间: string // yyyy-MM-ddTHH:mm
  结束时间: string
  廊桥作业编号: string
  创建时刻: string
  [field: string]: string | number | boolean
}

type SegmentSpec = {
  flight: string
  aircraft: string
  priority: string
  startOffset: number // 相对当前时刻的分钟偏移
  endOffset: number
}

type StandSpec = {
  code: string
  type: string
  accepts: string[]
  bridge: string // 廊桥配置：单廊桥/双廊桥/无廊桥
  bridgeCode: string
  near: string // 近机位/远机位
  segments: SegmentSpec[]
  forcedStatus?: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function relTime(offsetMin: number): { day: string; minute: number; date: Date } {
  const date = new Date(Date.now() + offsetMin * 60_000)
  return {
    day: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    minute: date.getHours() * 60 + date.getMinutes(),
    date,
  }
}

function toISO(day: string, minute: number): string {
  return `${day}T${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`
}

function hm(minute: number): string {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`
}

function dateTimeText(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`
}

// 示例机位与占用都按当前时刻反推：任何一天打开，都有历史段、在停段和未开始段可看。
const STAND_SPECS: StandSpec[] = [
  {
    code: '101',
    type: '窄体机位',
    accepts: ['A320', 'A321', 'B737'],
    bridge: '单廊桥',
    bridgeCode: 'B-101',
    near: '近机位',
    segments: [
      { flight: 'CA1831', aircraft: 'A320', priority: '普通', startOffset: -200, endOffset: -120 },
      { flight: 'CA1858', aircraft: 'A320', priority: '重要', startOffset: -40, endOffset: 50 },
      { flight: 'MU5102', aircraft: 'B737', priority: '普通', startOffset: 180, endOffset: 270 },
    ],
  },
  {
    code: '102',
    type: '窄体机位',
    accepts: ['A320', 'A321', 'B737'],
    bridge: '单廊桥',
    bridgeCode: 'B-102',
    near: '近机位',
    segments: [
      { flight: 'CZ3101', aircraft: 'A320', priority: '普通', startOffset: 90, endOffset: 170 },
      { flight: 'MU5118', aircraft: 'A321', priority: '普通', startOffset: 300, endOffset: 390 },
    ],
  },
  {
    code: '103',
    type: '窄体机位',
    accepts: ['A320', 'B737'],
    bridge: '无廊桥',
    bridgeCode: '',
    near: '远机位',
    segments: [
      { flight: 'HU7801', aircraft: 'B737', priority: '普通', startOffset: -30, endOffset: 60 },
    ],
  },
  {
    code: '201',
    type: '宽体机位',
    accepts: ['A330', 'A350', 'B777'],
    bridge: '双廊桥',
    bridgeCode: 'B-201',
    near: '近机位',
    segments: [
      { flight: 'CK235', aircraft: 'A330', priority: '要客', startOffset: -20, endOffset: 90 },
    ],
  },
  {
    code: '202',
    type: '宽体机位',
    accepts: ['A330', 'B777'],
    bridge: '单廊桥',
    bridgeCode: 'B-202',
    near: '近机位',
    segments: [
      { flight: '3U8881', aircraft: 'B777', priority: '普通', startOffset: 120, endOffset: 240 },
    ],
  },
  {
    code: '401',
    type: '超大型机位',
    accepts: ['A380', 'B747'],
    bridge: '无廊桥',
    bridgeCode: '',
    near: '远机位',
    segments: [
      { flight: 'EK307', aircraft: 'B747', priority: '重要', startOffset: 200, endOffset: 330 },
    ],
  },
  {
    code: '301',
    type: '窄体机位',
    accepts: ['A320', 'B737'],
    bridge: '单廊桥',
    bridgeCode: 'B-301',
    near: '近机位',
    segments: [],
    forcedStatus: '维护中',
  },
  {
    code: '302',
    type: '窄体机位',
    accepts: ['A320', 'B737'],
    bridge: '无廊桥',
    bridgeCode: '',
    near: '远机位',
    segments: [],
    forcedStatus: '已封闭',
  },
]

const TEAMS = ['甲班', '乙班', '丙班']
const OPERATORS = ['张强', '李建国', '王海涛', '赵鹏']
const CHECK_ITEMS = '高度校准；轮挡就位；防滑联锁确认'

export type StandSeedBundle = {
  stand: EntryRow[]
  bridge: EntryRow[]
  flight: EntryRow[]
  allocation: StandAllocation[]
}

// 纯函数构建：不依赖存储层，首次播种和「恢复示例数据」共用一份。
export function buildStandSeed(): StandSeedBundle {
  const stands: EntryRow[] = []
  const bridges: EntryRow[] = []
  const flights: EntryRow[] = []
  const allocations: StandAllocation[] = []

  let standId = 0
  let bridgeId = 0
  let flightId = 0
  let allocId = 0

  STAND_SPECS.forEach((spec, standIndex) => {
    standId += 1
    const validSegments = spec.segments.filter((seg) => {
      const start = relTime(seg.startOffset)
      const end = relTime(seg.endOffset)
      return start.day === end.day
    })

    const activeSeg = validSegments.find((seg) => seg.startOffset <= 0 && seg.endOffset > 0)
    const status = spec.forcedStatus ?? (activeSeg ? '占用中' : '空闲')
    const summary = validSegments
      .map((seg) => {
        const start = relTime(seg.startOffset)
        const end = relTime(seg.endOffset)
        return `${hm(start.minute)}-${hm(end.minute)} ${seg.flight}`
      })
      .join('；')

    stands.push({
      id: standId,
      status,
      pending: status !== '已封闭',
      abnormal: false,
      机位编号: spec.code,
      机位类型: spec.type,
      适用机型: spec.accepts.join(','),
      廊桥配置: spec.bridge,
      廊桥编号: spec.bridgeCode,
      近远机位: spec.near,
      占用时段: summary || '—',
      当前航班: activeSeg ? activeSeg.flight : '—',
      机位状态: status,
    })

    validSegments.forEach((seg, segIndex) => {
      allocId += 1
      flightId += 1
      const start = relTime(seg.startOffset)
      const end = relTime(seg.endOffset)
      const startISO = toISO(start.day, start.minute)
      const endISO = toISO(end.day, end.minute)
      const created = new Date(start.date.getTime() - 45 * 60_000)

      let jobCode = ''
      const needBridge = spec.bridge !== '无廊桥'
      if (needBridge) {
        bridgeId += 1
        jobCode = `BRDG-${pad2(bridgeId)}`
        const jobStatus =
          seg.endOffset <= 0 ? '已撤离' : seg.startOffset <= 0 ? '已靠桥' : '待靠接'
        bridges.push({
          id: bridgeId,
          status: jobStatus,
          pending: jobStatus !== '已撤离',
          abnormal: false,
          作业编号: jobCode,
          航班号: seg.flight,
          廊桥编号: spec.bridgeCode,
          对应机位: spec.code,
          靠桥时间: `${start.day} ${hm(start.minute)}`,
          撤桥时间: jobStatus === '已撤离' ? `${end.day} ${hm(end.minute)}` : '',
          操作人员: OPERATORS[(standIndex + segIndex) % OPERATORS.length],
          对接检查项: CHECK_ITEMS,
          作业状态: jobStatus,
        })
      }

      allocations.push({
        id: allocId,
        status: '生效',
        pending: false,
        abnormal: false,
        机位编号: spec.code,
        航班号: seg.flight,
        机型: seg.aircraft,
        保障等级: seg.priority,
        开始时间: startISO,
        结束时间: endISO,
        廊桥作业编号: jobCode,
        创建时刻: dateTimeText(created).replace(' ', 'T'),
      })

      const flightStatus =
        seg.endOffset <= 0 ? '保障完成' : seg.startOffset <= 0 ? '保障中' : '待接收'
      flights.push({
        id: flightId,
        status: flightStatus,
        pending: flightStatus !== '保障完成',
        abnormal: false,
        保障编号: `FLIG-${pad2(flightId)}`,
        航班号: seg.flight,
        机型: seg.aircraft,
        计划到达: `${start.day} ${hm(start.minute)}`,
        机位号: spec.code,
        保障等级: seg.priority,
        保障班组: TEAMS[segIndex % TEAMS.length],
        保障状态: flightStatus,
      })
    })
  })

  // 封闭机位上还挂着一趟未接收航班，用来演示「机位已封闭拒绝分配」。
  flightId += 1
  flights.push({
    id: flightId,
    status: '待接收',
    pending: true,
    abnormal: false,
    保障编号: `FLIG-${pad2(flightId)}`,
    航班号: '9C8902',
    机型: 'A320',
    计划到达: dateTimeText(relTime(240).date),
    机位号: '302',
    保障等级: '普通',
    保障班组: '乙班',
    保障状态: '待接收',
  })

  return { stand: stands, bridge: bridges, flight: flights, allocation: allocations }
}

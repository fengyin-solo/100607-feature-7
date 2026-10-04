// 机位领域纯逻辑测试（不入交付物，仅开发期校验）
import {
  buildGaps,
  canTransition,
  comparePriority,
  mismatchReason,
  overlaps,
  toHHMM,
  fromHHMM,
  effectiveStatus,
  STAND_STATUS_FLOW,
} from './stand-logic'
import type { OccupancyDoc, StandDoc } from '@/data/types'

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

const stand = (over: Partial<StandDoc> = {}): StandDoc => ({
  id: 1,
  status: '空闲',
  pending: true,
  abnormal: false,
  机位编号: '101',
  机位类型: '窄体机位',
  适用机型: 'A320/A321/B738',
  廊桥配置: '有廊桥',
  近远机位: '近机位',
  ...over,
})

const block = (over: Partial<OccupancyDoc> = {}): OccupancyDoc => ({
  id: 'x',
  standId: 1,
  date: '2026-10-04',
  startMin: 60,
  endMin: 120,
  航班号: 'CA1',
  机型: 'A320',
  保障等级: '普通',
  createdAt: 100,
  ...over,
})

// 机型匹配
assert(mismatchReason(stand(), 'B738') === null, '白名单机型应匹配')
assert(mismatchReason(stand(), 'B777') !== null, '窄体机位应拒绝宽体 B777')
assert(mismatchReason(stand({ 机位类型: '宽体机位', 适用机型: 'B777/B787' }), 'A320') !== null, '宽体机位应拒绝窄体 A320')
assert(mismatchReason(stand({ 适用机型: '全部' }), 'B747') === null, '适用全部机型时宽体也可进（按白名单）')

// 重叠：端点相接不算冲突
assert(overlaps(block({ startMin: 0, endMin: 60 }), block({ startMin: 60, endMin: 120 })) === false, '首尾相接不算重叠')
assert(overlaps(block({ startMin: 0, endMin: 61 }), block({ startMin: 60, endMin: 120 })) === true, '相交一分钟算重叠')

// 仲裁：等级高者赢
const keeper = block({ 保障等级: '普通', createdAt: 100 })
assert(comparePriority(block({ 保障等级: '要客', createdAt: 200 }), keeper) < 0, '要客应挤掉普通')
assert(comparePriority(block({ 保障等级: '普通', createdAt: 200 }), block({ 保障等级: '普通', createdAt: 100 })) > 0, '同级后来者让位')
assert(comparePriority(block({ 保障等级: '普通', createdAt: 50 }), block({ 保障等级: '普通', createdAt: 100 })) < 0, '同级先到者优先')

// 空档
const gaps = buildGaps([
  block({ startMin: 120, endMin: 180 }),
  block({ startMin: 60, endMin: 130 }), // 与上一条并集 60-180
  block({ startMin: 1000, endMin: 1080 }),
])
assert(JSON.stringify(gaps) === JSON.stringify([{ startMin: 0, endMin: 60 }, { startMin: 180, endMin: 1000 }, { startMin: 1080, endMin: 1440 }]), '空档应为占用并集之外的部分')

// 时间格式
assert(toHHMM(90) === '01:30' && toHHMM(0) === '00:00' && toHHMM(1440) === '24:00', '分钟转 HH:MM')
assert(fromHHMM('8:05') === 485, 'HH:MM 转分钟')
assert(fromHHMM('24:30') === null, '非法时间应拒绝')

// 状态同源
assert(effectiveStatus(stand({ status: '空闲' }), [block({ startMin: 0, endMin: 100 })], 60) === '占用中', '占用块盖住当前时刻应为占用中')
assert(effectiveStatus(stand({ status: '空闲' }), [block({ startMin: 0, endMin: 60 })], 60) === '空闲', '占用块刚结束应为空闲')
assert(effectiveStatus(stand({ status: '维护中' }), [block()], 90) === '维护中', '维护中不受占用影响')

// 状态机：逐级
const [idle, busy, maint, closed] = STAND_STATUS_FLOW
assert(canTransition(idle, busy), '空闲→占用中 允许')
assert(canTransition(busy, maint), '占用中→维护中 允许')
assert(canTransition(maint, closed), '维护中→已封闭 允许')
assert(!canTransition(idle, maint), '空闲→维护中 越级拒绝')
assert(!canTransition(idle, closed), '空闲→已封闭 越级拒绝')
assert(!canTransition(busy, closed), '占用中→已封闭 越级拒绝')
assert(!canTransition(idle, idle), '同级不算流转')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}

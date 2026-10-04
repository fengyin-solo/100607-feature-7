<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">
          机位主表只登记机位属性；占用视图按机位类型、廊桥配置分组，把每个机位当天占用铺成时间轴，空档与机位状态同源计算。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出机位清单</button>
      </div>
    </header>

    <div class="tab-bar">
      <button class="tab" :class="{ active: tab === 'timeline' }" type="button" @click="switchTab('timeline')">占用视图</button>
      <button class="tab" :class="{ active: tab === 'table' }" type="button" @click="switchTab('table')">机位清单</button>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="consistencyIssues.length" class="consistency-banner">
      廊桥对账发现 {{ consistencyIssues.length }} 处对不上的记录，请前往廊桥靠接核对：
      {{ consistencyIssues[0].message }}
    </p>

    <!-- ================= 占用视图 ================= -->
    <div v-if="tab === 'timeline'">
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>查看日期</span>
          <input v-model="viewDate" type="date" />
        </label>
        <button class="btn" type="submit">刷新时间轴</button>
        <button class="btn ghost" type="button" @click="goToday">回到今天</button>
      </form>

      <p class="status-legend">
        <span class="legend-item lvl-normal">普通航班</span>
        <span class="legend-item lvl-important">重要保障</span>
        <span class="legend-item lvl-vip">要客保障</span>
        <span class="legend-item legend-gap">空白＝可分配空档（点击直接排）</span>
        <span class="legend-item legend-blocked">斜线＝维护中 / 已封闭</span>
        <span v-if="isToday" class="legend-item legend-now">红竖线＝当前时刻</span>
      </p>

      <div class="selection-bar" v-if="selection">
        <template v-if="selection.kind === 'block'">
          <strong>{{ selection.block.航班号 }}</strong>
          <span>{{ standCode(selection.block.standId) }} · {{ selection.block.机型 }} · {{ selection.block.保障等级 }}保障</span>
          <span>{{ toHHMM(selection.block.startMin) }} – {{ toHHMM(selection.block.endMin) }}</span>
          <span v-if="bridgeState(selection.block.id)" class="bridge-state">{{ bridgeState(selection.block.id) }}</span>
          <button class="btn" type="button" @click="releaseBlock(selection.block)">释放该占用</button>
          <button class="btn ghost" type="button" @click="selection = null">关闭</button>
        </template>
        <template v-else>
          <strong>{{ standCode(selection.gap.standId) }}</strong>
          <span>空档 {{ toHHMM(selection.gap.startMin) }} – {{ toHHMM(selection.gap.endMin) }}（共 {{ durationText(selection.gap) }}）</span>
          <span>机位状态：空闲</span>
          <button class="btn primary" type="button" @click="allocateAtGap(selection.gap)">在该空档分配机位</button>
          <button class="btn ghost" type="button" @click="selection = null">关闭</button>
        </template>
      </div>
      <p v-if="errorMessage" class="page-foot"><span class="error-text">{{ errorMessage }}</span></p>
      <p v-else-if="flashMessage" class="page-foot"><span class="ok-text">{{ flashMessage }}</span></p>

      <div class="timeline-board">
        <section v-for="group in groups" :key="group.standType + group.bridgeConfig" class="tl-group">
          <header class="tl-group-head">
            <span class="group-tag">{{ group.standType }}</span>
            <span class="group-tag muted">{{ group.bridgeConfig }}</span>
            <span class="group-count">{{ group.days.length }} 个机位</span>
          </header>

          <div class="tl-hours">
            <span class="tl-row-label"></span>
            <div class="tl-track hours-track">
              <span v-for="hour in hours" :key="hour" class="hour-mark">{{ String(hour).padStart(2, '0') }}:00</span>
            </div>
          </div>

          <div v-for="day in group.days" :key="day.stand.id" class="tl-row" :class="['st-' + day.effectiveStatus]">
            <div class="tl-row-label">
              <strong>{{ day.stand.机位编号 }}</strong>
              <span class="stand-type">{{ day.stand.机位类型 }} · {{ day.stand.近远机位 }}</span>
              <span class="stand-state" :class="'state-' + day.effectiveStatus">{{ day.effectiveStatus }}</span>
            </div>

            <div class="tl-track">
              <!-- 网格竖线 -->
              <span v-for="hour in 24" :key="'g' + hour" class="grid-line" :style="{ left: ((hour / 24) * 100) + '%' }"></span>

              <!-- 维护/封闭：整条不可用，不出空档 -->
              <div v-if="day.effectiveStatus === '维护中' || day.effectiveStatus === '已封闭'" class="full-band">
                {{ day.effectiveStatus }}，当天不接受分配
              </div>

              <template v-else>
                <!-- 空档：可点击直接分配，与机位状态同源 -->
                <button
                  v-for="(gap, index) in day.gaps"
                  :key="'gap' + index"
                  class="gap-band"
                  type="button"
                  :class="{ selected: selection?.kind === 'gap' && selection.gap.standId === day.stand.id && selection.gap.startMin === gap.startMin }"
                  :style="gapStyle(gap)"
                  :title="`空档 ${toHHMM(gap.startMin)}–${toHHMM(gap.endMin)}，点击分配机位`"
                  @click="pickGap(day.stand.id, gap)"
                >{{ gap.endMin - gap.startMin >= 100 ? '空闲' : '' }}</button>

                <!-- 占用块 -->
                <button
                  v-for="block in day.occupancies"
                  :key="block.id"
                  class="occ-block"
                  type="button"
                  :class="['lvl-' + levelClass(block.保障等级), { selected: selection?.kind === 'block' && selection.block.id === block.id }]"
                  :style="blockStyle(block)"
                  :title="`${block.航班号} ${block.机型} ${block.保障等级}｜${toHHMM(block.startMin)}–${toHHMM(block.endMin)}`"
                  @click="pickBlock(block)"
                >
                  <span class="occ-flight">{{ block.航班号 }}</span>
                  <span class="occ-time">{{ toHHMM(block.startMin) }}–{{ toHHMM(block.endMin) }}</span>
                </button>

                <span v-if="isToday" class="now-line" :style="{ left: nowPercent + '%' }"></span>
              </template>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- ================= 机位清单 ================= -->
    <div v-else>
      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in effectiveRows" :key="String(row.id)">
            <td>{{ row.机位编号 }}</td>
            <td>{{ row.机位类型 }}</td>
            <td>{{ row.适用机型 }}</td>
            <td>{{ row.廊桥配置 }}</td>
            <td>{{ row.近远机位 }}</td>
            <td><span class="stand-state" :class="'state-' + row.effectiveStatus">{{ row.effectiveStatus }}</span></td>
            <td class="row-actions">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runStandAction(action, row)"
              >{{ action }}</button>
            </td>
          </tr>
          <tr v-if="!effectiveRows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无机位数据</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ effectiveRows.length }} 个停机位 · 状态沿 空闲 → 占用中 → 维护中 → 已封闭 逐级流转，越级变更不受理</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
        <span v-else-if="flashMessage" class="ok-text">{{ flashMessage }}</span>
      </footer>
    </div>

    <!-- ================= 分配弹窗 ================= -->
    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <header class="modal-head">
          <h3>分配机位 · {{ dialog.standCode }}</h3>
          <button class="btn ghost" type="button" @click="closeDialog">×</button>
        </header>
        <div class="modal-tip">
          该机位适用机型：{{ dialog.standModels }}｜{{ dialog.bridgeConfig }}。
          机型与机位类型不匹配将整条拒绝；同时段冲突时要客＞重要＞普通，同级先到先得。
        </div>
        <form class="modal-form" @submit.prevent="confirmAllocate">
          <label class="form-item">
            <span>航班号</span>
            <input v-model="dialog.flight" placeholder="如 CA1831" required />
          </label>
          <label class="form-item">
            <span>机型</span>
            <input v-model="dialog.model" list="model-options" placeholder="如 A320 / B777" required />
            <datalist id="model-options">
              <option v-for="model in modelCatalog" :key="model" :value="model"></option>
            </datalist>
          </label>
          <label class="form-item">
            <span>保障等级</span>
            <select v-model="dialog.level">
              <option value="普通">普通</option>
              <option value="重要">重要</option>
              <option value="要客">要客</option>
            </select>
          </label>
          <label class="form-item">
            <span>占用日期</span>
            <input v-model="dialog.date" type="date" required />
          </label>
          <div class="form-row">
            <label class="form-item">
              <span>开始时间</span>
              <input v-model="dialog.startText" placeholder="08:30" required />
            </label>
            <label class="form-item">
              <span>结束时间</span>
              <input v-model="dialog.endText" placeholder="09:40" required />
            </label>
          </div>
          <p v-if="dialog.error" class="error-text">{{ dialog.error }}</p>
          <footer class="modal-foot">
            <button class="btn ghost" type="button" @click="closeDialog">取消</button>
            <button class="btn primary" type="submit">确认分配</button>
          </footer>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  allocateStand,
  buildTimeline,
  checkBridgeConsistency,
  performStandAction,
  reconcileStands,
  removeOccupancy,
} from '@/domain/stand-service'
import { fromHHMM, minuteOfNow, toHHMM, todayString } from '@/domain/stand-logic'
import type {
  AllocateResult,
  BridgeJobRow,
  GuaranteeLevel,
  OccupancyDoc,
  StandDay,
  StandDoc,
  TimelineGap,
  TimelineGroup,
} from '@/data/types'
import { listRows } from '@/data/local-store'

const meta = moduleMeta('stand')
const columns = ['机位编号', '机位类型', '适用机型', '廊桥配置', '近远机位']
const filterFields = columns.slice(0, 3)

const tab = ref<'timeline' | 'table'>('timeline')
const viewDate = ref(todayString())
const groups = ref<TimelineGroup[]>([])
const errorMessage = ref('')
const flashMessage = ref('')
const filters = ref<Record<string, string>>({})
const bridgeJobs = ref<BridgeJobRow[]>([])
const consistencyIssues = ref(checkBridgeConsistency())

const hours = Array.from({ length: 12 }, (_, index) => index * 2)

type Selection =
  | { kind: 'block'; block: OccupancyDoc }
  | { kind: 'gap'; gap: TimelineGap & { standId: number } }
const selection = ref<Selection | null>(null)

const dialog = ref({
  open: false,
  standId: 0,
  standCode: '',
  standModels: '',
  bridgeConfig: '',
  date: viewDate.value,
  flight: '',
  model: '',
  level: '普通' as GuaranteeLevel,
  startText: '',
  endText: '',
  error: '',
})

const modelCatalog = [
  'A319', 'A320', 'A321', 'A330', 'A350',
  'B737', 'B738', 'B739', 'B767', 'B777', 'B787',
  'ARJ21', 'E190',
]

const isToday = computed(() => viewDate.value === todayString())
const nowPercent = computed(() => (minuteOfNow() / 1440) * 100)

const statusSummary = computed(() => {
  const all = groups.value.flatMap((group) => group.days)
  return ['空闲', '占用中', '维护中', '已封闭'].map((status) => ({
    status,
    count: all.filter((day) => day.effectiveStatus === status).length,
  }))
})

const stats = computed(() => {
  const count = (status: string) =>
    groups.value.reduce(
      (sum, group) => sum + group.days.filter((day) => day.effectiveStatus === status).length,
      0,
    )
  return [
    { label: '可用机位', value: count('空闲') },
    { label: '占用中机位', value: count('占用中') },
    { label: '维护中机位', value: count('维护中') },
    { label: '封闭机位', value: count('已封闭') },
  ]
})

type TableRow = StandDoc & { effectiveStatus: StandDoc['status'] }
const effectiveRows = ref<TableRow[]>([])

function durationText(gap: TimelineGap): string {
  const minutes = gap.endMin - gap.startMin
  const hour = Math.floor(minutes / 60)
  const min = minutes % 60
  return min === 0 ? `${hour}小时` : `${hour}小时${min}分`
}

function levelClass(level: GuaranteeLevel): string {
  return level === '要客' ? 'vip' : level === '重要' ? 'important' : 'normal'
}

function blockStyle(block: OccupancyDoc) {
  return {
    left: `${(block.startMin / 1440) * 100}%`,
    width: `${((block.endMin - block.startMin) / 1440) * 100}%`,
  }
}

function gapStyle(gap: TimelineGap) {
  return {
    left: `${(gap.startMin / 1440) * 100}%`,
    width: `${((gap.endMin - gap.startMin) / 1440) * 100}%`,
  }
}

function standCode(standId: number): string {
  for (const group of groups.value) {
    const found = group.days.find((day) => day.stand.id === standId)
    if (found) {
      return found.stand.机位编号
    }
  }
  const stands = reconcileStands()
  return stands.find((stand) => stand.id === standId)?.机位编号 ?? String(standId)
}

function bridgeState(occupancyId: string): string {
  const job = bridgeJobs.value.find((item) => item.关联占用 === occupancyId)
  return job ? `廊桥 ${job.廊桥编号}：${job.status}` : ''
}

function pickBlock(block: OccupancyDoc) {
  selection.value = { kind: 'block', block }
}

function pickGap(standId: number, gap: TimelineGap) {
  selection.value = { kind: 'gap', gap: { ...gap, standId } }
}

function allocateAtGap(gap: TimelineGap & { standId: number }) {
  openDialog(gap.standId, gap.startMin, gap.endMin)
}

function openDialog(standId: number, startMin?: number, endMin?: number) {
  const stands = reconcileStands()
  const stand = stands.find((item) => item.id === standId)
  if (!stand) {
    return
  }
  let start = startMin
  let end = endMin
  if (start === undefined) {
    start = isToday.value ? Math.min(1380, minuteOfNow() + 5) : 0
    end = Math.min(1440, start + 60)
  }
  dialog.value = {
    open: true,
    standId,
    standCode: stand.机位编号,
    standModels: stand.适用机型,
    bridgeConfig: stand.廊桥配置,
    date: viewDate.value,
    flight: '',
    model: '',
    level: '普通',
    startText: toHHMM(start ?? 0),
    endText: toHHMM(end ?? 60),
    error: '',
  }
}

function closeDialog() {
  dialog.value.open = false
}

function confirmAllocate() {
  const startMin = fromHHMM(dialog.value.startText)
  const endMin = fromHHMM(dialog.value.endText)
  if (startMin === null || endMin === null) {
    dialog.value.error = '时间格式应为 HH:MM，例如 08:30'
    return
  }
  const result: AllocateResult = allocateStand({
    standId: dialog.value.standId,
    date: dialog.value.date,
    startMin,
    endMin,
    航班号: dialog.value.flight,
    机型: dialog.value.model,
    保障等级: dialog.value.level,
  })
  if (!result.ok) {
    dialog.value.error = result.message
    return
  }
  dialog.value.open = false
  selection.value = null
  flash(result.message)
  reload()
}

function releaseBlock(block: OccupancyDoc) {
  const result = removeOccupancy(block.id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  selection.value = null
  flash(result.message)
  reload()
}

function actionsFor(row: TableRow): string[] {
  switch (row.effectiveStatus) {
    case '空闲':
      return ['分配机位']
    case '占用中':
      return ['释放机位', '送维护']
    case '维护中':
      return ['维护完成', '封闭机位']
    case '已封闭':
      return ['解除封闭']
    default:
      return []
  }
}

function runStandAction(action: string, row: TableRow) {
  errorMessage.value = ''
  if (action === '分配机位') {
    openDialog(row.id)
    return
  }
  const result = performStandAction(row.id, action as '释放机位' | '送维护' | '维护完成' | '封闭机位' | '解除封闭')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  flash(result.message)
  reload()
}

function flash(message: string) {
  flashMessage.value = message
  window.setTimeout(() => {
    if (flashMessage.value === message) {
      flashMessage.value = ''
    }
  }, 6000)
}

function goToday() {
  viewDate.value = todayString()
  reload()
}

function switchTab(target: 'timeline' | 'table') {
  tab.value = target
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  groups.value = buildTimeline(viewDate.value)
  bridgeJobs.value = listRows<BridgeJobRow>('bridge')
  consistencyIssues.value = checkBridgeConsistency()
  if (tab.value === 'table') {
    const payload = listEntries(meta.key, filters.value)
    const statusMap = new Map(
      groups.value.flatMap((group) => group.days).map((day: StandDay) => [day.stand.id, day.effectiveStatus]),
    )
    effectiveRows.value = (payload.items as unknown as StandDoc[]).map((row) => ({
      ...row,
      effectiveStatus: statusMap.get(row.id) ?? row.status,
    }))
  }
}

onMounted(reload)
</script>

<style scoped>
.tab-bar { display: flex; gap: 4px; margin-bottom: 12px; }
.tab { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 6px 16px; cursor: pointer; font-size: 13px; }
.tab.active { background: var(--brand); border-color: var(--brand); color: #fff; }

.legend-item.lvl-normal { background: #dbeafe; color: #1e40af; }
.legend-item.lvl-important { background: #fef3c7; color: #92400e; }
.legend-item.lvl-vip { background: #fee2e2; color: #991b1b; }
.legend-gap { background: #ecfdf5; color: #065f46; }
.legend-blocked { background: #f1f5f9; color: #475569; }
.legend-now { background: #fff1f2; color: #be123c; }

.ok-text { color: #047857; }
.consistency-banner { margin: 0 0 10px; padding: 8px 12px; border-radius: 6px; background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; font-size: 12px; }

.selection-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; background: #fff; border: 1px solid var(--border); border-left: 3px solid var(--brand); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; }
.bridge-state { color: var(--brand); }

.timeline-board { display: flex; flex-direction: column; gap: 14px; }
.tl-group { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.tl-group-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.group-tag { background: var(--brand); color: #fff; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.group-tag.muted { background: #475569; }
.group-count { color: var(--muted); font-size: 12px; }

.tl-hours { display: flex; align-items: center; margin-bottom: 2px; }
.tl-row { display: flex; align-items: stretch; padding: 3px 0; }
.tl-row-label { width: 150px; flex-shrink: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; padding-right: 10px; }
.tl-row-label strong { font-size: 13px; }
.stand-type { font-size: 11px; color: var(--muted); }
.stand-state { font-size: 11px; border-radius: 999px; padding: 0 8px; width: fit-content; }
.state-空闲 { background: #dcfce7; color: #166534; }
.state-占用中 { background: #dbeafe; color: #1e40af; }
.state-维护中 { background: #fef9c3; color: #854d0e; }
.state-已封闭 { background: #f1f5f9; color: #475569; }

.tl-track { position: relative; flex: 1; height: 38px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; }
.hours-track { height: 20px; border: none; background: transparent; }
.hour-mark { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); top: 2px; }
.hour-mark:first-child { transform: none; }

.grid-line { position: absolute; top: 0; bottom: 0; width: 1px; background: #eef2f7; }

.gap-band { position: absolute; top: 2px; bottom: 2px; border: 1px dashed transparent; background: transparent; border-radius: 3px; cursor: pointer; font-size: 10px; color: #94a3b8; }
.gap-band:hover, .gap-band.selected { border-color: #10b981; background: rgba(16, 185, 129, 0.12); color: #047857; }

.occ-block { position: absolute; top: 2px; bottom: 2px; border: none; border-radius: 3px; padding: 1px 6px; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; cursor: pointer; overflow: hidden; color: #fff; text-align: left; }
.occ-block.lvl-normal { background: #3b82f6; }
.occ-block.lvl-important { background: #f59e0b; }
.occ-block.lvl-vip { background: #ef4444; }
.occ-block.selected { outline: 2px solid #0f172a; outline-offset: 1px; z-index: 2; }
.occ-flight { font-size: 12px; font-weight: 600; line-height: 1.2; white-space: nowrap; }
.occ-time { font-size: 10px; opacity: 0.9; white-space: nowrap; }

.full-band { position: absolute; inset: 2px; border-radius: 3px; background: repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 8px, #f1f5f9 8px, #f1f5f9 16px); display: flex; align-items: center; justify-content: center; font-size: 12px; color: #64748b; }

.now-line { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #e11d48; z-index: 3; pointer-events: none; }

.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 8px; width: 460px; max-width: calc(100vw - 32px); }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.modal-head h3 { margin: 0; font-size: 15px; }
.modal-tip { padding: 10px 16px; font-size: 12px; color: #92400e; background: #fffbeb; border-bottom: 1px solid #fde68a; }
.modal-form { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.form-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); flex: 1; }
.form-item input, .form-item select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: #1f2937; }
.form-row { display: flex; gap: 10px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>

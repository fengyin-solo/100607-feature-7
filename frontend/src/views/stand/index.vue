<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">
          占用视图按机位类型、廊桥配置分组，当天每段占用铺在时间轴上，空档与机位状态同源于占用台账；
          状态沿 空闲→占用中→维护中→已封闭 逐级流转，越级变更拒绝受理。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openAllocate()">分配机位</button>
        <button class="btn" type="button" @click="resetDemo">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
      <label class="day-picker">
        <span>日期</span>
        <input v-model="day" type="date" />
      </label>
      <span class="now-hint">当前时刻 {{ nowText }}，红竖线为「现在」</span>
    </div>

    <div v-if="activeTab === 'timeline'" class="timeline-panel">
      <p class="timeline-legend">
        <span class="legend-seg vip">要客（未开始）</span>
        <span class="legend-seg key">重要（未开始）</span>
        <span class="legend-seg normal">普通（未开始）</span>
        <span class="legend-seg active-now">在停中</span>
        <span class="legend-seg done">已结束</span>
        <span class="legend-gap">空档（点击可分配）</span>
        <span class="legend-off">维护/封闭整日不可用</span>
      </p>

      <div v-for="group in groups" :key="`${group.standType}-${group.bridge}`" class="timeline-group">
        <h3 class="group-title">
          {{ group.standType + ' · ' + group.bridge }}
          <small>（{{ group.rows.length }} 个机位）</small>
        </h3>
        <div class="timeline-scroll">
          <div class="axis-row">
            <div class="stand-cell axis-head">机位</div>
            <div class="axis-track">
              <span v-for="hour in hours" :key="hour" class="axis-tick" :style="{ left: `${(hour / 24) * 100}%` }">
                {{ hour }}:00
              </span>
            </div>
          </div>

          <div v-for="row in group.rows" :key="row.stand.id" class="tl-row" :class="`st-${statusClass(row.stand.status)}`">
            <div class="stand-cell">
              <button class="stand-name" type="button" @click="openLedger(row.stand)">{{ row.stand['机位编号'] }}</button>
              <span class="stand-meta">{{ row.stand['近远机位'] }} · {{ row.stand.status }}</span>
              <span class="stand-meta">适用 {{ row.stand['适用机型'] }}</span>
            </div>
            <div class="tl-track">
              <div v-for="hour in 12" :key="hour" class="grid-line" :style="{ left: `${(hour / 12) * 50}%` }"></div>
              <template v-if="row.stand.status === '维护中' || row.stand.status === '已封闭'">
                <div class="off-band">{{ row.stand.status }}，整日不可分配</div>
              </template>
              <template v-else>
                <button
                  v-for="gap in row.gaps"
                  :key="'g-' + gap.startMin + '-' + gap.endMin"
                  class="gap-band"
                  type="button"
                  :style="gapStyle(gap)"
                  :title="'空档 ' + hm(gap.startMin) + '-' + hm(gap.endMin) + '，点击分配'"
                  @click="openAllocate(String(row.stand['机位编号']), day, gap)"
                ></button>
                <button
                  v-for="seg in row.active"
                  :key="seg.id"
                  class="occ-seg"
                  :class="segClass(seg)"
                  type="button"
                  :style="segStyle(seg)"
                  :title="segTitle(seg)"
                  @click="selectedSeg = seg"
                >
                  <span class="occ-flight">{{ seg['航班号'] }}</span>
                </button>
                <div v-if="isToday" class="now-line" :style="nowStyle"></div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!groups.length" class="empty-block">当日没有机位数据</p>
    </div>

    <div v-else>
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
          <tr v-for="row in tableRows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td><span class="status-pill" :class="`st-${statusClass(row.status)}`">{{ row.status }}</span></td>
            <td class="row-actions">
              <button
                v-for="action in actionsFor(row)"
                :key="action.name"
                class="link"
                type="button"
                @click="runStatusAction(action.name, row)"
              >
                {{ action.label }}
              </button>
              <button class="link" type="button" @click="openLedger(row)">占用台账</button>
            </td>
          </tr>
          <tr v-if="!tableRows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无机位数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>
        共 {{ tableRows.length }} 个机位；占用台账由分配/释放统一维护，视图空档数与机位状态实时一致
      </span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 分配对话框 -->
    <div v-if="allocOpen" class="modal-mask" @click.self="allocOpen = false">
      <div class="modal">
        <h3 class="modal-title">分配机位</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>机位编号</span>
            <select v-model="allocForm.standCode">
              <option v-for="stand in allocatableStands" :key="stand.id" :value="stand['机位编号']">
                {{ stand['机位编号'] }}（{{ stand['机位类型'] }}·{{ stand['廊桥配置'] }}·{{ stand.status }}）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>航班号</span>
            <input v-model="allocForm.flight" list="flight-options" placeholder="如 CA1858" />
            <datalist id="flight-options">
              <option v-for="flight in flightOptions" :key="flight" :value="flight"></option>
            </datalist>
          </label>
          <label class="form-item">
            <span>机型</span>
            <input v-model="allocForm.aircraft" list="aircraft-options" placeholder="如 A320" />
            <datalist id="aircraft-options">
              <option v-for="aircraft in aircraftOptions" :key="aircraft" :value="aircraft"></option>
            </datalist>
          </label>
          <label class="form-item">
            <span>保障等级（冲突让位优先级：要客→重要→普通，同级先到先得）</span>
            <select v-model="allocForm.priority">
              <option>要客</option>
              <option>重要</option>
              <option>普通</option>
            </select>
          </label>
          <label class="form-item">
            <span>开始时间</span>
            <input v-model="allocForm.startISO" type="datetime-local" />
          </label>
          <label class="form-item">
            <span>结束时间</span>
            <input v-model="allocForm.endISO" type="datetime-local" />
          </label>
        </div>
        <p class="rule-hint">
          机型不在机位适用范围内整条拒绝；同一时段同一机位仅保留一条生效占用，重复提交按幂等处理。
        </p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="allocOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitAllocate">提交分配</button>
        </div>
      </div>
    </div>

    <!-- 占用段详情 -->
    <div v-if="selectedSeg" class="modal-mask" @click.self="selectedSeg = null">
      <div class="modal">
        <h3 class="modal-title">占用详情 · {{ selectedSeg['航班号'] }}</h3>
        <dl class="detail-list">
          <div><dt>机位</dt><dd>{{ selectedSeg['机位编号'] }}</dd></div>
          <div><dt>机型</dt><dd>{{ selectedSeg['机型'] }}</dd></div>
          <div><dt>保障等级</dt><dd>{{ selectedSeg['保障等级'] }}</dd></div>
          <div><dt>占用时段</dt><dd>{{ fmtDT(selectedSeg['开始时间']) }} — {{ fmtDT(selectedSeg['结束时间']) }}</dd></div>
          <div><dt>廊桥作业</dt><dd>{{ selectedSeg['廊桥作业编号'] || '无廊桥配置' }}</dd></div>
          <div><dt>台账状态</dt><dd>{{ selectedSeg.status }}</dd></div>
        </dl>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="selectedSeg = null">关闭</button>
          <button v-if="selectedSeg.status === '生效'" class="btn primary" type="button" @click="releaseSeg">释放该占用</button>
        </div>
      </div>
    </div>

    <!-- 机位占用台账 -->
    <div v-if="ledgerStand" class="modal-mask" @click.self="ledgerStand = null">
      <div class="modal modal-wide">
        <h3 class="modal-title">机位 {{ ledgerStand['机位编号'] }} · 占用台账</h3>
        <table class="data-table">
          <thead>
            <tr><th>台账编号</th><th>航班号</th><th>机型</th><th>保障等级</th><th>占用时段</th><th>廊桥作业</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in ledgerRows" :key="item.id">
              <td>{{ item.id }}</td>
              <td>{{ item['航班号'] }}</td>
              <td>{{ item['机型'] }}</td>
              <td>{{ item['保障等级'] }}</td>
              <td>{{ fmtDT(item['开始时间']) }} — {{ fmtDT(item['结束时间']) }}</td>
              <td>{{ item['廊桥作业编号'] || '无' }}</td>
              <td>{{ item.status }}</td>
              <td>
                <button v-if="item.status === '生效'" class="link" type="button" @click="releaseLedger(item.id)">释放</button>
                <span v-else>—</span>
              </td>
            </tr>
            <tr v-if="!ledgerRows.length">
              <td colspan="8" class="empty-state">该机位还没有占用记录</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="ledgerStand = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { StandAllocation } from '@/data/stand-seed'
import type { TimelineAllocation, TimelineGap } from '@/domain/stand'
import {
  allocateStand,
  buildTimeline,
  changeStandStatus,
  listAllocations,
  releaseAllocation,
  resetStandDemo,
  hm as formatHM,
} from '@/domain/stand'

const columns = ["机位编号", "机位类型", "适用机型", "廊桥配置", "近远机位", "占用时段", "当前航班", "机位状态"]
const filterFields = ["机位编号", "机位类型", "廊桥配置"]
const hours = Array.from({ length: 24 }, (_, index) => index + 1)

const tabs = [
  { key: 'timeline', label: '占用视图' },
  { key: 'list', label: '机位清单' },
] as const
const activeTab = ref<(typeof tabs)[number]['key']>('timeline')

function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const day = ref(today())
const groups = ref(buildTimeline(day.value).groups)
const stands = ref<EntryRow[]>(buildTimeline(day.value).stands)
const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
const nowText = formatHM(nowMin)
const isToday = computed(() => day.value === today())

const filters = ref<Record<string, string>>({})
const tableRows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(false)

const stats = computed(() => {
  const list = stands.value
  return [
    { label: '可用机位（空闲）', value: list.filter((row) => row.status === '空闲').length },
    { label: '占用中机位', value: list.filter((row) => row.status === '占用中').length },
    { label: '维护中机位', value: list.filter((row) => row.status === '维护中').length },
    { label: '已封闭机位', value: list.filter((row) => row.status === '已封闭').length },
    { label: '今日生效占用', value: listAllocations().filter((row) => row.status === '生效' && String(row['开始时间']).startsWith(day.value)).length },
    { label: '待靠接廊桥作业', value: countPendingBridge() },
  ]
})

function countPendingBridge(): number {
  return listEntries('bridge').items.filter((row) => row.status === '待靠接').length
}

function hm(minute: number): string {
  return formatHM(minute)
}

function fmtDT(iso: string | number): string {
  return String(iso).replace('T', ' ')
}

function statusClass(status: string): string {
  if (status === '空闲') return 'idle'
  if (status === '占用中') return 'busy'
  if (status === '维护中') return 'maint'
  return 'closed'
}

function segClass(seg: TimelineAllocation): string {
  const now = new Date()
  const start = new Date(seg['开始时间']).getTime()
  const end = new Date(seg['结束时间']).getTime()
  if (end <= now.getTime()) return 'done'
  if (start <= now.getTime()) return 'active'
  return 'pri-' + seg['保障等级']
}

function gapStyle(gap: TimelineGap): Record<string, string> {
  return {
    left: (gap.startMin / 1440) * 100 + '%',
    width: ((gap.endMin - gap.startMin) / 1440) * 100 + '%',
  }
}

function segStyle(seg: TimelineAllocation): Record<string, string> {
  return {
    left: (seg.startMin / 1440) * 100 + '%',
    width: ((seg.endMin - seg.startMin) / 1440) * 100 + '%',
  }
}

function segTitle(seg: TimelineAllocation): string {
  return seg['航班号'] + '（' + seg['机型'] + '，' + seg['保障等级'] + '）' + hm(seg.startMin) + '-' + hm(seg.endMin)
}

const nowStyle = computed<Record<string, string>>(() => ({ left: (nowMin / 1440) * 100 + '%' }))

// 每个状态只暴露相邻一级的动作，越级按钮不出现；即便绕过页面，服务端仍会再拒一次。
function actionsFor(row: EntryRow): { name: string; label: string }[] {
  switch (row.status) {
    case '空闲':
      return []
    case '占用中':
      return [
        { name: '释放机位', label: '释放机位' },
        { name: '开始维护', label: '开始维护' },
      ]
    case '维护中':
      return [
        { name: '完成维保', label: '完成维保' },
        { name: '封闭机位', label: '封闭机位' },
      ]
    case '已封闭':
      return [{ name: '解除封闭', label: '解除封闭' }]
    default:
      return []
  }
}

function reload() {
  const timeline = buildTimeline(day.value)
  groups.value = timeline.groups
  stands.value = timeline.stands
  const payload = listEntries('stand', filters.value)
  tableRows.value = payload.items
}

function resetFilters() {
  filters.value = {}
  reload()
}

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
  reload()
}

function runStatusAction(action: string, row: EntryRow) {
  const result = changeStandStatus(Number(row.id), action)
  flash(result.ok, result.message)
}

watch(day, reload)

// ---------- 分配对话框 ----------
const allocOpen = ref(false)
const allocForm = ref({
  standCode: '',
  flight: '',
  aircraft: '',
  priority: '普通',
  startISO: '',
  endISO: '',
})

const allocatableStands = computed(() =>
  stands.value.filter((row) => row.status === '空闲' || row.status === '占用中'),
)
const flightOptions = computed(() =>
  [...new Set(listEntries('flight').items.map((row) => String(row['航班号'])))],
)
const aircraftOptions = computed(() =>
  [...new Set(listEntries('flight').items.map((row) => String(row['机型'])).filter(Boolean))],
)

function isoAt(targetDay: string, minute: number): string {
  return `${targetDay}T${hm(minute)}`
}

function openAllocate(standCode?: string | number, targetDay?: string, gap?: TimelineGap) {
  message.value = ''
  const code = standCode !== undefined ? String(standCode) : String(allocatableStands.value[0]?.['机位编号'] ?? '')
  allocForm.value = {
    standCode: code,
    flight: '',
    aircraft: '',
    priority: '普通',
    startISO: isoAt(targetDay ?? day.value, gap ? gap.startMin : Math.max(nowMin, 0)),
    endISO: isoAt(targetDay ?? day.value, gap ? gap.endMin : Math.min(nowMin + 60, 24 * 60)),
  }
  allocOpen.value = true
}

watch(
  () => allocForm.value.flight,
  (flight) => {
    const matched = listEntries('flight').items.find((row) => String(row['航班号']) === flight)
    if (matched) {
      if (!allocForm.value.aircraft) {
        allocForm.value.aircraft = String(matched['机型'] ?? '')
      }
      if (allocForm.value.priority === '普通') {
        allocForm.value.priority = String(matched['保障等级'] ?? '普通')
      }
    }
  },
)

function submitAllocate() {
  const result = allocateStand({ ...allocForm.value })
  if (result.ok) {
    allocOpen.value = false
  }
  flash(result.ok, result.message)
}

// ---------- 段详情与释放 ----------
const selectedSeg = ref<StandAllocation | null>(null)

function releaseSeg() {
  if (!selectedSeg.value) return
  const result = releaseAllocation(selectedSeg.value.id)
  selectedSeg.value = null
  flash(result.ok, result.message)
}

// ---------- 机位台账 ----------
const ledgerStand = ref<EntryRow | null>(null)
const ledgerRows = ref<StandAllocation[]>([])

function openLedger(stand: EntryRow) {
  ledgerStand.value = stand
  ledgerRows.value = listAllocations()
    .filter((row) => String(row['机位编号']) === String(stand['机位编号']))
    .sort((a, b) => String(b['开始时间']).localeCompare(String(a['开始时间'])))
}

function releaseLedger(id: number) {
  const result = releaseAllocation(id)
  flash(result.ok, result.message)
  if (ledgerStand.value) {
    openLedger(ledgerStand.value)
  }
}

function resetDemo() {
  resetStandDemo()
  day.value = today()
  flash(true, '机位、廊桥、航班与占用台账已恢复为示例数据')
}

onMounted(reload)
</script>

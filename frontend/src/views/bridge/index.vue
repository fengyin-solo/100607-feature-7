<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接管理</h2>
        <p class="page-desc">廊桥待办由机位分配自动生成；每条作业的对应机位与机位占用双向关联，两处对得上才能放心靠接。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记廊桥作业</button>
        <button class="btn" type="button" @click="exportRows">导出廊桥靠接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="consistencyIssues.length" class="issue-box">
      <strong>与机位占用对账异常（{{ consistencyIssues.length }}）：</strong>
      <ul>
        <li v-for="(issue, index) in consistencyIssues" :key="index">{{ issue.message }}</li>
      </ul>
    </div>
    <p v-else class="consistency-ok">对账正常：全部廊桥作业的对应机位与机位占用一致。</p>

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
      <label class="filter-item">
        <span>只看待办</span>
        <input v-model="pendingOnly" type="checkbox" style="width:auto" @change="reload" />
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td><span :class="['job-state', 'job-' + row.status]">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥靠接数据，待办会随廊桥机位分配自动生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥作业，其中待靠接 {{ pendingCount }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { checkBridgeConsistency } from '@/domain/stand-service'
import type { BridgeJobRow, ConsistencyIssue, EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const columns = ['作业编号', '廊桥编号', '对应机位', '航班号', '靠桥时间', '撤桥时间', '操作人员', '对接检查项', '作业状态']
const statuses = ['待靠接', '已靠桥', '已撤离', '异常中止']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const pendingCount = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const pendingOnly = ref(false)
const consistencyIssues = ref<ConsistencyIssue[]>([])
const filterFields = ['作业编号', '廊桥编号', '对应机位', '航班号']

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '今日靠接作业', value: total.value },
  { label: '待靠桥作业', value: pendingCount.value },
  { label: '异常中止作业', value: rows.value.filter((row) => row.status === '异常中止').length },
])

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待靠接':
      return ['开始靠接', '登记中止']
    case '已靠桥':
      return ['确认撤离', '登记中止']
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  pendingOnly.value = false
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '廊桥作业登记入口尚未接入审批流；廊桥待办请从机位分配的占用视图生成'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    const items = pendingOnly.value
      ? payload.items.filter((row) => String(row.status) === '待靠接')
      : payload.items
    rows.value = items
    total.value = payload.total
    pendingCount.value = payload.items.filter((row) => String(row.status) === '待靠接').length
    consistencyIssues.value = checkBridgeConsistency()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥靠接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.issue-box { background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
.issue-box ul { margin: 6px 0 0; padding-left: 18px; }
.consistency-ok { margin: 0 0 10px; font-size: 12px; color: #047857; }
.job-state { border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.job-待靠接 { background: #dbeafe; color: #1e40af; }
.job-已靠桥 { background: #fef3c7; color: #92400e; }
.job-已撤离 { background: #dcfce7; color: #166534; }
.job-异常中止 { background: #fee2e2; color: #991b1b; }
</style>

<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接管理</h2>
        <p class="page-desc">
          待靠接待办由机位分配自动生成，作业编号、廊桥编号、对应机位与机位占用台账双向核对，两处必须对得上。
        </p>
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

    <section class="todo-panel">
      <h3 class="todo-title">待靠接待办（机位分配联动生成）</h3>
      <ul v-if="pendingJobs.length" class="todo-list">
        <li v-for="item in pendingJobs" :key="String(item.job.id)" class="todo-item">
          <span class="todo-code">{{ item.job['作业编号'] }}</span>
          <span>{{ item.job['航班号'] }}</span>
          <span>廊桥 {{ item.job['廊桥编号'] }}</span>
          <span>机位 {{ item.job['对应机位'] }}</span>
          <span>{{ item.job['靠桥时间'] }}</span>
          <span class="consistency" :class="item.consistent ? 'ok' : 'bad'" :title="item.reason">
            {{ item.consistent ? '机位核对一致' : `对不上：${item.reason}` }}
          </span>
        </li>
      </ul>
      <p v-else class="empty-block">暂无待靠接作业</p>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>对应机位</span>
        <input v-model="standFilter" placeholder="按机位编号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>机位核对</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in checks" :key="String(item.job.id)">
          <td v-for="column in columns" :key="column">{{ item.job[column] ?? '—' }}</td>
          <td>
            <span class="consistency" :class="item.consistent ? 'ok' : 'bad'" :title="item.reason">
              {{ item.consistent ? '一致' : '不一致' }}
            </span>
          </td>
          <td>{{ item.job.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, item.job)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!checks.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无廊桥靠接数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ checks.length }} 条廊桥作业；机位被更高保障等级航班让位时，对应待办会同步撤回</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { listBridgeChecks } from '@/domain/stand'
import type { BridgeCheck } from '@/domain/stand'

const meta = moduleMeta('bridge')
const columns = ["作业编号", "航班号", "廊桥编号", "对应机位", "靠桥时间", "撤桥时间", "操作人员", "对接检查项", "作业状态"]
const actions = ["开始靠接", "确认撤离", "登记中止"]
const stats = computed(() => [
  { label: '今日靠接作业', value: checks.value.length },
  { label: '待靠桥作业', value: checks.value.filter((item) => item.job.status === '待靠接').length },
  { label: '机位核对不一致', value: checks.value.filter((item) => !item.consistent).length },
])

const checks = ref<BridgeCheck[]>([])
const standFilter = ref('')
const errorMessage = ref('')

const pendingJobs = computed(() => checks.value.filter((item) => item.job.status === '待靠接'))

function resetFilters() {
  standFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '廊桥作业由机位分配联动生成，暂不支持手工登记'
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
  const list = listBridgeChecks()
  const keyword = standFilter.value.trim()
  checks.value = keyword
    ? list.filter((item) => String(item.job['对应机位'] ?? '').includes(keyword))
    : list
}

onMounted(reload)
</script>

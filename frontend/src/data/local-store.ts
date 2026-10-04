import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 种子结构升级时抬版本号，旧缓存作废重新播种（机位占用从机位表拆出来了）。
const STORAGE_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredPayload = { v: number; entries: Record<string, object[]> }

function freshSeed(): StoredPayload {
  return { v: STORAGE_VERSION, entries: clone(SEED_ROWS) as unknown as Record<string, object[]> }
}

function readStorage(): Record<string, object[]> {
  const fallback = freshSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback.entries
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback.entries
  }
  try {
    const parsed = JSON.parse(raw) as StoredPayload | Record<string, object[]>
    // 兼容 v1：旧格式直接整包平铺，没有版本字段；结构变了不做合并，避免脏数据串味。
    if (!('v' in parsed) || (parsed as StoredPayload).v !== STORAGE_VERSION) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback.entries
    }
    return { ...fallback.entries, ...(parsed as StoredPayload).entries }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback.entries
  }
}

let cache: Record<string, object[]> | null = null

export function allRows(): Record<string, object[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows<T = EntryRow>(key: string): T[] {
  return (allRows()[key] ?? []) as T[]
}

export function saveRows<T extends object>(key: string, rows: T[]): void {
  const next: Record<string, object[]> = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    const payload: StoredPayload = { v: STORAGE_VERSION, entries: next }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }
}

export function resetRows<T extends object = EntryRow>(key: string): T[] {
  const rows = clone((SEED_ROWS as Record<string, unknown[]>)[key] ?? []) as T[]
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供领域测试使用：清空内存缓存，下次读取重新播种（Node 无 localStorage 的分支）。 */
export function __resetForTest(): void {
  cache = null
}

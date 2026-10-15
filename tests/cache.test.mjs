// TTLCache 纯逻辑测试（由 npm test 预先用 esbuild 转译到 tests/.gen/cache.mjs）
// 时间用注入的 fake now，避免真实 sleep。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TTLCache } from './.gen/cache.mjs'

function makeCache(ttlMs = 1000, maxEntries = 3) {
  let now = 0
  const cache = new TTLCache(ttlMs, maxEntries, () => now)
  return { cache, tick: (ms) => (now += ms) }
}

test('set/get：基本存取', () => {
  const { cache } = makeCache()
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('missing'), undefined)
})

test('TTL 过期：超过有效期后不可读并清除', () => {
  const { cache, tick } = makeCache(1000)
  cache.set('a', 'x')
  tick(999)
  assert.equal(cache.get('a'), 'x')
  tick(2) // 累计 1001ms > ttl
  assert.equal(cache.get('a'), undefined)
})

test('LRU：命中刷新顺序，容量淘汰最久未用', () => {
  const { cache } = makeCache(10000, 3)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  cache.get('a') // a 刷新为最近使用
  cache.set('d', 4) // 容量满 → 淘汰 b
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.get('d'), 4)
})

test('重复 set 同一 key：更新值且刷新使用顺序（LRU 正确性）', () => {
  const { cache } = makeCache(10000, 2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('a', 11) // a 刷新为最近使用 → b 变为最旧
  cache.set('c', 3)  // 容量满 → 淘汰 b
  assert.equal(cache.get('a'), 11)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.get('b'), undefined)
})

test('clear：全部清空后可继续写入', () => {
  const { cache } = makeCache()
  cache.set('a', 1)
  cache.set('b', 2)
  cache.clear()
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), undefined)
  cache.set('c', 3)
  assert.equal(cache.get('c'), 3)
})

test('空字符串/假值也能缓存（get 区分未命中 undefined）', () => {
  const { cache } = makeCache()
  cache.set('empty', '')
  assert.equal(cache.get('empty'), '')
  cache.set('zero', 0)
  assert.equal(cache.get('zero'), 0)
})

// 请求体解析纯逻辑测试（由 npm test 预先用 esbuild 转译到 tests/.gen/http-body.mjs）
// 覆盖宿主运行时（string body）与 SDK 声明（Uint8Array body）两种形态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyToString, parseBody } from './.gen/http-body.mjs'

const enc = (s) => new TextEncoder().encode(s)

test('string body：原样返回并解析 JSON', () => {
  assert.equal(bodyToString({ body: '{"a":1}' }), '{"a":1}')
  assert.deepEqual(parseBody({ body: '{"a":1}' }), { a: 1 })
})

test('Uint8Array body：UTF-8 中文可正确还原（不产生 latin1 乱码）', () => {
  const raw = JSON.stringify({ source_data: { id: '42', name: '周杰伦' } })
  assert.equal(bodyToString({ body: enc(raw) }), raw)
  assert.deepEqual(parseBody({ body: enc(raw) }), JSON.parse(raw))
})

test('string 与等价 Uint8Array 的解析结果一致', () => {
  const raw = JSON.stringify({ items: [{ id: '1', source: 'netease' }] })
  assert.deepEqual(parseBody({ body: raw }), parseBody({ body: enc(raw) }))
})

test('无 TextDecoder 时回退逐字节拼接：>8KB 分块仍完整', () => {
  const original = globalThis.TextDecoder
  globalThis.TextDecoder = undefined
  try {
    const raw = JSON.stringify({ items: Array.from({ length: 3000 }, (_, i) => i) })
    assert.ok(raw.length > 8192)
    assert.equal(bodyToString({ body: enc(raw) }), raw)
    assert.deepEqual(parseBody({ body: enc(raw) }), JSON.parse(raw))
  } finally {
    globalThis.TextDecoder = original
  }
})

test('空体 / 非法 JSON 一律返回空对象', () => {
  assert.deepEqual(parseBody({}), {})
  assert.deepEqual(parseBody({ body: null }), {})
  assert.deepEqual(parseBody({ body: '' }), {})
  assert.deepEqual(parseBody({ body: '{bad' }), {})
  assert.equal(bodyToString({ body: null }), '')
})

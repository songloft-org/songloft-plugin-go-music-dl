import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, fmtTime, formatBitrateBadge } from '../static/js/util.js'

test('escapeHtml 转义全部危险字符', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
  assert.equal(escapeHtml(undefined), '') // 非字符串入参安全降级为空串
  assert.equal(escapeHtml('晴天 Live'), '晴天 Live') // 中文原样
})

test('fmtTime 常规与边界', () => {
  assert.equal(fmtTime(0), '0:00')
  assert.equal(fmtTime(65), '1:05')
  assert.equal(fmtTime(3599), '59:59')
  assert.equal(fmtTime(-1), '0:00')
  assert.equal(fmtTime(NaN), '0:00')
})

test('formatBitrateBadge 分档', () => {
  assert.equal(formatBitrateBadge('320 kbps'), '320 kbps')
  assert.equal(formatBitrateBadge('799 kbps'), '799 kbps')
  assert.equal(formatBitrateBadge('800 kbps'), '无损')
  assert.equal(formatBitrateBadge('1000 kbps'), 'Hi-Res')
  assert.equal(formatBitrateBadge('-'), '')
  assert.equal(formatBitrateBadge(''), '')
})

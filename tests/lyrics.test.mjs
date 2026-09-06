import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLrc } from '../static/js/lyrics.js'

test('parseLrc 解析多时间戳行并按时间排序', () => {
  const lrc = [
    '[00:12.5][01:02]第一句重复',
    '[00:01.00]第二句',
    '无时间戳行忽略',
    '[0:30]第三句',
  ].join('\n')
  const lines = parseLrc(lrc)
  // 多时间戳行拆成两条；乱序输入按时间升序排列
  assert.equal(lines.length, 4)
  assert.equal(lines[0].time, 1)
  assert.equal(lines[0].text, '第二句')
  assert.equal(lines[1].time, 12.5)
  assert.equal(lines[1].text, '第一句重复')
  assert.equal(lines[2].time, 30)
  assert.equal(lines[2].text, '第三句')
  assert.equal(lines[3].time, 62, '[01:02] 无毫秒段按秒解析')
  assert.equal(lines[3].text, '第一句重复')
})

test('parseLrc 空输入', () => {
  assert.deepEqual(parseLrc(''), [])
  assert.deepEqual(parseLrc(null), [])
})

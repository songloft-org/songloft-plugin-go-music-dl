// 歌词格式工具纯函数测试（由 npm test 预先用 esbuild 转译到 tests/.gen/lyrics-format.mjs）
// 语义基准：go-music-dl internal/web/lyrics_format.go（classify/collapse）
// 与宿主 lib/features/player/domain/lyric_parser.dart（绝对单尖括号逐字格式）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyLyricFormat,
  collapseKaraokeToLines,
  karaokeToLxLyric,
} from './.gen/lyrics-format.mjs'

test('classifyLyricFormat：普通逐行 LRC → line', () => {
  const raw = [
    '[00:01.00]第一行',
    '[00:02.50]第二行',
    '[00:03.00]第三行',
  ].join('\n')
  assert.equal(classifyLyricFormat(raw), 'line')
})

test('classifyLyricFormat：一行多时间戳（逐字交错）→ karaoke', () => {
  const raw = '[00:01.00]你[00:01.50]好[00:02.00]吗'
  assert.equal(classifyLyricFormat(raw), 'karaoke')
})

test('classifyLyricFormat：多行共用起始时间戳 → karaoke', () => {
  const raw = ['[00:01.00]A', '[00:01.00]B'].join('\n')
  assert.equal(classifyLyricFormat(raw), 'karaoke')
})

test('classifyLyricFormat：元数据标签行与空行不影响判定', () => {
  const raw = ['[ti:测试]', '[ar:某人]', '', '[00:01.00]正文'].join('\n')
  assert.equal(classifyLyricFormat(raw), 'line')
  assert.equal(classifyLyricFormat(''), 'line')
  assert.equal(classifyLyricFormat('[ti:只有标签]'), 'line')
})

test('collapseKaraokeToLines：逐字交错行折叠为首个时间戳 + 全文', () => {
  const raw = '[00:01.00]你[00:01.50]好[00:02.00]吗'
  assert.equal(collapseKaraokeToLines(raw), '[00:01.00]你好吗')
})

test('collapseKaraokeToLines：行首多标签行折叠为单标签', () => {
  const raw = '[00:01.00][00:05.00]副歌'
  assert.equal(collapseKaraokeToLines(raw), '[00:01.00]副歌')
})

test('collapseKaraokeToLines：多行共用起始时间戳去重保留首个', () => {
  const raw = ['[00:01.00]A', '[00:01.00]B', '[00:02.00]C'].join('\n')
  const out = collapseKaraokeToLines(raw)
  assert.deepEqual(out.split('\n'), ['[00:01.00]A', '[00:02.00]C'])
})

test('collapseKaraokeToLines：保留元数据标签并以空行分隔、按起始时间排序', () => {
  const raw = [
    '[ti:测试]',
    '[00:03.00]后',
    '[00:01.00]前',
  ].join('\n')
  const out = collapseKaraokeToLines(raw)
  assert.deepEqual(out.split('\n'), [
    '[ti:测试]',
    '',
    '[00:01.00]前',
    '[00:03.00]后',
  ])
})

test('collapseKaraokeToLines：纯时间戳空文本行被丢弃', () => {
  const raw = ['[00:01.00]', '[00:02.00]有词'].join('\n')
  assert.equal(collapseKaraokeToLines(raw), '[00:02.00]有词')
})

test('karaokeToLxLyric：逐字交错行转宿主绝对单尖括号格式', () => {
  const raw = '[00:01.00]你[00:01.50]好[00:02.00]吗'
  assert.equal(
    karaokeToLxLyric(raw),
    '[00:01.00]<00:01.00>你<00:01.50>好<00:02.00>吗',
  )
})

test('karaokeToLxLyric：连续起始时间戳归并到首个非空段', () => {
  const raw = '[00:01.00][00:01.20]你[00:02.00]好'
  assert.equal(
    karaokeToLxLyric(raw),
    '[00:01.00]<00:01.00>你<00:02.00>好',
  )
})

test('karaokeToLxLyric：行首多标签普通行折叠（与 lyric 字段行时间一致）', () => {
  const raw = '[00:01.00][00:05.00]副歌'
  assert.equal(karaokeToLxLyric(raw), '[00:01.00]副歌')
})

test('karaokeToLxLyric：单时间戳行与元数据行原样保留', () => {
  const raw = ['[ti:测试]', '[00:01.00]普通行'].join('\n')
  assert.equal(karaokeToLxLyric(raw), raw)
})

test('karaokeToLxLyric：时间标签规整（1 位秒补零、分钟钳 99）', () => {
  // 上游正则允许 [1:2.3] 这类短标签；宿主逐字正则要求 ss 固定 2 位
  const raw = '[100:02.34]你[100:03.50]好'
  assert.equal(karaokeToLxLyric(raw), '[99:02.34]<99:02.34>你<99:03.50>好')
})

test('karaokeToLxLyric：纯时间戳无文本行被丢弃', () => {
  const raw = ['[00:01.00][00:02.00]', '[00:03.00]有词'].join('\n')
  assert.equal(karaokeToLxLyric(raw), '[00:03.00]有词')
})

test('karaokeToLxLyric：混合形态（重复起始标签 + 逐字）按交错处理且不丢时间点', () => {
  // [t1][t2]w1[t3]w2：t2 为空段，w1 归属更早的 t1（保守取起始），w2 用 t3
  const raw = '[00:01.00][00:01.20]你[00:02.00]好'
  const out = karaokeToLxLyric(raw)
  assert.ok(out.startsWith('[00:01.00]'))
  assert.ok(out.includes('<00:01.00>你'))
  assert.ok(out.includes('<00:02.00>好'))
})

test('折叠与逐字转换的时间语义一致性：lyric 行时间 == lxlyric 行时间', () => {
  const raw = '[00:10.00]你[00:10.40]好[00:11.00]世[00:11.60]界\n[00:20.00]下一句'
  const lyric = collapseKaraokeToLines(raw)
  const lx = karaokeToLxLyric(raw)
  assert.deepEqual(
    lyric.split('\n').map((l) => l.match(/^\[\d+:\d+\.\d+\]/)[0]),
    lx.split('\n').map((l) => l.match(/^\[\d+:\d+\.\d+\]/)[0]),
  )
})

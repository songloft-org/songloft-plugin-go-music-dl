// 配置模块纯函数测试（由 npm test 预先用 esbuild 转译到 tests/.gen/config.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, hotPathSources, FAST_SOURCES, DEFAULT_SOURCES } from './.gen/config.mjs'

test('normalizeConfig：baseUrl 补 /music 前缀、保存即归一（save 后缓存与落盘一致）', () => {
  const c = normalizeConfig({ baseUrl: 'http://192.168.1.190:8080' })
  assert.equal(c.baseUrl, 'http://192.168.1.190:8080/music')
  // 已带 /music 不重复追加
  assert.equal(
    normalizeConfig({ baseUrl: 'http://192.168.1.190:8080/music' }).baseUrl,
    'http://192.168.1.190:8080/music',
  )
  // 空值字段收口
  const empty = normalizeConfig({})
  assert.equal(empty.baseUrl, '')
  assert.equal(empty.externalBaseUrl, '')
  assert.equal(empty.serverHost, '')
  assert.deepEqual(empty.sources, DEFAULT_SOURCES)
  // serverHost 只去空白/斜杠，不补 /music
  assert.equal(
    normalizeConfig({ serverHost: 'http://192.168.1.190:58091/' }).serverHost,
    'http://192.168.1.190:58091',
  )
  assert.equal(
    normalizeConfig({ serverHost: 'http://192.168.1.190:58091' }).serverHost,
    'http://192.168.1.190:58091',
  )
})

test('FAST_SOURCES：与上游 GetDefaultSourceNames 对齐（8 源，不含 bilibili/joox/jamendo/fivesing/local）', () => {
  assert.equal(FAST_SOURCES.length, 8)
  for (const excluded of ['bilibili', 'joox', 'jamendo', 'fivesing', 'local']) {
    assert.ok(!FAST_SOURCES.includes(excluded), `不应包含 ${excluded}`)
  }
  // 快源必须是全量音源的子集
  for (const s of FAST_SOURCES) {
    assert.ok(DEFAULT_SOURCES.includes(s), `${s} 应在全量音源内`)
  }
})

test('hotPathSources：取用户已启用音源与快源的交集', () => {
  const config = { sources: ['netease', 'kugou', 'bilibili', 'joox'] }
  assert.deepEqual(hotPathSources(config), ['netease', 'kugou'])
})

test('hotPathSources：交集为空时退回用户全量配置（只勾慢源不被砍死）', () => {
  const config = { sources: ['bilibili', 'jamendo'] }
  assert.deepEqual(hotPathSources(config), ['bilibili', 'jamendo'])
})

test('hotPathSources：sources 为空时退回默认全量音源', () => {
  assert.deepEqual(hotPathSources({ sources: [] }), DEFAULT_SOURCES)
  assert.deepEqual(hotPathSources({}), DEFAULT_SOURCES)
})

test('hotPathSources：尊重用户关停某个快源', () => {
  const config = { sources: [...DEFAULT_SOURCES.filter((s) => s !== 'qq')] }
  const hot = hotPathSources(config)
  assert.ok(!hot.includes('qq'))
  assert.equal(hot.length, FAST_SOURCES.length - 1)
})

// 配置模块纯函数测试（由 npm test 预先用 esbuild 转译到 tests/.gen/config.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, hotPathSources, FAST_SOURCES, DEFAULT_SOURCES } from './.gen/config.mjs'

test('normalizeConfig：地址根化收口、basePath 默认/归一（save 后缓存与落盘一致）', () => {
  const c = normalizeConfig({ baseUrl: 'http://192.168.1.190:8080' })
  assert.equal(c.baseUrl, 'http://192.168.1.190:8080')
  assert.equal(c.basePath, '/music')
  // 已带 /music 结尾（旧版落盘形态）根化还原为根地址
  assert.equal(
    normalizeConfig({ baseUrl: 'http://192.168.1.190:8080/music' }).baseUrl,
    'http://192.168.1.190:8080',
  )
  // 自定义 basePath：缺前导斜杠自动补
  const dl = normalizeConfig({ baseUrl: 'http://192.168.1.190:8080', basePath: 'dl' })
  assert.equal(dl.basePath, '/dl')
  assert.equal(dl.baseUrl, 'http://192.168.1.190:8080')
  // 空值字段收口
  const empty = normalizeConfig({})
  assert.equal(empty.baseUrl, '')
  assert.equal(empty.basePath, '/music')
  assert.equal(empty.externalBaseUrl, '')
  assert.equal(empty.serverHost, '')
  assert.deepEqual(empty.sources, DEFAULT_SOURCES)
  // serverHost 只去空白/斜杠，不做根化之外的路径处理
  assert.equal(
    normalizeConfig({ serverHost: 'http://192.168.1.190:58091/' }).serverHost,
    'http://192.168.1.190:58091',
  )
  assert.equal(
    normalizeConfig({ serverHost: 'http://192.168.1.190:58091' }).serverHost,
    'http://192.168.1.190:58091',
  )
})

test('normalizeConfig：旧版数据（无 basePath 字段）迁移剥离结尾 /music', () => {
  // 旧版落盘 baseUrl/externalBaseUrl 均为「root + /music」强制追加形式
  const legacy = normalizeConfig({
    baseUrl: 'http://192.168.1.190:8080/music',
    externalBaseUrl: 'https://gw.example.com/music',
  })
  assert.equal(legacy.baseUrl, 'http://192.168.1.190:8080')
  assert.equal(legacy.externalBaseUrl, 'https://gw.example.com')
  assert.equal(legacy.basePath, '/music')
  // 运行时拼接结果与旧版行为一致
  assert.equal(legacy.baseUrl + legacy.basePath, 'http://192.168.1.190:8080/music')
  // 新版数据（basePath 字段存在）不做剥离：真实路径以 /music 结尾的部署不被误伤
  const modern = normalizeConfig({
    baseUrl: 'http://192.168.1.190:8080',
    basePath: '/music',
  })
  assert.equal(modern.baseUrl, 'http://192.168.1.190:8080')
  // 新版用户手填完整地址（罕见）：新数据不剥离保留原值，运行时 normalizeBaseUrl
  // 的 endsWith 幂等兜底不重复追加
  const modernFull = normalizeConfig({
    baseUrl: 'http://192.168.1.190:8080/music',
    basePath: '/music',
  })
  assert.equal(modernFull.baseUrl, 'http://192.168.1.190:8080/music')
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

// 服务/凭据体检：URL 分流与状态判定（由 npm test 预先用 esbuild 转译）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  probeUrl,
  cookiesUrl,
  collectCookieSources,
  diagnose,
} from './.gen/diagnostics.mjs'

const gmd = { baseUrl: 'http://h:8080', basePath: '/dl', sources: [], backendType: 'gmd' }
const api = { baseUrl: 'http://h:8080', basePath: '/music', sources: [], backendType: 'api' }

function deps(responses) {
  return {
    cookieHeaders: async () => ({}),
    request: async (url) => {
      const hit = responses.find((r) => url.endsWith(r.match))
      if (!hit) throw new Error('unexpected url: ' + url)
      return hit.resp
    },
  }
}

test('probeUrl / cookiesUrl 按后端分流', () => {
  assert.equal(probeUrl(gmd), 'http://h:8080/dl/healthz')
  assert.equal(cookiesUrl(gmd), 'http://h:8080/dl/cookies')
  assert.equal(probeUrl(api), 'http://h:8080/api/v1/system/cookies')
  assert.equal(cookiesUrl(api), 'http://h:8080/api/v1/system/cookies')
  assert.equal(probeUrl({ ...gmd, baseUrl: '' }), '')
})

test('collectCookieSources 兼容三种返回形态且过滤空值', () => {
  assert.deepEqual(collectCookieSources({ netease: 'abc', qq: '' }), ['netease'])
  assert.deepEqual(collectCookieSources({ cookies: { qq: 'x', kugou: '  ' } }), ['qq'])
  assert.deepEqual(collectCookieSources({ code: 0, data: { migu: 'z' } }), ['migu'])
  assert.deepEqual(collectCookieSources(null), [])
})

test('未配置地址直接判不可达', async () => {
  const r = await diagnose({ ...gmd, baseUrl: '' }, deps([]))
  assert.equal(r.state, 'unreachable')
})

test('gmd：healthz 连不上 → unreachable', async () => {
  const r = await diagnose(gmd, {
    cookieHeaders: async () => ({}),
    request: async () => { throw new Error('boom') },
  })
  assert.equal(r.state, 'unreachable')
  assert.match(r.message, /boom/)
})

test('gmd：未初始化管理员账号 → no_auth_setup，不误报凭据失效', async () => {
  const r = await diagnose(gmd, deps([
    { match: '/healthz', resp: { status: 200, data: { status: 'ok' } } },
    { match: '/cookies', resp: { status: 401, data: { setupRequired: true } } },
  ]))
  assert.equal(r.ok, true)
  assert.equal(r.state, 'no_auth_setup')
})

test('gmd：401 但非 setupRequired → 提示管理员账号', async () => {
  const r = await diagnose(gmd, deps([
    { match: '/healthz', resp: { status: 200, data: {} } },
    { match: '/cookies', resp: { status: 401, data: { error: 'unauthorized' } } },
  ]))
  assert.equal(r.state, 'no_admin_credentials')
})

test('gmd：200 → ready 且只列平台名，不含 Cookie 内容', async () => {
  const r = await diagnose(gmd, deps([
    { match: '/healthz', resp: { status: 200, data: {} } },
    { match: '/cookies', resp: { status: 200, data: { netease: 'secret-value', qq: '' } } },
  ]))
  assert.equal(r.state, 'ready')
  assert.deepEqual(r.sources, ['netease'])
  assert.ok(!r.message.includes('secret-value'))
})

test('api：cookies 200 → ready；404 → unreachable', async () => {
  const ok = await diagnose(api, deps([
    { match: '/cookies', resp: { status: 200, data: { qq: 'x' } } },
  ]))
  assert.equal(ok.state, 'ready')
  assert.deepEqual(ok.sources, ['qq'])
  const bad = await diagnose(api, deps([
    { match: '/cookies', resp: { status: 404, data: null } },
  ]))
  assert.equal(bad.state, 'unreachable')
})

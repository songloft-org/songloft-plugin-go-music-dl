// gmd-auth 纯函数测试（由 npm test 预先用 esbuild 转译到 tests/.gen/gmd-auth.mjs）
// 覆盖 Set-Cookie 解析（gmd music_dl_session，auth.go 同名契约）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCookieValue,
  parseSessionFromHeaders,
} from './.gen/gmd-auth.mjs'

test('extractCookieValue：从 Set-Cookie 提取 music_dl_session 值', () => {
  const sc =
    'music_dl_session=abc.123; Path=/music; HttpOnly; SameSite=Lax; Max-Age=604800'
  assert.equal(extractCookieValue(sc, 'music_dl_session'), 'abc.123')
  // 混入其他 cookie：按名字精确匹配
  assert.equal(
    extractCookieValue('foo=1; music_dl_session=x.y', 'music_dl_session'),
    'x.y',
  )
  // 值含等号（base64url 不含 =，但防御性取第一个分号前的完整值）
  assert.equal(extractCookieValue('music_dl_session=a=b;c=d', 'music_dl_session'), 'a=b')
  assert.equal(extractCookieValue('other=1', 'music_dl_session'), '')
  assert.equal(extractCookieValue('', 'music_dl_session'), '')
})

test('parseSessionFromHeaders：Go http.Header JSON 形态（Set-Cookie 数组）', () => {
  const headers = {
    'Set-Cookie': [
      'music_dl_session=tok.ensig; Path=/music; HttpOnly',
      'other=2; Path=/music',
    ],
  }
  assert.equal(parseSessionFromHeaders(headers), 'tok.ensig')
})

test('parseSessionFromHeaders：小写键与单字符串形态兜底、缺失返回空', () => {
  assert.equal(
    parseSessionFromHeaders({ 'set-cookie': 'music_dl_session=low.1' }),
    'low.1',
  )
  assert.equal(
    parseSessionFromHeaders({ 'Set-Cookie': 'music_dl_session=str.2' }),
    'str.2',
  )
  assert.equal(parseSessionFromHeaders({}), '')
  assert.equal(parseSessionFromHeaders(null), '')
})

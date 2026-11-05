// /stream 直链 token 的签名/过期测试（由 npm test 预先用 esbuild 转译）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

// 模拟宿主注入：签名原语 + 持久化 storage
const store = new Map()
globalThis.songloft = {
  storage: {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v) },
  },
}
globalThis.__go_crypto_sha256 = (s) => createHash('sha256').update(s).digest('hex')
globalThis.__go_crypto_random_bytes = (n) => randomBytes(n).toString('hex')

const {
  encodeStreamToken,
  decodeStreamToken,
  StreamTokenError,
  STREAM_TOKEN_TTL_MS,
  resetStreamSecretForTest,
} = await import('./.gen/stream-token.mjs')

const song = { id: '123', source: 'netease', name: '晴天' }
const now = 1_700_000_000_000

test('签名 token 往返且密钥已持久化', async () => {
  const tok = await encodeStreamToken(song, now)
  assert.equal(tok.split('.').length, 2)
  assert.deepEqual(await decodeStreamToken(tok, now), song)
  assert.ok([...store.values()][0])
})

test('篡改 body 或签名一律拒绝', async () => {
  const tok = await encodeStreamToken(song, now)
  const [body, sig] = tok.split('.')
  await assert.rejects(() => decodeStreamToken(`${body}x.${sig}`, now), StreamTokenError)
  await assert.rejects(() => decodeStreamToken(`${body}.deadbeef`, now), StreamTokenError)
})

test('过期 token 与历史无签名 token 均拒绝', async () => {
  const tok = await encodeStreamToken(song, now)
  await assert.rejects(
    () => decodeStreamToken(tok, now + STREAM_TOKEN_TTL_MS + 1),
    StreamTokenError,
  )
  // 旧版 token 是单段 base64url(JSON)，既无签名也无 exp
  await assert.rejects(() => decodeStreamToken('eyJpZCI6IjEyMyJ9', now), StreamTokenError)
})

test('不同歌曲生成不同 token，同一密钥下均可解码', async () => {
  const a = await encodeStreamToken(song, now)
  const b = await encodeStreamToken({ ...song, id: '456' }, now)
  assert.notEqual(a, b)
  assert.equal((await decodeStreamToken(b, now)).id, '456')
})

test('CSPRNG 不可用（空串/过短）时不签发直链、拒绝校验，且不落盘弱密钥', async () => {
  resetStreamSecretForTest()
  store.clear()
  const origRandom = globalThis.__go_crypto_random_bytes
  globalThis.__go_crypto_random_bytes = () => ''
  try {
    // 编码端：无安全密钥 → 返回 null（调用方走入库播放回退，绝不回退 Math.random）
    assert.equal(await encodeStreamToken(song, now), null)
    // 解码端：格式有效的 token 也拒绝，且此时密钥不可用不触发签名退化
    await assert.rejects(() => decodeStreamToken('aaaa.bbbb', now), StreamTokenError)
    // 过短密钥同样拒绝
    globalThis.__go_crypto_random_bytes = () => 'short'
    assert.equal(await encodeStreamToken(song, now), null)
    // 不落盘空/弱密钥
    assert.equal(store.size, 0)
  } finally {
    globalThis.__go_crypto_random_bytes = origRandom
    resetStreamSecretForTest()
  }
})

test('格式非法的 token 不触发密钥生成/storage 写入', async () => {
  resetStreamSecretForTest()
  store.clear()
  const calls = { get: 0, set: 0 }
  globalThis.songloft.storage = {
    get: async (k) => { calls.get++; return store.has(k) ? store.get(k) : null },
    set: async (k, v) => { calls.set++; store.set(k, v) },
  }
  try {
    await assert.rejects(() => decodeStreamToken('not-a-signed-token', now), StreamTokenError)
    assert.equal(calls.get, 0)
    assert.equal(calls.set, 0)
  } finally {
    resetStreamSecretForTest()
  }
})

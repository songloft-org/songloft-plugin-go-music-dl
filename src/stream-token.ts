// /stream/:token 的免鉴权直链保护：签名 + 过期时间。
//
// 背景：plugin.json 的 publicPaths:["/stream"] 让该端点绕过宿主 JWT，宿主明确要求
// 插件自行校验（internal/jsplugin/routes.go）。历史 token 只是 base64url(JSON)，
// 任何人都能构造/永久重放。这里用「插件持久化密钥 + 宿主原生 SHA-256」做带密钥摘要，
// 并给每个 token 加 24h 有效期，音箱/日志里泄漏的旧 URL 不会长期可用。

import { encodeBase64Url, decodeBase64Url } from './bridge-contract'

/** 直链有效期：足够覆盖点歌后延迟播放，又不会让泄漏的 URL 长期可用。 */
export const STREAM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** 密钥最短长度：宿主桥失败时可能返回空串，低于该长度视为不可用（拒绝签发直链）。 */
const MIN_SECRET_LEN = 16

const SECRET_KEY = 'gomusicdl_stream_secret'
let cachedSecret: string | null = null
let pendingSecret: Promise<string | null> | null = null

/** 宿主原生 SHA-256（hex）；旧宿主依次降级到 sha256Bytes / md5。 */
function hash(s: string): string {
  const g = globalThis as any
  if (typeof g.__go_crypto_sha256 === 'function') {
    return String(g.__go_crypto_sha256(s))
  }
  if (g.crypto && typeof g.crypto.sha256Bytes === 'function') {
    return String(g.crypto.sha256Bytes(s).toString('hex'))
  }
  if (g.crypto && typeof g.crypto.md5 === 'function') {
    return String(g.crypto.md5(s))
  }
  throw new Error('no hash primitive available for stream token')
}

/**
 * 生成强随机密钥；不可用（桥失败返回空串 / 旧宿主无原语）时返回 null。
 * 刻意不回退 Math.random：可预测密钥等于没有签名，宁可禁用直链走入库播放。
 */
function randomSecret(): string | null {
  const g = globalThis as any
  if (typeof g.__go_crypto_random_bytes === 'function') {
    const s = String(g.__go_crypto_random_bytes(24))
    if (s.length >= MIN_SECRET_LEN) return s
  }
  if (g.crypto && typeof g.crypto.randomBytes === 'function') {
    const s = String(g.crypto.randomBytes(24).toString('hex'))
    if (s.length >= MIN_SECRET_LEN) return s
  }
  return null
}

/**
 * 取签名密钥：优先内存缓存，其次插件 storage（宿主空闲驱逐重建 VM 后仍可读回，
 * 保证已发出的 URL 不因重启失效）；首次生成并落盘。in-flight 合并避免并发首次
 * 生成出多个不同密钥。返回 null 表示当前运行时无法产出安全密钥，调用方必须
 * 拒绝签发/校验直链，而不是退化为可伪造签名。
 */
export function getStreamSecret(): Promise<string | null> {
  if (cachedSecret) return Promise.resolve(cachedSecret)
  if (pendingSecret) return pendingSecret
  pendingSecret = (async () => {
    const storage = (globalThis as any).songloft?.storage
    let secret = ''
    try {
      const raw = await storage?.get(SECRET_KEY)
      if (typeof raw === 'string') secret = raw
    } catch {
      /* 读失败则重新生成 */
    }
    if (secret.length < MIN_SECRET_LEN) {
      secret = randomSecret() || ''
    }
    if (secret.length >= MIN_SECRET_LEN) {
      try {
        await storage?.set(SECRET_KEY, secret)
      } catch {
        /* 落盘失败时至少本次 VM 内签名一致 */
      }
    }
    cachedSecret = secret || null
    return cachedSecret
  })().finally(() => {
    pendingSecret = null
  })
  return pendingSecret
}

export class StreamTokenError extends Error {}

/** 生成 `body.sig` 形式的直链 token；now 可注入便于测试过期。
 *  密钥不可用时返回 null，调用方应放弃直链（走入库播放回退）。 */
export async function encodeStreamToken(
  song: unknown,
  now = Date.now(),
): Promise<string | null> {
  const secret = await getStreamSecret()
  if (!secret) return null
  const body = encodeBase64Url(
    JSON.stringify({ v: 2, exp: now + STREAM_TOKEN_TTL_MS, song }),
  )
  return `${body}.${hash(`${secret}.${body}`)}`
}

/** 校验签名与有效期，返回原始歌曲；任何无效 token 抛 StreamTokenError。
 *  格式校验前置：无效 token 不触发密钥生成/storage 写入（publicPaths 免鉴权）。 */
export async function decodeStreamToken<T>(
  tok: string,
  now = Date.now(),
): Promise<T> {
  const parts = String(tok || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new StreamTokenError('invalid token')
  }
  const [body, sig] = parts
  if (!/^[0-9a-fA-F]{16,128}$/.test(sig)) {
    throw new StreamTokenError('bad signature')
  }
  const secret = await getStreamSecret()
  if (!secret) throw new StreamTokenError('token signing unavailable')
  if (hash(`${secret}.${body}`) !== sig) {
    throw new StreamTokenError('bad signature')
  }
  let payload: any
  try {
    payload = JSON.parse(decodeBase64Url(body))
  } catch {
    throw new StreamTokenError('invalid token')
  }
  if (
    !payload ||
    payload.v !== 2 ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now ||
    !payload.song ||
    typeof payload.song !== 'object'
  ) {
    throw new StreamTokenError('expired or malformed token')
  }
  return payload.song as T
}

/** 测试专用：清空密钥缓存与 in-flight 合并（生产代码不应调用）。 */
export function resetStreamSecretForTest(): void {
  cachedSecret = null
  pendingSecret = null
}

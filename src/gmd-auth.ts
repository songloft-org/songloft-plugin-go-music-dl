// go-music-dl 登录鉴权支持：gmd 实例开启 Web 管理员登录后，qr_login / cookies 等
// 系统配置端点需要 music_dl_session Cookie（internal/web/auth.go，authRequired 中间件）。
//
// 修复方式：插件保存 gmd 管理员账号（用户在设置页「账号登录」分组填写，可选），
// 需要时用宿主 songloft.net.httpStream 做「表单登录 → 读 302 响应的 Set-Cookie」
// （普通 fetch 不暴露响应头，httpStream 的 response.headers 是完整 Go http.Header，
// 且带 X-Fetch-No-Redirect 头可禁用重定向——登录端点是 302 + Set-Cookie，必须拿第一跳）。
// session 为 HMAC 自包含值、7 天有效（auth.go sessionMaxAge），缓存 6 天后强制重登；
// 上游 session 失效（401）由调用方触发 forceRefresh 重登一次。
//
// 安全说明：凭据保存在插件 storage（宿主插件数据目录，不上传第三方），与用户把
// Cookie 手工配到 gmd 的暴露面一致；不填凭据时插件行为与以前完全一致。

import { GoMusicDlConfig, normalizeBaseUrl } from './config'

const SESSION_STORAGE_KEY = 'gomusicdl_gmd_session'
const GMD_SESSION_COOKIE = 'music_dl_session'
// gmd session 有效期 7 天，提前 1 天强制重登，避免临界过期
const SESSION_TTL_MS = 6 * 24 * 3600 * 1000

interface CachedSession {
  cookie: string
  savedAt: number
}

/** 从 Set-Cookie 值中提取 cookie 名对应的值（取到第一个分号） */
export function extractCookieValue(setCookie: string, name: string): string {
  const parts = String(setCookie || '').split(';')
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim()
    }
  }
  return ''
}

/** 从 httpStream 响应头（Go http.Header JSON：map[string][]string）解析 gmd session */
export function parseSessionFromHeaders(headers: Record<string, any>): string {
  if (!headers) return ''
  const raw = headers['Set-Cookie'] ?? headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  for (const sc of list) {
    const value = extractCookieValue(String(sc), GMD_SESSION_COOKIE)
    if (value) return value
  }
  return ''
}

function hasCredentials(config: GoMusicDlConfig): boolean {
  return !!(config.gmdAuthUser && config.gmdAuthPass)
}

async function readCachedSession(): Promise<CachedSession | null> {
  try {
    const raw = await (globalThis as any).songloft?.storage?.get(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(String(raw))
    if (parsed && typeof parsed.cookie === 'string' && parsed.cookie) {
      const savedAt = Number(parsed.savedAt) || 0
      if (savedAt > 0 && Date.now() - savedAt < SESSION_TTL_MS) {
        return { cookie: parsed.cookie, savedAt }
      }
    }
  } catch {
    /* 坏数据当作无缓存 */
  }
  return null
}

async function writeCachedSession(cookie: string): Promise<void> {
  try {
    const s = (globalThis as any).songloft?.storage
    if (s) await s.set(SESSION_STORAGE_KEY, JSON.stringify({ cookie, savedAt: Date.now() }))
  } catch {
    /* 存储失败不致命：下次 401 重登 */
  }
}

export async function clearCachedSession(): Promise<void> {
  try {
    const s = (globalThis as any).songloft?.storage
    if (s) await s.set(SESSION_STORAGE_KEY, JSON.stringify({ cookie: '', savedAt: 0 }))
  } catch {
    /* ignore */
  }
}

/**
 * 表单登录 gmd 拿 session（X-Fetch-No-Redirect 禁用重定向，读取第一跳 Set-Cookie）。
 * - 302 + Set-Cookie → 登录成功
 * - 200 → 登录页错误（凭据错误/被锁定）
 * - 302 无 session cookie → gmd 未启用登录（authConfigured=false 时 /login 会 302 到 /setup）
 */
async function loginAndCache(
  config: GoMusicDlConfig,
): Promise<string> {
  const net = (globalThis as any).songloft?.net
  if (!net || typeof net.httpStream !== 'function') {
    throw new Error('当前宿主不支持 songloft.net.httpStream，无法自动登录 go-music-dl')
  }
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const form =
    `username=${encodeURIComponent(config.gmdAuthUser || '')}` +
    `&password=${encodeURIComponent(config.gmdAuthPass || '')}` +
    `&next=${encodeURIComponent(base + '/')}`
  const stream = net.httpStream(`${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Fetch-No-Redirect': '1',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: form,
    timeoutMs: 15000,
  })
  let resp: any
  try {
    resp = await stream.response
  } catch (e: any) {
    try { stream.cancel() } catch { /* ignore */ }
    throw new Error('无法连接 go-music-dl: ' + ((e && e.message) || String(e)))
  }
  // 登录响应无正文需求（302 空体 / 200 错误页文本已由状态码区分），直接取消流
  try { stream.cancel() } catch { /* ignore */ }
  const status = Number(resp && resp.status) || 0
  const cookie = parseSessionFromHeaders((resp && resp.headers) || {})
  if (cookie) return cookie
  if (status === 200) {
    throw new Error('go-music-dl 登录失败：用户名或密码不正确（或失败次数过多被锁定），请检查「账号登录」分组中填写的管理员账号')
  }
  if (status === 302 || status === 303) {
    throw new Error('go-music-dl 未启用登录鉴权（/login 跳转到了初始化页），无需填写管理员账号')
  }
  throw new Error(`go-music-dl 登录失败: HTTP ${status}`)
}

/**
 * 取 gmd session Cookie 请求头；无凭据时返回空对象（调用方按免鉴权请求处理）。
 * forceRefresh：上游返回 401 时强制重登一次。
 */
export async function getGmdCookieHeader(
  config: GoMusicDlConfig,
  forceRefresh = false,
): Promise<Record<string, string>> {
  if (!hasCredentials(config)) return {}
  if (!forceRefresh) {
    const cached = await readCachedSession()
    if (cached) return { Cookie: `${GMD_SESSION_COOKIE}=${cached.cookie}` }
  }
  const cookie = await loginAndCache(config)
  await writeCachedSession(cookie)
  return { Cookie: `${GMD_SESSION_COOKIE}=${cookie}` }
}

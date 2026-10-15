// 扫码登录转发：go-music-dl 侧已实现完整扫码链路（internal/web/qr_login.go，
// 基于 music-lib 各平台 CreateQRLogin/CheckQRLogin），Cookie 由 gmd 自己落库，
// 本插件只做「创建会话 → 展示二维码 → 轮询状态」的 UI 代理，不经手任何凭据。
//
// 上游契约（music-lib/model/login.go）：
//   POST /qr_login/:source        → QRLoginSession { source, key, url, image_url?, expires_at? }
//   GET  /qr_login/:source?key=   → QRLoginResult { status: waiting|scanned|success|expired|failed,
//                                    message?, extra? }（success 时 gmd 自动保存 Cookie 并回写
//                                    extra.cookie_saved=true）
// 支持源（core/service.go GetQRLoginCreateFunc）：netease/qq/qq_wx/kugou/bilibili/soda；
// soda 走短信验证分支（上游 Web 端也临时隐藏入口），本插件不接入。

import { normalizeBaseUrl, GoMusicDlConfig } from './config'
import { getGmdCookieHeader, clearCachedSession } from './gmd-auth'

export interface QRSourceInfo {
  source: string
  name: string
}

export interface QRSession {
  source: string
  key: string
  /** 待编码内容（平台登录 URL）；qq/qq_wx/soda 另有 image_url 可直接展示 */
  url: string
  image_url?: string
  expires_at?: number
}

export interface QRResult {
  status: string
  message?: string
  extra?: Record<string, string>
}

/** 与 gmd Web 端扫码入口一致（core.GetQRLoginCreateFunc），排除 soda（短信分支未调通） */
export const QR_SOURCES: QRSourceInfo[] = [
  { source: 'netease', name: '网易云音乐' },
  { source: 'qq', name: 'QQ 音乐' },
  { source: 'qq_wx', name: 'QQ 音乐（微信）' },
  { source: 'kugou', name: '酷狗音乐' },
  { source: 'bilibili', name: 'Bilibili' },
]

/** 与 client.ts fetchText 同款错误口径（401=开启了登录鉴权 / 404=Base Path 不对） */
async function requestJson(
  url: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
  cookieHeader: Record<string, string> = {},
): Promise<any> {
  let res: any
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Fetch-Timeout-Ms': String(Math.min(30000, Math.max(100, timeoutMs))),
        ...cookieHeader,
      },
    })
  } catch (e: any) {
    throw new Error('无法连接 go-music-dl: ' + (e?.message || String(e)))
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = (j && (j.error || j.message)) || ''
    } catch {
      /* 非 JSON 响应体 */
    }
    if (res.status === 401) {
      throw new GmdAuthError(
        detail ||
          'go-music-dl 已开启登录鉴权：请在插件设置→账号登录中填写 gmd 管理员账号，或在 gmd 端关闭登录',
      )
    }
    if (res.status === 404) {
      throw new Error('接口不存在 (404)：请确认服务地址与 Base Path 配置正确')
    }
    throw new Error(detail || `go-music-dl 请求失败: HTTP ${res.status}`)
  }
  return res.json()
}

/** 401（gmd 鉴权失败）专用错误：调用方据此触发「重登一次」重试 */
export class GmdAuthError extends Error {}

/** 带鉴权的请求：有凭据时自动登录/复用 session，401 时强制重登一次再试 */
async function requestJsonWithAuth(
  url: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
  config: GoMusicDlConfig,
): Promise<any> {
  const cookieHeader = await getGmdCookieHeader(config).catch(() => ({}))
  try {
    return await requestJson(url, method, timeoutMs, cookieHeader)
  } catch (e) {
    if (!(e instanceof GmdAuthError)) throw e
    // session 失效/凭据未登录：清缓存重登一次；再 401 则把凭据层错误抛给用户
    await clearCachedSession()
    const fresh = await getGmdCookieHeader(config, true)
    if (!fresh.Cookie) throw e
    return await requestJson(url, method, timeoutMs, fresh)
  }
}

function qrBase(config: { baseUrl: string; basePath?: string }): string {
  return normalizeBaseUrl(config.baseUrl, config.basePath)
}

/** 创建扫码会话（转发 gmd POST /qr_login/:source，开启鉴权的实例自动带 session） */
export async function qrStart(
  source: string,
  config: GoMusicDlConfig,
  timeoutMs = 15000,
): Promise<QRSession> {
  const base = qrBase(config)
  const data = await requestJsonWithAuth(
    `${base}/qr_login/${encodeURIComponent(source)}`,
    'POST',
    timeoutMs,
    config,
  )
  if (!data || !data.key) {
    throw new Error((data && data.error) || '二维码创建失败：上游未返回会话 key')
  }
  return {
    source: String(data.source || source),
    key: String(data.key),
    url: String(data.url || ''),
    image_url: data.image_url ? String(data.image_url) : undefined,
    expires_at: Number(data.expires_at) || 0,
  }
}

/** 轮询扫码状态（转发 gmd GET /qr_login/:source?key=）。轮询频繁，超时给短（8s）。 */
export async function qrPoll(
  source: string,
  key: string,
  config: GoMusicDlConfig,
  timeoutMs = 8000,
): Promise<QRResult> {
  const base = qrBase(config)
  const data = await requestJsonWithAuth(
    `${base}/qr_login/${encodeURIComponent(source)}?key=${encodeURIComponent(key)}`,
    'GET',
    timeoutMs,
    config,
  )
  return {
    status: String((data && data.status) || 'failed'),
    message: data && data.message ? String(data.message) : undefined,
    extra: data && data.extra && typeof data.extra === 'object' ? data.extra : undefined,
  }
}

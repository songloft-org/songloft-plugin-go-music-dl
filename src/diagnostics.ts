// 服务/凭据体检（只读）：给设置页一份「可达性 + 各平台 Cookie 是否配置」的快照。
//
// 只读、不修复、不写任何上游状态。两个后端的契约不同：
//   gmd：GET /music/healthz 免鉴权探活；GET /music/cookies 需 music_dl_session，
//        且上游「未初始化管理员账号」时 authRequired 也会返回 401 {setupRequired:true}
//        （internal/web/auth.go），这是正常家用部署，不能误报成凭据失效。
//   api：无 /healthz；GET /api/v1/system/cookies 既免鉴权又是 Cookie 快照。

import {
  GoMusicDlConfig,
  normalizeBaseUrl,
  rootBaseUrl,
  isApiBackend,
} from './config'
import { getGmdCookieHeader } from './gmd-auth'

export type DiagnosticState =
  | 'unreachable'
  | 'no_auth_setup'
  | 'no_admin_credentials'
  | 'ready'
  | 'unknown'

export interface DiagnosticResult {
  ok: boolean
  backend: 'gmd' | 'api'
  state: DiagnosticState
  message: string
  /** 检测到已配置 Cookie 的平台（只读展示，不含 Cookie 内容） */
  sources?: string[]
}

export interface JsonResponseLike {
  status: number
  data: any
}

export type JsonRequester = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<JsonResponseLike>

export interface DiagnoseDeps {
  request?: JsonRequester
  cookieHeaders?: (config: GoMusicDlConfig) => Promise<Record<string, string>>
}

const TIMEOUT_MS = 5000

/** 探活 URL：gmd 走 /healthz，api 走免鉴权的 system/cookies。 */
export function probeUrl(config: GoMusicDlConfig): string {
  if (isApiBackend(config)) {
    const root = rootBaseUrl(config.baseUrl)
    return root ? `${root}/api/v1/system/cookies` : ''
  }
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  return base ? `${base}/healthz` : ''
}

/** Cookie 快照 URL；api 模式与探活同一个端点。 */
export function cookiesUrl(config: GoMusicDlConfig): string {
  if (isApiBackend(config)) return probeUrl(config)
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  return base ? `${base}/cookies` : ''
}

/** 兼容上游三种返回形态：裸 map / {cookies:map} / {code,data:map}。 */
export function collectCookieSources(data: any): string[] {
  const root = data && typeof data === 'object' ? data : {}
  const map =
    root.cookies && typeof root.cookies === 'object'
      ? root.cookies
      : root.data && typeof root.data === 'object'
        ? root.data
        : root
  if (!map || typeof map !== 'object') return []
  return Object.keys(map)
    .filter((k) => typeof map[k] === 'string' && map[k].trim())
    .sort()
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonResponseLike> {
  const res: any = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'X-Fetch-Timeout-Ms': String(timeoutMs),
      ...headers,
    },
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status || 0, data }
}

function unreachable(backend: 'gmd' | 'api', detail: string): DiagnosticResult {
  return {
    ok: false,
    backend,
    state: 'unreachable',
    message: `无法连接上游服务：${detail}`,
  }
}

function ready(backend: 'gmd' | 'api', sources: string[]): DiagnosticResult {
  return {
    ok: true,
    backend,
    state: 'ready',
    message: sources.length
      ? `服务可达；已配置 ${sources.length} 个平台 Cookie：${sources.join('、')}`
      : '服务可达；尚未检测到任何平台 Cookie（无损音质/账号歌单可能需要扫码登录）',
    sources,
  }
}

export async function diagnose(
  config: GoMusicDlConfig,
  deps: DiagnoseDeps = {},
): Promise<DiagnosticResult> {
  const backend: 'gmd' | 'api' = isApiBackend(config) ? 'api' : 'gmd'
  const request = deps.request || fetchJson
  const url = probeUrl(config)
  if (!url) {
    return unreachable(backend, '请先在设置中填写服务地址')
  }

  let probe: JsonResponseLike
  try {
    probe = await request(url, {}, TIMEOUT_MS)
  } catch (e: any) {
    return unreachable(backend, (e && e.message) || String(e))
  }

  if (backend === 'api') {
    if (probe.status === 200) return ready('api', collectCookieSources(probe.data))
    if (probe.status === 401 || probe.status === 403) {
      return {
        ok: true,
        backend,
        state: 'no_admin_credentials',
        message: '服务可达，但 Cookie 查询被拒绝；请检查 go-music-api 的部署配置',
      }
    }
    return unreachable(backend, `探活返回 HTTP ${probe.status}`)
  }

  // gmd：先探活，再查 Cookie（后者需要 session）
  if (probe.status < 200 || probe.status >= 300) {
    return unreachable(backend, `/healthz 返回 HTTP ${probe.status}（请检查服务地址与 Base Path）`)
  }
  const headers = await (deps.cookieHeaders || getGmdCookieHeader)(config).catch(() => ({}))
  let r: JsonResponseLike
  try {
    r = await request(cookiesUrl(config), headers, TIMEOUT_MS)
  } catch (e: any) {
    return {
      ok: true,
      backend,
      state: 'unknown',
      message: `服务可达，但 Cookie 查询失败：${(e && e.message) || String(e)}`,
    }
  }
  if (r.status === 200) return ready('gmd', collectCookieSources(r.data))
  if (r.status === 401) {
    if (r.data && r.data.setupRequired === true) {
      return {
        ok: true,
        backend,
        state: 'no_auth_setup',
        message:
          '服务可达；上游未初始化管理员账号（未启用登录鉴权），属正常家用部署。此状态下无法读取平台 Cookie，如需无损/账号歌单请直接在插件内扫码登录。',
      }
    }
    return {
      ok: true,
      backend,
      state: 'no_admin_credentials',
      message: '服务可达；Cookie 查询需要管理员登录，请在「账号登录」填写管理员账号后重试，或关闭上游登录鉴权。',
    }
  }
  return {
    ok: true,
    backend,
    state: 'unknown',
    message: `服务可达，但上游 Cookie 接口返回 HTTP ${r.status}（可能是旧版本上游）`,
  }
}

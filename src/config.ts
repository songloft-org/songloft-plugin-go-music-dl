// Go Music DL 插件配置
// 运行时由 Songloft 注入全局 songloft，这里仅做类型引用。

export interface GoMusicDlConfig {
  /** go-music-dl 服务地址（根地址即可，例如 http://你的服务器地址:8080 或 http://127.0.0.1:58091）；插件会自动补 /music 前缀 */
  baseUrl: string
  /** 参与搜索的音源列表 */
  sources: string[]
  /** 请求超时时间（毫秒），目前仅作记录，沙箱内未强制中断 */
  timeout: number
}

const CONFIG_KEY = 'gomusicdl_config'

export // 与 go-music-dl 的 GetAllSourceNames 保持一致（排除 local 本地音乐，非在线音源平台）
const DEFAULT_SOURCES = [
  'netease', 'qq', 'kugou', 'kuwo', 'migu', 'fivesing',
  'jamendo', 'joox', 'qianqian', 'soda', 'bilibili', 'apple',
]

const DEFAULT_CONFIG: GoMusicDlConfig = {
  baseUrl: 'http://127.0.0.1:58091',
  sources: [...DEFAULT_SOURCES],
  timeout: 15000,
}

/**
 * 归一化 go-music-dl 地址：go-music-dl 的所有 Web 接口都在 /music 前缀下
 * （源码常量 RoutePrefix = "/music"）。无论用户填的是根地址还是已带 /music，
 * 这里都规整成「…/music」形式，避免拼出 /search 这类不存在的路由导致 404→500。
 */
export function normalizeBaseUrl(raw: string): string {
  let u = (raw || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/\/music$/.test(u)) u += '/music'
  return u
}

export async function getConfig(): Promise<GoMusicDlConfig> {
  try {
    const val = await (globalThis as any).songloft?.storage?.get(CONFIG_KEY)
    if (val) {
      const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(val as string) }
      if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
        parsed.sources = [...DEFAULT_SOURCES]
      }
      if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) {
        parsed.baseUrl = DEFAULT_CONFIG.baseUrl
      }
      parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl)
      return parsed
    }
  } catch (err) {
    console.error('Failed to get go-music-dl config', String(err))
  }
  return DEFAULT_CONFIG
}

export async function saveConfig(config: GoMusicDlConfig): Promise<void> {
  const s = (globalThis as any).songloft?.storage
  if (s) {
    await s.set(CONFIG_KEY, JSON.stringify(config))
  }
}

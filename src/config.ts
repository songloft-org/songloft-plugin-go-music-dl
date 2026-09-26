// Go Music DL 插件配置
// 运行时由 Songloft 注入全局 songloft，这里仅做类型引用。

export interface GoMusicDlConfig {
  /** go-music-dl 内网/默认服务地址（根地址即可，例如 http://192.168.1.190:8080）；插件会自动补 /music 前缀。后端调用与外网访问时未配置外网地址均走它。留空表示未配置（前端各入口会提示填写） */
  baseUrl: string
  /** 外网访问时前端使用的地址（可选）。当主程序通过公网域名/IP 被外网访问时，前端自动改用此地址直连 go-music-dl；留空则内外网都用 baseUrl */
  externalBaseUrl?: string
  /** 对外可达的 Songloft 主机地址（音箱访问本插件 /stream 路由用，可选）。
   *  留空则自动推导（baseUrl host / getHostUrl / 网卡地址），但自动推导在
   *  部分运行时只能拿到回环地址，此时音箱仍无法播放。形如 http://192.168.1.190:58091。 */
  serverHost?: string
  /** 参与搜索的音源列表 */
  sources: string[]
}

const CONFIG_KEY = 'gomusicdl_config'

export // 与 go-music-dl 的 GetAllSourceNames 保持一致（排除 local 本地音乐，非在线音源平台）
const DEFAULT_SOURCES = [
  'netease', 'qq', 'kugou', 'kuwo', 'migu', 'fivesing',
  'jamendo', 'joox', 'qianqian', 'soda', 'bilibili', 'apple',
]

const DEFAULT_CONFIG: GoMusicDlConfig = {
  // 不预置地址：127.0.0.1:58091 是宿主 Songloft 的端口而非 go-music-dl 的，
  // 预置会让首次使用的用户误以为已就绪；留空时前端各入口会提示填写。
  baseUrl: '',
  externalBaseUrl: '',
  sources: [...DEFAULT_SOURCES],
}

/**
 * 归一化 go-music-dl 地址：go-music-dl 的所有 Web 接口都在 /music 前缀下
 * （源码常量 RoutePrefix = "/music"）。无论用户填的是根地址还是已带 /music，
 * 这里都规整成「…/music」形式，避免拼出 /search 这类不存在的路由导致 404→500。
 * 注意：前端 WebView 侧在 static/js/api.js 有一份同实现拷贝（QuickJS/WebView
 * 两个运行时无法共享模块），修改时两处需同步。
 */
export function normalizeBaseUrl(raw: string): string {
  let u = (raw || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/\/music$/.test(u)) u += '/music'
  return u
}

/** 归一化对外可达地址：去首尾空白与结尾斜杠（不做 /music 补全，因为这是 Songloft 主机地址，不是 go-music-dl 后端地址）。 */
export function normalizeServerHost(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '')
}

/** 归一化任意部分配置：缺省字段补默认值，各地址字段按类型收口。 */
export function normalizeConfig(raw: Partial<GoMusicDlConfig>): GoMusicDlConfig {
  const parsed = { ...DEFAULT_CONFIG, ...raw }
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    parsed.sources = [...DEFAULT_SOURCES]
  }
  if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) {
    parsed.baseUrl = DEFAULT_CONFIG.baseUrl
  }
  parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl)
  // 外网地址：可选；非字符串或空值归一为 ''，否则同样补 /music 前缀
  if (typeof parsed.externalBaseUrl === 'string' && parsed.externalBaseUrl) {
    parsed.externalBaseUrl = normalizeBaseUrl(parsed.externalBaseUrl)
  } else {
    parsed.externalBaseUrl = ''
  }
  // 对外可达地址：可选；非字符串或空值归一为 ''，仅去空白与结尾斜杠（不补 /music）
  if (typeof parsed.serverHost === 'string' && parsed.serverHost) {
    parsed.serverHost = normalizeServerHost(parsed.serverHost)
  } else {
    parsed.serverHost = ''
  }
  return parsed
}

// 宿主 songloft.storage 无缓存（每 key 一个文件、每次 get 都是异步 bridge 往返 +
// os.ReadFile），而 getConfig 处在搜索/topone/歌词/stream 等每个请求的热路径上，
// 故进程内 memo 一份归一化结果；saveConfig 时同步更新，插件被驱逐重载后自然重建。
let cachedConfig: GoMusicDlConfig | null = null

export async function getConfig(): Promise<GoMusicDlConfig> {
  if (cachedConfig) return cachedConfig
  try {
    const val = await (globalThis as any).songloft?.storage?.get(CONFIG_KEY)
    if (val) {
      cachedConfig = normalizeConfig(JSON.parse(val as string))
      return cachedConfig
    }
  } catch (err) {
    console.error('Failed to get go-music-dl config', String(err))
  }
  cachedConfig = { ...DEFAULT_CONFIG, sources: [...DEFAULT_SOURCES] }
  return cachedConfig
}

export async function saveConfig(config: GoMusicDlConfig): Promise<void> {
  // 存储前归一化（baseUrl 补 /music 等），保证「落盘内容 = 内存缓存内容」，
  // 避免 save 后直接读缓存与下次启动从盘上读归一化结果不一致。
  const normalized = normalizeConfig(config)
  const s = (globalThis as any).songloft?.storage
  if (s) {
    await s.set(CONFIG_KEY, JSON.stringify(normalized))
  }
  cachedConfig = normalized
}

// 与 go-music-dl core.GetDefaultSourceNames 对齐的「快源」子集：上游网页端歌曲搜索
// 默认只开这 8 个（排除 bilibili/joox/jamendo/fivesing 这些慢/小众源，上游 /music/search
// 对单源无超时、最坏可拖 2 分钟）。供 topone（miot 仅等 6s）、宿主 L2 fallback（5s）、
// 歌词搜索（15s）等严格预算链路收窄扇出面；插件页面搜索仍按用户勾选的全量音源。
export const FAST_SOURCES = [
  'netease', 'qq', 'kugou', 'kuwo', 'migu', 'qianqian', 'soda', 'apple',
]

/**
 * 严格预算链路（topone / 宿主 fallback / 歌词搜索）用的音源子集：
 * 取用户已启用音源与 FAST_SOURCES 的交集（尊重用户关停某快源的选择）；
 * 交集为空（用户只勾了慢源）时退回用户全量配置，保证功能不被砍死。
 */
export function hotPathSources(config: GoMusicDlConfig): string[] {
  const enabled = new Set(config.sources || [])
  const fast = FAST_SOURCES.filter((s) => enabled.has(s))
  if (fast.length) return fast
  return config.sources && config.sources.length
    ? [...config.sources]
    : [...DEFAULT_SOURCES]
}

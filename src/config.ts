// Go Music DL 插件配置
// 运行时由 Songloft 注入全局 songloft，这里仅做类型引用。

export interface GoMusicDlConfig {
  /** go-music-dl 内网/默认服务地址（根地址即可，例如 http://192.168.1.190:8080）；插件会按 basePath 拼接前缀。后端调用与外网访问时未配置外网地址均走它。留空表示未配置（前端各入口会提示填写） */
  baseUrl: string
  /** go-music-dl Web 服务的挂载路径（Base Path），默认 /music。
   *  上游启动时可用 --base-path 修改（如 /dl），此时必须在此填相同值。
   *  注意：baseUrl 保存的是根地址，运行时由 normalizeBaseUrl(root, basePath) 拼接。 */
  basePath?: string
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

/**
 * 归一化 Base Path：上游 go-music-dl 的 RoutePrefix 默认 "/music"（internal/web
 * DefaultRoutePrefix），启动时可用 --base-path 修改（NormalizeBasePath：空回退默认、
 * 补前导斜杠）。这里对齐上游规则：空值→默认 /music，去空白/结尾斜杠、补前导斜杠。
 */
export const DEFAULT_BASE_PATH = '/music'

export function normalizeBasePath(raw?: string): string {
  let p = (raw || '').trim().replace(/\/+$/, '')
  if (!p) return DEFAULT_BASE_PATH
  if (!p.startsWith('/')) p = '/' + p
  return p
}

export // 与 go-music-dl 的 GetAllSourceNames 保持一致（排除 local 本地音乐，非在线音源平台）
const DEFAULT_SOURCES = [
  'netease', 'qq', 'kugou', 'kuwo', 'migu', 'fivesing',
  'jamendo', 'joox', 'qianqian', 'soda', 'bilibili', 'apple',
]

const DEFAULT_CONFIG: GoMusicDlConfig = {
  // 不预置地址：127.0.0.1:58091 是宿主 Songloft 的端口而非 go-music-dl 的，
  // 预置会让首次使用的用户误以为已就绪；留空时前端各入口会提示填写。
  baseUrl: '',
  basePath: DEFAULT_BASE_PATH,
  externalBaseUrl: '',
  sources: [...DEFAULT_SOURCES],
}

/**
 * 归一化 go-music-dl 地址：baseUrl 保存的是根地址，运行时拼接 basePath
 * （默认 /music）。已以 basePath 结尾时幂等不重复追加，兼容手填完整地址。
 * 注意：前端 WebView 侧在 static/js/api.js 有一份同实现拷贝（QuickJS/WebView
 * 两个运行时无法共享模块），修改时两处需同步。
 */
export function normalizeBaseUrl(raw: string, basePath?: string): string {
  let u = (raw || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  const bp = normalizeBasePath(basePath)
  if (!u.endsWith(bp)) u += bp
  return u
}

/** 归一化对外可达地址：去首尾空白与结尾斜杠（不做 /music 补全，因为这是 Songloft 主机地址，不是 go-music-dl 后端地址）。 */
export function normalizeServerHost(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '')
}

/** 归一化任意部分配置：缺省字段补默认值，各地址字段按类型收口。 */
export function normalizeConfig(raw: Partial<GoMusicDlConfig>): GoMusicDlConfig {
  // 旧版（无 basePath 字段）落盘的 baseUrl/externalBaseUrl 是「root + /music」
  // 强制追加形式：剥离结尾 /music 还原为根地址，迁移到 root + basePath 两字段模型。
  // 仅旧数据做一次剥离（新数据 basePath 字段总是存在）。
  const legacy = raw && raw.basePath === undefined
  const stripLegacyMusic = (u: unknown): string =>
    typeof u === 'string' ? u.trim().replace(/\/+$/, '').replace(/\/music$/, '') : ''
  const parsed = {
    ...DEFAULT_CONFIG,
    ...raw,
    baseUrl: legacy ? stripLegacyMusic(raw.baseUrl) : (typeof raw?.baseUrl === 'string' ? raw.baseUrl : ''),
    externalBaseUrl: legacy ? stripLegacyMusic(raw.externalBaseUrl) : (typeof raw?.externalBaseUrl === 'string' ? raw.externalBaseUrl : ''),
  }
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    parsed.sources = [...DEFAULT_SOURCES]
  }
  // baseUrl/externalBaseUrl 恒为根地址（落盘/缓存/get 返回统一 root 语义），
  // 运行时由各使用点 normalizeBaseUrl(root, basePath) 拼接——这样 UI 显示根地址，
  // 用户修改 basePath 时无需同步改动 baseUrl，不产生「/music/dl」拼接陷阱。
  if (typeof parsed.baseUrl !== 'string') parsed.baseUrl = ''
  parsed.baseUrl = parsed.baseUrl.trim().replace(/\/+$/, '')
  // 外网地址：可选，同样恒为根地址
  if (typeof parsed.externalBaseUrl !== 'string') parsed.externalBaseUrl = ''
  parsed.externalBaseUrl = parsed.externalBaseUrl.trim().replace(/\/+$/, '')
  // basePath：独立挂载路径字段（默认 /music）
  parsed.basePath = normalizeBasePath(parsed.basePath)
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
  cachedConfig = { ...DEFAULT_CONFIG, basePath: DEFAULT_BASE_PATH, sources: [...DEFAULT_SOURCES] }
  return cachedConfig
}

export async function saveConfig(config: GoMusicDlConfig): Promise<void> {
  // 存储前归一化（basePath 收口、地址根化/旧数据剥离等），保证「落盘内容 = 内存缓存内容」，
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

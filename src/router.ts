import {
  createRouter,
  jsonResponse,
  createSearchHandler,
  parseQuery,
} from '@songloft/plugin-sdk'
import type { HTTPRequest, SearchResultItem } from '@songloft/plugin-sdk'
import { getConfig, saveConfig, GoMusicDlConfig, hotPathSources, applyDefaultQuality, isApiBackend } from './config'
import {
  searchSongs,
  searchSongsPage,
  searchCollectionsPage,
  buildDownloadUrl,
  buildCoverProxyUrl,
  fetchLyric,
  fetchLyricRaw,
  fetchTopLists,
  fetchTopListSongs,
  fetchDownloadRecords,
  fetchRecommendApi,
  fetchCategoriesApi,
  fetchCategoryPlaylistsApi,
  fetchUserPlaylistsApi,
  fetchCollectionSongsApi,
  GoSong,
  GoTopList,
} from './client'
import { TTLCache } from './cache'
import {
  classifyLyricFormat,
  collapseKaraokeToLines,
  karaokeToLxLyric,
} from './lyrics-format'
import { encodeToken, decodeToken, loopbackToLan } from './bridge-contract'
import { toGoSong } from './client'
import { callHostApi } from './host'
import { QR_SOURCES, qrStart, qrPoll } from './qrlogin'
import { clearCachedSession } from './gmd-auth'
import type { QRSession } from './qrlogin'
import {
  probeDownloadable,
  resolveImportableItem,
  importRemoteSongs,
  importRemoteSong,
  dedupKeyOf,
  BATCH_DEADLINE_MS,
  mapWithConcurrency,
} from './import-core'
import type { SongItem } from './import-core'
import {
  beginSyncSession,
  stepSyncSession,
  SyncSessionNotFound,
  listBindings,
} from './sync'

function toSearchItem(s: GoSong, config?: GoMusicDlConfig): SearchResultItem {
  return {
    title: s.name,
    artist: s.artist || 'Unknown',
    album: s.album || '',
    duration: s.duration,
    cover_url: s.cover || undefined,
    source_data: {
      id: s.id,
      source: s.source,
      name: s.name,
      artist: s.artist,
      album: s.album,
      duration: s.duration,
      cover: s.cover,
      extra: config ? applyDefaultQuality(s.source, s.extra, config) : s.extra,
    },
  }
}

// ---------- 进程内 TTL 缓存（插件被宿主空闲驱逐重载后随 VM 重建） ----------
// 搜索类：上游单曲搜索是「全量搜完再内存切片」，相同关键词重复搜索/翻页代价高
//   → 60s 短缓存（避免用户改源勾选后结果长时间陈旧；POST /config 时主动清空）。
// 回搜命中（歌词/封面共用同一「按标题+歌手回搜」）：10min。
// 歌词/封面结果：内容不变 → 24h。
const searchCache = new TTLCache<SearchResultItem[]>(60_000, 100) // 宿主 L2 /api/search
const pageSearchCache = new TTLCache<any>(60_000, 100) // 插件页 /search
const toponeCache = new TTLCache<any>(60_000, 100) // topone（miot）
const hitCache = new TTLCache<GoSong>(600_000, 100) // 回搜命中
const lyricCache = new TTLCache<Record<string, string>>(86_400_000, 200) // lyric-search 结果
const lyricProxyCache = new TTLCache<string>(86_400_000, 200) // /api/lyric（前端）
const coverCache = new TTLCache<string>(86_400_000, 200) // cover-search 结果
// 回搜/取词失败短缓存（网络抖动、上游 5xx）：上游持续故障期间避免每次宿主调用
// 都重新回搜（无正结果的兜底，60s 后自动重试）；与确定性"无歌词/无封面"（写主缓存）区分
const searchFailCache = new TTLCache<true>(60_000, 50)
const toplistCache = new TTLCache<GoTopList[]>(600_000, 10) // 榜单目录（变化慢）
const toplistSongsCache = new TTLCache<GoSong[]>(300_000, 50) // 榜单歌曲
const dlRecordsCache = new TTLCache<Record<string, boolean>>(600_000, 2) // 已下载标记（key 归一化）

function clearCaches(): void {
  searchCache.clear()
  pageSearchCache.clear()
  toponeCache.clear()
  hitCache.clear()
  lyricCache.clear()
  lyricProxyCache.clear()
  coverCache.clear()
  toplistCache.clear()
  toplistSongsCache.clear()
  dlRecordsCache.clear()
}

/**
 * 按「标题+歌手」回搜歌曲（歌词/封面提供者共用）。
 * 宿主只传元数据无 source_data，需回搜后取词/封面；命中结果短期缓存，
 * 同一首歌的歌词与封面回搜共享，第二次调用零上游开销。
 * in-flight 去重：宿主可能并发调用 lyric-search 与 cover-search（同一首歌），
 * 未命中缓存时两个请求会各搜一次——用 pending Map 合并为一次上游搜索。
 */
const hitPending = new Map<string, Promise<GoSong | null>>()

async function findHitByTitleArtist(
  title: string,
  artist: string,
  config: GoMusicDlConfig,
): Promise<GoSong | null> {
  const hitKey = `hit|${title}|${artist}`
  const cached = hitCache.get(hitKey)
  if (cached) return cached
  const inflight = hitPending.get(hitKey)
  if (inflight) return inflight
  const pending = (async (): Promise<GoSong | null> => {
    try {
      // 宿主歌词提供者预算 15s/提供者（manager.go SearchLyrics）：
      // 搜索 8s + 取词 5s，源集收窄为快源子集，确保整套「回搜→取词」能在预算内完成
      const songs = await searchSongs(
        `${title} ${artist}`.trim(),
        { ...config, sources: hotPathSources(config) },
        1,
        5,
        8000,
      )
      const hit =
        songs.find((s) => s.name.includes(title) || title.includes(s.name)) ||
        songs[0] ||
        null
      if (hit) hitCache.set(hitKey, hit)
      return hit
    } finally {
      hitPending.delete(hitKey)
    }
  })()
  hitPending.set(hitKey, pending)
  return pending
}

// Uint8Array → string：String.fromCharCode.apply 展开大数组会超出 QuickJS 的
// 参数上限（/import/batch 的 body 可达几十 KB，直接 apply 会抛错导致整批 500），
// 逐 8KB 块拼接规避。
function bytesToString(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    )
  }
  return out
}

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {}
  try {
    const str =
      typeof req.body === 'string'
        ? req.body
        : bytesToString(req.body as Uint8Array)
    return JSON.parse(str)
  } catch {
    return {}
  }
}

interface DownloadRequest {
  item?: SongItem
}

const router = createRouter()

// 获取配置
router.get('/config', async () => {
  const config = await getConfig()
  return jsonResponse(config)
})

// 保存配置
router.post('/config', async (req: HTTPRequest) => {
  const data = parseBody(req) as Partial<GoMusicDlConfig>
  const config = await getConfig()
  const newConfig = { ...config, ...data }
  await saveConfig(newConfig)
  // 配置变化（地址/音源/音质/凭据）会使已缓存结果的输入失效，全部清空；
  // gmd session 缓存一并失效（凭据可能已更换，避免沿用旧会话）
  clearCaches()
  await clearCachedSession()
  return jsonResponse({ success: true, config: newConfig })
})

// 全局搜索（Songloft 主程序调用）。
// 宿主只在本插件作为 L2 兜底源时才调用该端点，单插件预算仅 5s
// （internal/services/source/resolver.go DefaultResolverOpts），故源集收窄为
// 快源子集、fetch 超时 4s，确保能在预算内返回。
router.post('/api/search', createSearchHandler({
  search: async (keyword: string, page = 1, pageSize = 20) => {
    const config = await getConfig()
    const cacheKey = `${keyword}|${page}|${pageSize}`
    const cached = searchCache.get(cacheKey)
    if (cached) return cached
    const songs = await searchSongs(
      keyword,
      { ...config, sources: hotPathSources(config) },
      page,
      pageSize,
      4000,
    )
    const items = songs.map((s) => toSearchItem(s, config))
    searchCache.set(cacheKey, items)
    return items
  },
}))

// 播放直链解析
// go-music-dl 无需登录鉴权，直接返回直链即可（宿主会代理播放/下载）。
router.post('/api/music/url', async (req: HTTPRequest) => {
  let body: Record<string, unknown> = {}
  if (req.body) {
    try {
      body =
        typeof req.body === 'string' ? JSON.parse(req.body) : {}
    } catch {
      return jsonResponse({ error: 'invalid json body' }, 400)
    }
  }
  let sourceData: Record<string, unknown> | undefined =
    body.source_data as Record<string, unknown> | undefined
  if (typeof sourceData === 'string') {
    try {
      sourceData = JSON.parse(sourceData) as Record<string, unknown>
    } catch {
      sourceData = undefined
    }
  }
  if (!sourceData || typeof sourceData !== 'object' || Array.isArray(sourceData)) {
    return jsonResponse({ error: 'source_data is required' }, 400)
  }
  const config = await getConfig()
  const song = toGoSong(sourceData)
  try {
    const url = buildDownloadUrl(
      {
        ...song,
        // 网易云且未显式带 level 时注入默认音质（覆盖导入时未带品质的存量歌曲）
        extra: applyDefaultQuality(song.source, song.extra, config),
      },
      config.baseUrl,
      config.basePath,
      true, // embed=1：宿主播放/下载都走「完整下载再回吐」，避免断流导致下载失败
    )
    if (!url) {
      return jsonResponse({ error: 'source_not_available' }, 404)
    }
    return jsonResponse({ url })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 自身实现「音箱可直连的 stream URL」：
// 把歌曲打包成 base64url token，拼出指向本插件 /stream/:token 的对外 URL。
// 音箱访问该 URL → 本插件 /stream 路由 decode token + 302 重定向到 go-music-dl
// 真实直链，由音箱直连原生 Go 服务器拉流（支持 Range / 大文件）。
//
// 对外 host 按 4 级优先级推导（与原 bridge buildPublicUrl 等价）：
//   1) config.serverHost —— 用户显式配置的对外可达地址（最稳，覆盖反代/异网场景）
//   2) baseUrl 的 host —— go-music-dl 后端若部署在 LAN 某台机器（如 192.168.1.190:8080），
//      则同一台机器跑的 Songloft 也通常可达该 IP（仅端口不同），用 baseUrl host + Songloft 端口
//   3) getHostUrl —— 宿主自身地址（非回环时可用）
//   4) 网卡 LAN 地址 —— 上述均为回环时的兜底，取 getNetworkAddresses()[0] 替换回环主机
// 任一级推导出非回环地址即可用；全失败则返回 null，上层 topone 把 url 置空 → miot 回退入库播放。

function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(host)
}

/** 完整 URL 的回环判定（makeDirectStreamUrl 兜底分支用，与 isLoopbackHost 同一口径） */
function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url)
}

function buildStreamUrl(base: string, token: string): string {
  // base 形如 http://192.168.1.190:58091（已去结尾斜杠）
  return `${base.replace(/\/+$/, '')}/api/v1/jsplugin/go-music-dl/stream/${encodeURIComponent(token)}`
}

async function makeDirectStreamUrl(song: GoSong): Promise<string | null> {
  try {
    const config = await getConfig()
    const token = encodeToken(song)

    // 1) 显式配置的对外可达地址（最高优先）
    if (config.serverHost) {
      return buildStreamUrl(config.serverHost, token)
    }

    // 推导 Songloft 端口（getHostUrl 返回 http://host:port）
    let hostUrl = ''
    let port = ''
    try {
      hostUrl = (await (globalThis as any).songloft?.plugin?.getHostUrl?.()) || ''
      if (hostUrl) port = new URL(hostUrl).port
    } catch {
      /* ignore */
    }
    if (!port) port = hostUrl.startsWith('https') ? '443' : '80'

    // 2) baseUrl 的 host（非回环时最稳：go-music-dl 后端在 LAN 上即代表 Songloft 也在该 IP 可达）
    let baseHost = ''
    try {
      // hostname 不带端口且 IPv6 已去方括号（host.split(':') 会把 IPv6 截成 '['）
      baseHost = new URL(config.baseUrl).hostname
    } catch {
      /* ignore */
    }
    if (baseHost && !isLoopbackHost(baseHost)) {
      const base = `http://${baseHost}:${port}`
      return buildStreamUrl(base, token)
    }
    // （isLoopbackHost 为本文件唯一回环判定实现，两处兜底正则已收敛到此）

    // 3) getHostUrl 本身（非回环时可用）
    let base = ''
    try {
      if (hostUrl) {
        const u = new URL(hostUrl)
        base = `${u.protocol}//${u.host}`
      }
    } catch {
      base = ''
    }

    // 4) 回环则尝试用网卡 LAN 地址替换主机部分（兜底）
    if (isLoopbackUrl(base)) {
      try {
        const addrs = await (globalThis as any).songloft?.plugin?.getNetworkAddresses?.()
        const lan = addrs && addrs[0]
        if (lan) {
          base = base.replace(
            /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/i,
            `$1${lan}$3`,
          )
        }
      } catch {
        /* ignore */
      }
    }

    if (!base) {
      console.log('[stream] no reachable host available (serverHost unset, all detection failed)')
      return null
    }
    if (isLoopbackUrl(base)) {
      // 仍为回环：音箱无法访问，返回 null 让上层回退入库播放
      console.log('[stream] resolved host is still loopback, give up:', base)
      return null
    }
    return buildStreamUrl(base, token)
  } catch (e) {
    console.log(
      '[stream] makeDirectStreamUrl failed:',
      (e as Error)?.message || String(e),
    )
    return null
  }
}

// GET /stream/:token —— 音箱可直连的对外流端点（plugin.json publicPaths 已声明免鉴权）。
// 解码 token → 还原歌曲元数据 → 302 重定向到 go-music-dl 真实直链（stream=1 实时流），
// 由音箱直连原生 Go 服务器拉流（支持 Range / 大文件，不经 QuickJS 缓冲避免 504）。
router.get('/stream/:token', async (req: HTTPRequest, params: any) => {
  const tok = String(params?.token || '')
  if (!tok) return jsonResponse({ error: 'missing token' }, 400)
  let song: GoSong
  try {
    song = decodeToken<GoSong>(tok)
  } catch {
    return jsonResponse({ error: 'invalid token' }, 400)
  }
  if (!song?.id || !song?.source) {
    return jsonResponse({ error: 'invalid stream token' }, 400)
  }
  try {
    const config = await getConfig()
    // baseUrl 若为回环，需重写成本机 LAN 可达 IP，否则音箱访问不到 go-music-dl 后端
    const baseUrl = await loopbackToLan(config.baseUrl)
    // stream=1：实时流，支持 Range 透传；上游失效时 go-music-dl 返回 404/502，音箱识别为失效
    const upstream = buildDownloadUrl(
      {
        ...song,
        extra: applyDefaultQuality(song.source, song.extra, config),
      },
      baseUrl,
      config.basePath,
      false,
    )
    if (!upstream) {
      return jsonResponse({ error: 'source_not_available' }, 404)
    }
    return {
      statusCode: 302,
      headers: {
        Location: upstream,
        'Cache-Control': 'no-store',
      },
      body: '',
    }
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 为音箱投放生成指向本插件 /stream/:token 的对外直链（前端 cast.js 调用）。
// 宿主网络地址与网卡信息（getHostUrl/getNetworkAddresses）仅后端可得，
// 前端无法自行推导，故由前端把歌曲 POST 上来，这里复用 makeDirectStreamUrl
// 的 4 级 host 推导（serverHost → baseUrl host → 宿主地址 → 网卡 LAN 地址）。
// 推导失败返回 { url: null }，前端据此降级提示——与 topone 直推是同一约束。
router.post('/cast/stream-url', async (req: HTTPRequest) => {
  const body = parseBody(req) as { item?: SongItem }
  const item = body.item
  if (!item || !item.id || !item.source) {
    return jsonResponse({ error: 'item is required' }, 400)
  }
  const song = toGoSong(item)
  try {
    const url = await makeDirectStreamUrl(song)
    return jsonResponse({ url: url || null })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 单首搜索端点（topone）：
// 供 MIoT「智能音箱」插件的外部搜索源调用（相对路径 loopback，无需改 miot 代码）。
// 契约兼容 OnlineSearcher：POST { keyword, hint?, quality? } → { code, msg, data }。
// 返回结果同时携带：
// - url：本插件自实现的 /stream/:token 直链（音箱可直连，无需依赖 bridge 插件）；
//   miot 开启 external_search_no_import 时可据此「不入库直推」播放。
//   推导失败时此字段为空 → miot 不论开关都回退到「入库播放」。
// - source_data：解析型兜底。miot 未开 no_import 或直链不可达时仍可入库，
//   由宿主回源本插件 /api/music/url 播放。
router.post('/api/search/topone', async (req: HTTPRequest) => {
  const body = parseBody(req)
  const keyword = String(body.keyword || '').trim()
  if (!keyword) {
    return jsonResponse({ code: 1, msg: 'empty keyword', data: null })
  }
  const cacheKey = `topone|${keyword}`
  const cached = toponeCache.get(cacheKey)
  if (cached) return jsonResponse(cached)
  try {
    const config = await getConfig()
    // miot 侧 external_search_timeout 默认仅 6s：源集收窄为快源子集（对齐上游
    // GetDefaultSourceNames 的 8 源，尊重用户关停）、fetch 超时 4.5s，
    // 留出重排序与响应余量，避免被 miot 判超时而直接弃用本源。
    // 抓取前 20 条搜索结果，经 sortSongsByRelevance 打分重排序后取第一条最佳匹配
    const songs = await searchSongs(
      keyword,
      { ...config, sources: hotPathSources(config) },
      1,
      20,
      4500,
    )
    if (!songs.length) {
      return jsonResponse({ code: 1, msg: 'no result', data: null })
    }
    const s = songs[0]
    // 返回指向本插件 /stream/:token 的对外直链（音箱可直连）；
    // 推导失败时返回 null → url 置空 → miot 回退入库播放。
    const directUrl = await makeDirectStreamUrl(s)
    const payload = {
      code: 0,
      msg: 'ok',
      data: {
        title: s.name,
        artist: s.artist || '',
        album: s.album || '',
        duration: s.duration || 0,
        cover_url: s.cover || '',
        url: directUrl || '',
        plugin_entry_path: 'go-music-dl',
        source_data: {
          id: s.id,
          source: s.source,
          name: s.name,
          artist: s.artist,
          album: s.album,
          duration: s.duration,
          cover: s.cover,
          extra: applyDefaultQuality(s.source, s.extra, config),
        },
        dedup_key: dedupKeyOf(s.source, s.id),
      },
    }
    toponeCache.set(cacheKey, payload)
    return jsonResponse(payload)
  } catch (e) {
    return jsonResponse({
      code: 1,
      msg: String((e as Error)?.message || e),
      data: null,
    })
  }
})

// 歌词提供者端点：宿主在歌曲无歌词时调用 GET /lyric-search?title=&artist=&album=&duration=
// 返回 LyricPayload 兼容形态：{ lyric, lxlyric? }（宿主 internal/models/lyric.go，
// lxlyric 为逐字歌词，宿主全屏渲染优先消费；未命中返回 { lyric: '' }）。
router.get('/lyric-search', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const title = q.title || ''
  const artist = q.artist || ''
  const album = q.album || ''
  const duration = Number(q.duration) || 0
  const empty = { lyric: '' }
  try {
    const key = `lyric|${title}|${artist}|${album}|${duration}`
    const cached = lyricCache.get(key)
    if (cached) return jsonResponse(cached)
    if (searchFailCache.get(`lyric|${key}`)) return jsonResponse(empty)
    // 宿主仅提供元数据，无 source_data，需按标题+歌手回搜再取歌词
    const hit = await findHitByTitleArtist(title, artist, config)
    if (!hit) {
      lyricCache.set(key, empty)
      return jsonResponse(empty)
    }
    // 一次请求拿原始文本（format=auto 保留 karaoke 逐字格式）：
    // lyric 字段用折叠后的逐行版（宿主逐行渲染会把多时间戳行拆成重复行），
    // karaoke 时另给 lxlyric 逐字版（宿主绝对单尖括号格式，见 lyrics-format.ts）。
    const raw = await fetchLyricRaw(hit, config, 5000)
    if (!raw) {
      lyricCache.set(key, empty)
      return jsonResponse(empty)
    }
    const payload: Record<string, string> =
      classifyLyricFormat(raw) === 'karaoke'
        ? { lyric: collapseKaraokeToLines(raw), lxlyric: karaokeToLxLyric(raw) }
        : { lyric: raw }
    lyricCache.set(key, payload)
    return jsonResponse(payload)
  } catch (e) {
    // 网络错误/上游异常：短缓存失败结果（60s），避免上游故障期间反复回搜
    searchFailCache.set(`lyric|${title}|${artist}|${album}|${duration}`, true)
    return jsonResponse(empty)
  }
})

// 封面提供者端点：宿主对无封面歌曲调用 GET /cover-search?title=&artist=&album=
// （songloft.covers.registerProvider，宿主多提供者取第一个非空 cover_url）。
// 与歌词共用「回搜命中」缓存：同一首歌先查过歌词时，封面回搜零上游开销。
// 返回经 go-music-dl cover_proxy 包装的地址，规避平台封面防盗链 403。
router.get('/cover-search', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const title = q.title || ''
  const artist = q.artist || ''
  try {
    const key = `cover|${title}|${artist}|${q.album || ''}`
    const cached = coverCache.get(key)
    if (cached !== undefined) return jsonResponse({ cover_url: cached })
    if (searchFailCache.get(`cover|${key}`)) return jsonResponse({ cover_url: '' })
    const hit = await findHitByTitleArtist(title, artist, config)
    const coverUrl =
      hit && hit.cover
        ? buildCoverProxyUrl(hit.cover, config.baseUrl, config.basePath, isApiBackend(config))
        : ''
    // 空结果也缓存：无封面歌曲反复触发回搜只会白耗上游
    coverCache.set(key, coverUrl)
    return jsonResponse({ cover_url: coverUrl })
  } catch (e) {
    // 网络错误/上游异常：短缓存失败结果（60s）
    searchFailCache.set(`cover|${title}|${artist}|${q.album || ''}`, true)
    return jsonResponse({ cover_url: '' })
  }
})

// 歌词代理：浏览器直连 go-music-dl 的 /music/lyric 会被 CORS 拦截，
// 故通过同源后端转发（文本，无二进制损坏风险）。
router.get('/api/lyric', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const id = String(q.id || '')
  const source = String(q.source || '')
  if (!id || !source) return jsonResponse({ lyric: '' })
  let extra: Record<string, any> = {}
  try {
    if (q.extra) extra = JSON.parse(String(q.extra))
  } catch {
    extra = {}
  }
  const song: GoSong = {
    id,
    source,
    name: String(q.name || ''),
    artist: String(q.artist || ''),
    album: String(q.album || ''),
    cover: '',
    duration: Number(q.duration) || 0,
    extra,
  }
  // extra 参与缓存 key：上游部分平台（如 kugou）取词依赖 extra 里的歌曲指纹字段
  const cacheKey = `proxy|${id}|${source}|${song.name}|${song.artist}|${song.album}|${song.duration}|${q.extra || ''}`
  const cached = lyricProxyCache.get(cacheKey)
  if (cached !== undefined) return jsonResponse({ lyric: cached })
  try {
    // 前端经网关调用（默认 30s），给 20s 上游预算留响应余量
    const lyric = await fetchLyric(song, config, 20000)
    lyricProxyCache.set(cacheKey, lyric || '')
    return jsonResponse({ lyric: lyric || '' })
  } catch {
    return jsonResponse({ lyric: '' })
  }
})

// 扁平搜索（供插件自有页面使用），带分页，对齐 go-music-dl 网页端。
// type=song（默认）：返回歌曲；type=playlist/album：返回歌单/专辑卡片。
// 返回结构：{ type, items, pagination }，每页条数由 go-music-dl 的 WebPageSize 决定，
// page 用于翻页（?page=N）。
// 注意：主程序全局搜索 (POST /api/search) 仍只返回单曲，此处分支仅服务于页面层。
router.get('/search', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const keyword = q.q || ''
  const type = q.type === 'playlist' || q.type === 'album' ? q.type : 'song'
  const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
  const emptyPagination = {
    page: 1,
    totalPages: 1,
    total: 0,
    pageStart: 0,
    pageEnd: 0,
  }
  if (!keyword) {
    return jsonResponse({ type, items: [], pagination: emptyPagination })
  }
  // 上游分页是「全量搜索后内存切片」，翻页=全量重搜；60s 内同关键词翻页直接复用
  const pageKey = `page|${type}|${keyword}|${page}`
  const cached = pageSearchCache.get(pageKey)
  if (cached) return jsonResponse(cached)
  try {
    if (type === 'song') {
      const { items, pagination } = await searchSongsPage(keyword, config, page)
      const payload = {
        type,
        items: items.map((s) => ({
          id: s.id,
          name: s.name,
          artist: s.artist,
          album: s.album,
          cover: s.cover,
          source: s.source,
          duration: s.duration,
          extra: s.extra,
        })),
        pagination,
      }
      pageSearchCache.set(pageKey, payload)
      return jsonResponse(payload)
    }
    const { items, pagination } = await searchCollectionsPage(
      keyword,
      config,
      type,
      page,
    )
    const payload = {
      type,
      items: items.map((c) => ({
        id: c.id,
        source: c.source,
        title: c.title,
        cover: c.cover,
        creator: c.creator,
        count: c.count,
        contentType: c.contentType,
      })),
      pagination,
    }
    pageSearchCache.set(pageKey, payload)
    return jsonResponse(payload)
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 仅导入：把歌曲作为 remote 歌曲写进 Songloft 曲库（含 source_data）。
// go-music-dl 只做导入；下载（拉流/落盘）交由官方「歌曲下载」插件完成，
// 用户在下载器插件里对 remote 歌曲执行下载即可。
router.post('/import', async (req: HTTPRequest) => {
  const body = parseBody(req) as DownloadRequest
  if (!body.item) {
    return jsonResponse({ error: 'item is required' }, 400)
  }
  try {
    // 导入前校验音源是否真正可取流，拦掉前端 inspect 误判的失效歌曲
    const config = await getConfig()
    if (!config.baseUrl) {
      return jsonResponse({ error: '服务地址未配置，请先在插件设置中填写' }, 400)
    }
    const probe = await probeDownloadable(body.item, config)
    if (probe === 'dead') {
      return jsonResponse(
        { error: '音源已失效，无法导入（该歌曲下载源已不可用）' },
        409,
      )
    }
    const song = await importRemoteSong(body.item)
    const currentSong = await (globalThis as any).songloft.songs.getById(
      song.id,
    )
    return jsonResponse({
      success: true,
      song,
      already_local: currentSong?.type === 'local',
    })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 批量导入：整批一次性写宿主曲库，从 O(N) 串行往返降到 O(N/CHUNK)。
// 容错策略（解决「一首失效歌拖垮整张歌单」）：
//   1) 抽样快速路径——探前 5 首，全可播则整批直接写（秒级，覆盖绝大多数正常歌单）。
//   2) 慢速容错路径——抽样命中失效歌时，逐首做下载可达性探测，
//      可播的歌批量写入，失效/换源的歌直接抛弃（不尝试换源救回，避免 /switch_source
//      极慢卡死把整批拖到网关 504），单独记入 failed 返回，绝不整批取消。
// 网络抖动(unknown)放行，以免误杀慢速但有效的音源。
router.post('/import/batch', async (req: HTTPRequest) => {
  const body = parseBody(req) as { items?: SongItem[] }
  const items = body.items
  if (!Array.isArray(items) || !items.length) {
    return jsonResponse({ error: 'items (array) is required' }, 400)
  }
  try {
    const config = await getConfig()
    const baseUrl = (config.baseUrl || '').replace(/\/+$/, '')
    if (!baseUrl) {
      return jsonResponse({ error: '服务地址未配置' }, 400)
    }
    let okItems: SongItem[]
    let failed: { name: string; reason: string }[] = []
    const sampleSize = Math.min(5, items.length)
    const sampleProbes = await Promise.all(
      items.slice(0, sampleSize).map((it) => probeDownloadable(it, config)),
    )
    if (sampleProbes.some((p) => p === 'dead')) {
      // 抽样命中失效歌：逐首做下载可达性探测（不换源救回），好歌批量写，失效单独报告。
      // 换源/失效歌仅一次轻量探测即判 dead 丢弃，绝不再调慢速的 /switch_source，
      // 避免整批被拖到网关 504；整体仍加时限：超时则放弃未完成项、已探明可播的歌照常写入，
      // 保证正常歌进库、不被网关 504 掐断。
      // 注：QuickJS 运行时无 AbortController，用 { hit } 标志位 + setTimeout 实现时限。
      const deadline = { hit: false }
      const timer = setTimeout(() => {
        deadline.hit = true
      }, BATCH_DEADLINE_MS)
      try {
      const results = await mapWithConcurrency(items, 8, (it) =>
        resolveImportableItem(it, config, deadline),
      )
        okItems = []
        results.forEach((r, idx) => {
          if (r.item) okItems.push(r.item)
          else
            failed.push({
              name: items[idx].name || '',
              reason: r.reason || 'unknown',
            })
        })
      } finally {
        clearTimeout(timer)
      }
    } else {
      okItems = items
    }
    if (!okItems.length) {
      return jsonResponse(
        { error: '全部音源失效或无法换源，已取消导入', failed },
        409,
      )
    }
    const songs = await importRemoteSongs(okItems)
    return jsonResponse({
      success: true,
      count: songs.length,
      songs,
      failed,
    })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 宿主歌单代理（前端经插件后端调用，规避相对路径 404）。
// 列表走 HTTP /api/v1/playlists：本宿主运行时未桥接 SDK 的 songloft.playlists
// 命名空间（直接调用会 500），故用 host url 转发。
// 前端会带 ?_t=Date.now() 防缓存，这里把 query 透传到宿主 URL，破除宿主侧 HTTP 缓存。
// 关键：宿主默认 limit=20 会分页截断（total 可能更大），强制放大 limit 拉全量，
// 否则列表里"后面的歌单不显示"。
router.get('/playlists', async (req: HTTPRequest) => {
  try {
    const query = req.query ? `${req.query}&limit=1000` : 'limit=1000'
    const result = await callHostApi('GET', `/api/v1/playlists?${query}`)
    return jsonResponse(result)
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

router.post('/playlists', async (req: HTTPRequest) => {
  try {
    const data = parseBody(req)
    const result = await callHostApi('POST', '/api/v1/playlists', data)
    return jsonResponse(result)
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

router.post('/playlists/:id/songs', async (req: HTTPRequest, params: any) => {
  try {
    const data = parseBody(req)
    const result = await callHostApi(
      'POST',
      `/api/v1/playlists/${params.id}/songs`,
      data,
    )
    return jsonResponse(result)
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

// ---------- 扫码登录（转发 go-music-dl /qr_login，Cookie 由 gmd 落库，插件不经手凭据） ----------

// 支持扫码的平台列表（与 gmd core.GetQRLoginCreateFunc 对齐，排除 soda 短信分支）
router.get('/qr/sources', async () => {
  return jsonResponse({ sources: QR_SOURCES })
})

// 创建扫码会话：body { source }。返回 { session }（含 url/image_url/key）
router.post('/qr/start', async (req: HTTPRequest) => {
  const body = parseBody(req)
  const source = String(body.source || '').trim()
  if (!source) return jsonResponse({ error: 'source is required' }, 400)
  try {
    const config = await getConfig()
    if (!config.baseUrl) {
      return jsonResponse({ error: '服务地址未配置，请先在设置中填写' }, 400)
    }
    const session: QRSession = await qrStart(source, config)
    return jsonResponse({ session })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      502,
    )
  }
})

// 轮询扫码状态：GET ?source=&key=。返回 { status, message?, cookie_saved? }
router.get('/qr/poll', async (req: HTTPRequest) => {
  const q = parseQuery(req.query)
  const source = String(q.source || '')
  const key = String(q.key || '')
  if (!source || !key) return jsonResponse({ error: 'source and key are required' }, 400)
  try {
    const config = await getConfig()
    const result = await qrPoll(source, key, config)
    return jsonResponse({
      status: result.status,
      message: result.message || '',
      cookie_saved:
        !!result.extra && String(result.extra.cookie_saved || '') === 'true',
    })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      502,
    )
  }
})

// ---------- 排行榜（go-music-dl /toplists、/toplist_songs，仅 dl 后端有） ----------

// 榜单目录：GET /toplists?sources=netease,qq,...（缺省用插件配置音源）。
// 榜单目录变化慢，缓存 10min。仅 go-music-dl 后端支持（api 模式返回明确错误，前端隐藏入口）。
router.get('/toplists', async (req: HTTPRequest) => {
  const config = await getConfig()
  if (isApiBackend(config)) {
    return jsonResponse({ error: 'go-music-api 后端暂不支持排行榜' }, 400)
  }
  const sources = sourcesFromQuery(req)
  if (!config.baseUrl) {
    return jsonResponse({ error: '服务地址未配置，请先在设置中填写' }, 400)
  }
  const cacheKey = `toplists|${sources.join(',')}`
  const cached = toplistCache.get(cacheKey)
  if (cached) return jsonResponse({ lists: cached })
  try {
    const lists = await fetchTopLists(config, sources.length ? sources : undefined)
    toplistCache.set(cacheKey, lists)
    return jsonResponse({ lists })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// 榜单歌曲：GET /toplist_songs?source=&id=。与歌单详情同模板，缓存 5min。
router.get('/toplist_songs', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const source = String(q.source || '')
  const id = String(q.id || '')
  if (!source || !id) return jsonResponse({ error: 'source and id are required' }, 400)
  if (!config.baseUrl) {
    return jsonResponse({ error: '服务地址未配置，请先在设置中填写' }, 400)
  }
  const cacheKey = `toplist|${source}|${id}`
  const cached = toplistSongsCache.get(cacheKey)
  if (cached) return jsonResponse({ items: cached })
  try {
    const songs = await fetchTopListSongs(config, { source, id })
    toplistSongsCache.set(cacheKey, songs)
    return jsonResponse({
      items: songs.map((s) => ({
        id: s.id,
        name: s.name,
        artist: s.artist,
        album: s.album,
        cover: s.cover,
        source: s.source,
        duration: s.duration,
        extra: s.extra,
      })),
    })
  } catch (e) {
    return jsonResponse(
      { error: String((e as Error)?.message || e) },
      500,
    )
  }
})

// ---------- 下载记录（已下载标记用，go-music-dl /api/downloads/records） ----------

// 返回归一化匹配键 → status 的映射（仅 success/skipped 计为已下载；failed 不算）。
// 拉前 3 页（每页 100）覆盖近期记录，结果缓存 10min。
router.get('/downloads/records', async () => {
  const configNow = await getConfig()
  if (isApiBackend(configNow)) {
    return jsonResponse({ marks: {} })
  }
  const cached = dlRecordsCache.get('all')
  if (cached) return jsonResponse({ marks: cached })
  const config = await getConfig()
  if (!config.baseUrl) return jsonResponse({ marks: {} })
  try {
    const records = await fetchDownloadRecords(config, 3)
    const marks: Record<string, boolean> = {}
    for (const r of records) {
      if (r.status !== 'success' && r.status !== 'skipped') continue
      const key = `${(r.name || '').trim().toLowerCase()}|${(r.artist || '').trim().toLowerCase()}`
      if (key !== '|') marks[key] = true
    }
    dlRecordsCache.set('all', marks)
    return jsonResponse({ marks })
  } catch {
    // 下载记录是增强信息，失败静默降级（不给列表加徽标即可）
    return jsonResponse({ marks: {} })
  }
})

// ---------- 发现页/我的歌单 JSON 转发（go-music-api 模式专用） ----------
// gmd 模式下前端直连 gmd HTML（原有链路，零改动）；api 模式下前端改走这些端点，
// 由后端调 api 的 JSON 接口并归一化为前端渲染函数期望的数据结构。

function requireApiBackend(config: GoMusicDlConfig): string | null {
  if (!config.baseUrl) return '服务地址未配置，请先在设置中填写'
  if (!isApiBackend(config)) return '该端点仅在 go-music-api 后端模式下可用'
  return null
}

function sourcesFromQuery(req: HTTPRequest): string[] {
  const q = parseQuery(req.query)
  return String(q.sources || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 每日推荐歌单（api: /api/v1/playlist/recommend 多源聚合）
router.get('/backend/recommend', async (req: HTTPRequest) => {
  const config = await getConfig()
  const err = requireApiBackend(config)
  if (err) return jsonResponse({ error: err }, 400)
  try {
    const items = await fetchRecommendApi(config, sourcesFromQuery(req))
    return jsonResponse({ items })
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 502)
  }
})

// 歌单分类（api: /api/v1/playlist/categories，PlaylistCategory.group → 前端分组）
router.get('/backend/categories', async (req: HTTPRequest) => {
  const config = await getConfig()
  const err = requireApiBackend(config)
  if (err) return jsonResponse({ error: err }, 400)
  try {
    const sources = await fetchCategoriesApi(config, sourcesFromQuery(req))
    return jsonResponse({ sources })
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 502)
  }
})

// 分类下歌单（api: /api/v1/playlist/category，支持分页）
router.get('/backend/category_playlists', async (req: HTTPRequest) => {
  const config = await getConfig()
  const err = requireApiBackend(config)
  if (err) return jsonResponse({ error: err }, 400)
  const q = parseQuery(req.query)
  const source = String(q.source || '')
  const categoryId = String(q.categoryId || '')
  const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
  if (!source || !categoryId) {
    return jsonResponse({ error: 'source and categoryId are required' }, 400)
  }
  try {
    const items = await fetchCategoryPlaylistsApi(config, source, categoryId, page)
    return jsonResponse({ items, page })
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 502)
  }
})

// 歌单/专辑详情（api: /api/v1/playlist/detail、/album/detail，JSON 全量）
router.get('/backend/collection_songs', async (req: HTTPRequest) => {
  const config = await getConfig()
  const err = requireApiBackend(config)
  if (err) return jsonResponse({ error: err }, 400)
  const q = parseQuery(req.query)
  const id = String(q.id || '')
  const source = String(q.source || '')
  const kind = q.kind === 'album' ? 'album' : 'playlist'
  if (!id || !source) return jsonResponse({ error: 'id and source are required' }, 400)
  try {
    const items = await fetchCollectionSongsApi(config, { id, source }, kind)
    return jsonResponse({ items })
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 502)
  }
})

// 我的歌单（api: 逐源 /api/v1/playlist/user 聚合，未登录源静默跳过）
router.get('/backend/user_playlists', async (req: HTTPRequest) => {
  const config = await getConfig()
  const err = requireApiBackend(config)
  if (err) return jsonResponse({ error: err }, 400)
  try {
    const items = await fetchUserPlaylistsApi(config, sourcesFromQuery(req))
    return jsonResponse({ items })
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 502)
  }
})


// 设计与流程见 src/sync.ts 头注释与 README「歌单同步」章节。
// 协议为「begin + 循环 step」：begin 创建会话并抓首页，前端循环调 step 推进
// （每步抓一页 / 比对 / 导入一小批），每步返回实时进度 → 前端刷新进度条；
// 每步都是短请求，稳在网关上限内（前端另带 X-Plugin-Timeout-Ms 放宽头）。

// 绑定列表：前端同步面板渲染「已绑定/上次同步时间」用
router.get('/sync/bindings', async () => {
  const bindings = await listBindings()
  return jsonResponse({ bindings })
})

// 开始同步单张远端歌单：创建会话 + 抓首页（登录失效/网络错误在此快速失败）。
// body: { source, id, name?, cover? }（name/cover 由前端从 user_playlists 卡片带上，
// 用于本地歌单命名与封面；后端不再解析 user_playlists HTML）
router.post('/sync/begin', async (req: HTTPRequest) => {
  const body = parseBody(req) as {
    source?: string
    id?: string
    name?: string
    cover?: string
  }
  const source = String(body.source || '').trim()
  const id = String(body.id || '').trim()
  if (!source || !id) {
    return jsonResponse({ error: 'source and id are required' }, 400)
  }
  try {
    const step = await beginSyncSession({
      source,
      id,
      name: body.name ? String(body.name) : undefined,
      cover: body.cover ? String(body.cover) : undefined,
    })
    return jsonResponse(step)
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

// 推进同步会话一步：body: { sessionId }。返回 { done, phase, ...进度 } 或
// { done: true, result }。会话失效（运行时重启/超时回收）返回 404 +
// code=SYNC_SESSION_NOT_FOUND，前端提示重试（已导入部分幂等不丢）。
router.post('/sync/step', async (req: HTTPRequest) => {
  const body = parseBody(req) as { sessionId?: string }
  try {
    const step = await stepSyncSession(String(body.sessionId || ''))
    return jsonResponse(step)
  } catch (e) {
    if (e instanceof SyncSessionNotFound) {
      return jsonResponse(
        { error: String((e as Error)?.message || e), code: 'SYNC_SESSION_NOT_FOUND' },
        404,
      )
    }
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

// 宿主歌单歌曲列表代理（同步面板展示绑定歌单详情 / 调试用）。
// 强制放大 limit 一次拉全量（宿主该接口 limit 无钳制，见 handlers/playlist.go）。
router.get('/playlists/:id/songs', async (req: HTTPRequest, params: any) => {
  try {
    if (!params.id || !/^\d+$/.test(params.id)) {
      return jsonResponse({ error: '无效的歌单 id' }, 400)
    }
    const query = req.query ? `${req.query}&limit=10000` : 'limit=10000'
    const result = await callHostApi(
      'GET',
      `/api/v1/playlists/${params.id}/songs?${query}`,
    )
    return jsonResponse(result)
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500)
  }
})

export default router

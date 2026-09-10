import {
  createRouter,
  jsonResponse,
  createSearchHandler,
  parseQuery,
} from '@songloft/plugin-sdk'
import type { HTTPRequest, SearchResultItem } from '@songloft/plugin-sdk'
import { getConfig, saveConfig, GoMusicDlConfig } from './config'
import {
  searchSongs,
  searchSongsPage,
  searchCollectionsPage,
  buildDownloadUrl,
  fetchLyric,
  GoSong,
} from './client'
import { encodeToken, decodeToken, loopbackToLan } from './bridge-contract'
import { callHostApi } from './host'
import {
  probeDownloadable,
  resolveImportableItem,
  importRemoteSongs,
  importRemoteSong,
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

function toSearchItem(s: GoSong): SearchResultItem {
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
      extra: s.extra,
    },
  }
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
  return jsonResponse({ success: true, config: newConfig })
})

// 全局搜索（Songloft 主程序调用）
router.post('/api/search', createSearchHandler({
  search: async (keyword: string, page = 1, pageSize = 20) => {
    const config = await getConfig()
    const songs = await searchSongs(keyword, config, page, pageSize)
    return songs.map(toSearchItem)
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
  const song = sourceData as unknown as GoSong
  try {
    const url = buildDownloadUrl(
      {
        id: String(song.id),
        source: String(song.source),
        name: String(song.name || ''),
        artist: String(song.artist || ''),
        album: String(song.album || ''),
        cover: String(song.cover || ''),
        duration: Number(song.duration) || 0,
        extra: (song.extra as Record<string, any>) || {},
      },
      config.baseUrl,
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
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base)) {
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
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(base)) {
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
        id: String(song.id),
        source: String(song.source),
        name: String(song.name || ''),
        artist: String(song.artist || ''),
        album: String(song.album || ''),
        cover: String(song.cover || ''),
        duration: Number(song.duration) || 0,
        extra: (song.extra as Record<string, any>) || {},
      },
      baseUrl,
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
  const song: GoSong = {
    id: String(item.id),
    source: String(item.source),
    name: String(item.name || ''),
    artist: String(item.artist || ''),
    album: String(item.album || ''),
    cover: String(item.cover || ''),
    duration: Number(item.duration) || 0,
    extra: (item.extra as Record<string, any>) || {},
  }
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
  try {
    const config = await getConfig()
    // 抓取前 20 条搜索结果，经 sortSongsByRelevance 打分重排序后取第一条最佳匹配
    const songs = await searchSongs(keyword, config, 1, 20)
    if (!songs.length) {
      return jsonResponse({ code: 1, msg: 'no result', data: null })
    }
    const s = songs[0]
    // 返回指向本插件 /stream/:token 的对外直链（音箱可直连）；
    // 推导失败时返回 null → url 置空 → miot 回退入库播放。
    const directUrl = await makeDirectStreamUrl(s)
    return jsonResponse({
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
          extra: s.extra,
        },
        dedup_key: `go-music-dl_${s.source}_${s.id}`,
      },
    })
  } catch (e) {
    return jsonResponse({
      code: 1,
      msg: String((e as Error)?.message || e),
      data: null,
    })
  }
})

// 歌词提供者端点：宿主在歌曲无歌词时调用 GET /lyric-search?title=&artist=&album=&duration=
router.get('/lyric-search', async (req: HTTPRequest) => {
  const config = await getConfig()
  const q = parseQuery(req.query)
  const title = q.title || ''
  const artist = q.artist || ''
  try {
    // 宿主仅提供元数据，无 source_data，需按标题+歌手回搜再取歌词
    const songs = await searchSongs(
      `${title} ${artist}`.trim(),
      config,
      1,
      5,
    )
    const hit =
      songs.find(
        (s) => s.name.includes(title) || title.includes(s.name),
      ) || songs[0]
    if (!hit) return jsonResponse({ lyric: '' })
    const lyric = await fetchLyric(hit, config)
    return jsonResponse({ lyric: lyric || '' })
  } catch (e) {
    return jsonResponse({ lyric: '' })
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
  try {
    const lyric = await fetchLyric(song, config)
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
  try {
    if (type === 'song') {
      const { items, pagination } = await searchSongsPage(keyword, config, page)
      return jsonResponse({
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
      })
    }
    const { items, pagination } = await searchCollectionsPage(
      keyword,
      config,
      type,
      page,
    )
    return jsonResponse({
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
    })
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

// ---------- 歌单手动同步（单向：go-music-dl 账号歌单 → Songloft 本地歌单） ----------
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

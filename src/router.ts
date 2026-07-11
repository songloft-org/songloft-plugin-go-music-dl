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

interface SongItem {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  source: string
  duration: number
  extra: Record<string, any>
}

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

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {}
  try {
    const str =
      typeof req.body === 'string'
        ? req.body
        : String.fromCharCode.apply(
            null,
            Array.from(req.body as Uint8Array),
          )
    return JSON.parse(str)
  } catch {
    return {}
  }
}

interface DownloadRequest {
  item?: SongItem
}

function toRemoteSongRequest(item: SongItem) {
  return {
    title: item.name,
    artist: item.artist || 'Unknown',
    album: item.album || '',
    cover_url: item.cover || '',
    duration: item.duration,
    plugin_entry_path: 'go-music-dl',
    source_data: JSON.stringify({
      id: item.id,
      source: item.source,
      name: item.name,
      artist: item.artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      extra: item.extra,
    }),
    dedup_key: `go-music-dl_${item.source}_${item.id}`,
  }
}

// 导入前校验：用「下载器实际会用的同一个下载 URL」探一下可达性。
// 这样能拦住前端 inspect 误判为可播、但 go-music-dl 实际已无法提供音源的失效歌曲，
// 避免用户把死歌导入曲库后，到「歌曲下载」插件里才下载失败。
// 返回：'ok' 可导入 / 'dead' 确属失效需拒绝 / 'unknown' 网络抖动等不确定，放行以免误杀。
async function probeDownloadable(
  item: SongItem,
  config: GoMusicDlConfig,
): Promise<'ok' | 'dead' | 'unknown'> {
  const url = buildDownloadUrl(
    {
      id: String(item.id),
      source: String(item.source),
      name: String(item.name || ''),
      artist: String(item.artist || ''),
      album: String(item.album || ''),
      cover: String(item.cover || ''),
      duration: Number(item.duration) || 0,
      extra: (item.extra as Record<string, any>) || {},
    },
    config.baseUrl,
    false, // stream=1：导入前轻量探测，不下载整曲；失效时 go-music-dl 返回 404/502
  )
  if (!url) return 'dead'
  const timeout = new Promise<'unknown'>((resolve) =>
    setTimeout(() => resolve('unknown'), 8000),
  )
  try {
    const res: any = await Promise.race([
      fetch(url, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      }),
      timeout,
    ])
    // 超时分支返回的是字符串 'unknown'，直接放行（不误杀慢速但有效的音源）
    if (typeof res.status !== 'number') return 'unknown'
    // 2xx/3xx = go-music-dl 仍在正常派发（指向真实音源），可导入
    if (res.status >= 200 && res.status < 400) {
      // 防御：个别失效源会返回 200 + HTML 错误页，而非明确的 404。
      // 若响应体是 HTML（非音频），则视为失效，避免把死歌导入歌单。
      const ct = (res.headers && res.headers.get
        ? res.headers.get('content-type')
        : '') || ''
      if (ct && ct.toLowerCase().includes('text/html')) return 'dead'
      return 'ok'
    }
    // go-music-dl 自身返回 404/410 或 5xx，说明该音源已失效
    if (res.status === 404 || res.status === 410 || res.status >= 500)
      return 'dead'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function importRemoteSong(item: SongItem): Promise<any> {
  if (!item.id || !item.name) {
    throw new Error('Invalid download item')
  }
  const hostUrl = await (globalThis as any).songloft.plugin.getHostUrl()
  const token = await (globalThis as any).songloft.plugin.getToken()
  const res = await fetch(`${hostUrl}/api/v1/songs/remote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify([toRemoteSongRequest(item)]),
  })
  if (!res.ok) {
    throw new Error(`Import failed: ${await res.text()}`)
  }
  const data = await res.json()
  const songs = Array.isArray(data.songs) ? data.songs : []
  if (!songs[0] || typeof songs[0].id !== 'number') {
    throw new Error('Import response missing song id')
  }
  return songs[0]
}

// 代理宿主 API：用插件运行时拿到的宿主绝对地址 + token 调用，
// 避免前端直连时因 common.js 的 API_BASE='.' 把 /api/v1 拼成相对路径而 404。
async function callHostApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const hostUrl = await (globalThis as any).songloft.plugin.getHostUrl()
  const token = await (globalThis as any).songloft.plugin.getToken()
  const res = await fetch(`${hostUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(
      `Host API ${method} ${path} failed: ${await res.text()}`,
    )
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
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
  const sourceData = body.source_data as Record<string, unknown> | undefined
  if (!sourceData || typeof sourceData !== 'object') {
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

// 单首搜索端点（topone）：
// 供 MIoT「智能音箱」插件的外部搜索源调用（相对路径 loopback，无需改 miot 代码）。
// 契约兼容 OnlineSearcher：POST { keyword, hint?, quality? } → { code, msg, data }。
// 返回解析型结果（不附直链），device 播放时宿主回源本插件 /api/music/url，
// 避免临时 CDN 直链入库后失效。
router.post('/api/search/topone', async (req: HTTPRequest) => {
  const body = parseBody(req)
  const keyword = String(body.keyword || '').trim()
  if (!keyword) {
    return jsonResponse({ code: 1, msg: 'empty keyword', data: null })
  }
  try {
    const config = await getConfig()
    const songs = await searchSongs(keyword, config, 1, 1)
    if (!songs.length) {
      return jsonResponse({ code: 1, msg: 'no result', data: null })
    }
    const s = songs[0]
    return jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        title: s.name,
        artist: s.artist || '',
        album: s.album || '',
        duration: s.duration || 0,
        cover_url: s.cover || '',
        plugin_entry_path: 'go-music-dl',
        source_data: JSON.stringify({
          id: s.id,
          source: s.source,
          name: s.name,
          artist: s.artist,
          album: s.album,
          duration: s.duration,
          cover: s.cover,
          extra: s.extra,
        }),
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

export default router

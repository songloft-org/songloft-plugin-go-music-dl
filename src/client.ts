import { GoMusicDlConfig, DEFAULT_SOURCES, normalizeBaseUrl } from './config'
import { classifyLyricFormat, collapseKaraokeToLines } from './lyrics-format'

export interface GoSong {
  id: string
  source: string
  name: string
  artist: string
  album: string
  cover: string
  duration: number
  extra: Record<string, any>
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function getAttr(attrs: string, key: string): string {
  // 大多数 data-* 用双引号；data-extra 用单引号包裹 JSON（内部含双引号），需单独处理
  let m = attrs.match(new RegExp(`\\bdata-${key}="([^"]*)"`))
  if (m) return unescapeHtml(m[1])
  m = attrs.match(new RegExp(`\\bdata-${key}='([^']*)'`))
  if (m) return unescapeHtml(m[1])
  return ''
}

/**
 * 解析 go-music-dl 搜索结果 HTML 中的 .song-card 列表。
 * 沙箱内无 DOMParser，使用正则提取 data-* 属性（结构稳定，模板中跨多行排列）。
 */
export function parseSongCards(html: string): GoSong[] {
  const cards: GoSong[] = []
  const re = /<li\s+class="song-card"([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = m[1]
    const id = getAttr(attrs, 'id')
    if (!id) continue
    let extra: Record<string, any> = {}
    const extraRaw = getAttr(attrs, 'extra')
    if (extraRaw) {
      try {
        extra = JSON.parse(extraRaw)
      } catch {
        extra = {}
      }
    }
    cards.push({
      id,
      source: getAttr(attrs, 'source'),
      name: getAttr(attrs, 'name'),
      artist: getAttr(attrs, 'artist'),
      album: getAttr(attrs, 'album'),
      cover: getAttr(attrs, 'cover'),
      duration: Number(getAttr(attrs, 'duration')) || 0,
      extra,
    })
  }
  return cards
}

/**
 * 发起请求并返回文本。集中处理网络错误与 HTTP 错误，给出可读的报错，
 * 这样上层（router）包成 500 时，前端能拿到真实原因而不是笼统的 "HTTP 500"。
 *
 * timeoutMs 经宿主内部头 X-Fetch-Timeout-Ms 下发（宿主 clamp 到 [100ms, 30s]，
 * 头本身不会转发给 go-music-dl）。上游 go-music-dl 的多源搜索对单源无超时
 * （music-lib 共享 client 默认 2 分钟），不设头时插件 fetch 会干等 30s 默认值；
 * 默认 25s 留出响应处理余量（网关默认 30s），严格预算链路（topone 6s /
 * 宿主 fallback 5s / 歌词 15s）由调用方传更小的值。
 */
async function fetchText(url: string, timeoutMs = 25000): Promise<string> {
  let res: any
  try {
    res = await fetch(url, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Fetch-Timeout-Ms': String(Math.min(30000, Math.max(100, timeoutMs))),
      },
    })
  } catch (e: any) {
    throw new Error('无法连接 go-music-dl: ' + (e?.message || String(e)))
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'go-music-dl 返回 401：该实例启用了登录鉴权。请在 go-music-dl 端关闭登录，' +
          '或改用无需鉴权的地址。',
      )
    }
    if (res.status === 404) {
      throw new Error(
        'go-music-dl 接口不存在 (404)：请确认服务地址与 Base Path 配置正确' +
          '（插件按 Base Path 拼接前缀，默认 /music；上游 --base-path 改过时需同步填写）。',
      )
    }
    throw new Error(`go-music-dl 请求失败: HTTP ${res.status}`)
  }
  return await res.text()
}

export type SearchType = 'song' | 'playlist' | 'album'

/**
 * 构造并请求 go-music-dl 的 /music/search，返回原始 HTML。
 * 单曲 / 歌单 / 专辑共用同一接口，仅 type 参数不同。
 */
async function fetchSearchHtml(
  keyword: string,
  config: GoMusicDlConfig,
  type: SearchType,
  page: number,
  pageSize: number,
  timeoutMs = 25000,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const sources =
    config.sources && config.sources.length ? config.sources : DEFAULT_SOURCES
  const params: string[] = [
    `q=${encodeURIComponent(keyword)}`,
    `type=${type}`,
    `page=${page}`,
  ]
  // go-music-dl 认的是 page_size（不是 count）。仅当显式给定正数时才传，
  // 传 0 则不带该参数，让服务端使用其 WebPageSize 设置（默认 200，见上游
  // core.DefaultWebPageSize；实例可在设置页改小），使插件搜索页每页条数与
  // go-music-dl 网页端保持一致。注意：上游分页是「全量搜索后内存切片」，
  // 翻页会触发全量重搜，page_size 越大翻页次数越少。
  if (pageSize > 0) {
    params.push(`page_size=${pageSize}`)
  }
  for (const s of sources) {
    params.push(`sources=${encodeURIComponent(s)}`)
  }
  const url = `${base}/search?${params.join('&')}`
  return fetchText(url, timeoutMs)
}

// 常见衍生版本修饰词
const DERIVATIVE_KEYWORDS = [
  'live', '演唱会', '伴奏', 'instrumental', 'inst', 'remix', 
  'cover', '翻唱', 'dj', 'gai', '改编', '片段', '剪辑', '纯音乐', '钢琴', '伴奏版'
]

// 排序辅助函数
export function sortSongsByRelevance<T extends { name: string; artist: string; album?: string }>(songs: T[], keyword: string): T[] {
  const kw = (keyword || '').trim().toLowerCase()
  if (!kw || !songs || !songs.length) return songs

  const userWantsDerivative = DERIVATIVE_KEYWORDS.some(dk => kw.includes(dk))
  const tokens = kw.split(/[\s的之与和&\/\-\_]+/).filter(Boolean)

  const getScore = (song: T): number => {
    const name = (song.name || '').trim().toLowerCase()
    const artist = (song.artist || '').trim().toLowerCase()
    const album = (song.album || '').trim().toLowerCase()
    if (!name) return 0

    const combined = `${artist} ${name}`
    const combinedAlt = `${name} ${artist}`

    let score = 0

    const kwContainsArtist = artist && artist.length >= 2 && kw.includes(artist)
    const kwContainsName = name && name.length >= 1 && kw.includes(name)

    const tokenMatchedArtist = tokens.some(t => t.length >= 2 && artist.includes(t))
    const tokenMatchedName = tokens.some(t => t.length >= 1 && name.includes(t))

    // A. 超高分：完美正版原唱！(检索词既包含歌手名，又包含歌名)
    if ((kwContainsArtist && kwContainsName) || (tokenMatchedArtist && tokenMatchedName)) {
      score = 1200
      if (name === kw || combined.replace(/\s+/g, '') === kw.replace(/[\s的]+/g, '')) {
        score += 500
      } else if (kwContainsName && name.length >= 2) {
        score += 300
      }
    }
    // B. 精确匹配歌名或组合
    else if (name === kw || combined === kw || combinedAlt === kw) {
      score = 1000
    }
    // C. 歌名包含搜索词
    else if (name.includes(kw)) {
      score = 500
    }
    // D. 仅命中歌名
    else if (kwContainsName || tokenMatchedName) {
      score = 200
    }
    // E. 仅命中歌手
    else if (kwContainsArtist || tokenMatchedArtist) {
      score = 100
    }

    // 修饰词惩罚（Live、伴奏、Remix 降权）
    if (!userWantsDerivative) {
      const isDerivative = DERIVATIVE_KEYWORDS.some(
        dk => name.includes(dk) || album.includes(dk)
      )
      if (isDerivative) {
        score -= 250
      }
    }

    // 干净标题微调
    if (!/[\(\（\[\【].*?[\)\）\]\】]/.test(name)) {
      score += 30
    }

    // 长度惩罚
    score -= name.length * 0.1

    return score
  }

  return [...songs].sort((a, b) => getScore(b) - getScore(a))
}

export async function searchSongs(
  keyword: string,
  config: GoMusicDlConfig,
  page = 1,
  pageSize = 20,
  timeoutMs = 25000,
): Promise<GoSong[]> {
  const html = await fetchSearchHtml(keyword, config, 'song', page, pageSize, timeoutMs)
  const items = parseSongCards(html)
  return sortSongsByRelevance(items, keyword)
}


/**
 * 分页元信息，对齐 go-music-dl 网页端的分页摘要。
 * 从返回 HTML 的 page-summary 文本中解析（歌曲/歌单/专辑模板格式一致）：
 *   「当前第 {page} / {totalPages} 页，显示 {pageStart} - {pageEnd} / {total}」
 */
export interface Pagination {
  page: number
  totalPages: number
  total: number
  pageStart: number
  pageEnd: number
  /** true=从 HTML 真实解析到分页摘要；false=未解析到，按兜底返回（总页数未知） */
  inferred: boolean
}

export function parsePagination(html: string): Pagination {
  const m = html.match(
    /当前第\s*(\d+)\s*\/\s*(\d+)\s*页，显示\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/,
  )
  if (m) {
    return {
      page: Number(m[1]) || 1,
      totalPages: Number(m[2]) || 1,
      pageStart: Number(m[3]) || 0,
      pageEnd: Number(m[4]) || 0,
      total: Number(m[5]) || 0,
      inferred: true,
    }
  }
  // 无 page-summary：总页数未知，调用方须依赖「下一页为空」来终止，
  // 否则多页歌单会被误判为单页而静默丢歌（见 import-core/sync 的跨页抓取）
  return { page: 1, totalPages: 1, pageStart: 0, pageEnd: 0, total: 0, inferred: false }
}

/**
 * 分页搜索歌曲：pageSize 传 0，让 go-music-dl 用其 WebPageSize 决定每页条数，
 * 仅用 page 翻页。返回歌曲列表与分页元信息。
 */
export async function searchSongsPage(
  keyword: string,
  config: GoMusicDlConfig,
  page = 1,
  timeoutMs = 25000,
): Promise<{ items: GoSong[]; pagination: Pagination }> {
  const html = await fetchSearchHtml(keyword, config, 'song', page, 0, timeoutMs)
  const items = parseSongCards(html)
  const sortedItems = sortSongsByRelevance(items, keyword)
  const pagination = parsePagination(html)
  // 摘要缺失时用当前页实际条数兜底，避免前端显示 0
  if (pagination.total === 0 && sortedItems.length > 0) {
    pagination.total = sortedItems.length
    pagination.pageStart = 1
    pagination.pageEnd = sortedItems.length
  }
  return { items: sortedItems, pagination }
}

export interface GoCollection {
  id: string
  source: string
  title: string
  cover: string
  creator: string
  count: number
  contentType: 'playlist' | 'album'
}

/**
 * 解析 go-music-dl 歌单/专辑搜索结果 HTML 中的 .playlist-card。
 * 沙箱内无 DOMParser，用正则从每首卡片内的「导入本地」按钮（class="ctrl-btn primary"）
 * 提取 data-* 属性。该按钮顺序固定：data-name / data-cover / data-creator /
 * data-track-count / data-source / data-external-id / data-content-type，
 * 其中 data-content-type 直接告诉我们这是 playlist 还是 album。
 */
export function parsePlaylistCards(html: string): GoCollection[] {
  const cards: GoCollection[] = []
  const re =
    /class="ctrl-btn primary"[^>]*data-name="([^"]*)"[^>]*data-cover="([^"]*)"[^>]*data-creator="([^"]*)"[^>]*data-track-count="([^"]*)"[^>]*data-source="([^"]*)"[^>]*data-external-id="([^"]*)"[^>]*data-content-type="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const [, title, cover, creator, count, source, id, contentType] = m
    if (!id) continue
    cards.push({
      id,
      source,
      title: unescapeHtml(title),
      cover: unescapeHtml(cover),
      creator: unescapeHtml(creator),
      count: Number(count) || 0,
      contentType: contentType === 'album' ? 'album' : 'playlist',
    })
  }
  return cards
}

export async function searchCollections(
  keyword: string,
  config: GoMusicDlConfig,
  type: 'playlist' | 'album',
  page = 1,
  pageSize = 50,
  timeoutMs = 25000,
): Promise<GoCollection[]> {
  const html = await fetchSearchHtml(keyword, config, type, page, pageSize, timeoutMs)
  return parsePlaylistCards(html)
}

/**
 * 分页搜索歌单/专辑：pageSize 传 0，跟随 go-music-dl 的 WebPageSize。
 * 返回卡片列表与分页元信息。
 */
export async function searchCollectionsPage(
  keyword: string,
  config: GoMusicDlConfig,
  type: 'playlist' | 'album',
  page = 1,
  timeoutMs = 25000,
): Promise<{ items: GoCollection[]; pagination: Pagination }> {
  const html = await fetchSearchHtml(keyword, config, type, page, 0, timeoutMs)
  const items = parsePlaylistCards(html)
  const pagination = parsePagination(html)
  if (pagination.total === 0 && items.length > 0) {
    pagination.total = items.length
    pagination.pageStart = 1
    pagination.pageEnd = items.length
  }
  return { items, pagination }
}

/**
 * 构建试听/下载直链（go-music-dl /music/download）。
 *
 * embed=true（默认）：走 go-music-dl 的「先完整下载到内存再回吐」模式
 *   （embedMeta 分支）。相比 stream=1 的实时代理，它有两个关键好处：
 *   1) 宿主下载器拿到的是完整、可被 ffprobe 完整探测的音频文件，不会因
 *      CDN 中途断流而拿到被截断的文件，从而避免「能播放却下载失败」。
 *   2) 上游失效时 go-music-dl 会明确返回 404/502，而不是「假 200 + 中途断流」，
 *      便于导入前校验与下载器都正确识别为失效，避免死歌漏进歌单。
 *   （EmbedSongMetadata 在缺 ffmpeg 或失败时优雅降级为原始音频，不会破坏文件）
 *
 * embed=false：走 stream=1 轻量代理，仅用于导入前的快速可达性探测（不下载整曲）。
 */
export function buildDownloadUrl(
  song: GoSong,
  baseUrl: string,
  basePath?: string,
  embed = true,
): string {
  const base = normalizeBaseUrl(baseUrl, basePath)
  const extra = encodeURIComponent(JSON.stringify(song.extra || {}))
  return (
    `${base}/download` +
    `?id=${encodeURIComponent(song.id)}` +
    `&source=${encodeURIComponent(song.source)}` +
    `&extra=${extra}` +
    (embed ? `&embed=1` : `&stream=1`)
  )
}

/**
 * 构建轻量可达性探测 URL（go-music-dl /music/inspect）。
 * inspect 在服务端仅对上游发 Range 0-1 两字节请求并返回 JSON { valid, url, size, bitrate }，
 * 与网页端/插件前端（inspectSong）判断「歌曲可播」用的是同一套依据；
 * 相比 download?stream=1（宿主 QuickJS fetch 会把整曲读进内存，上限 64MiB/首），
 * 用它做导入前探测的带宽与内存成本可忽略。
 */
export function buildInspectUrl(song: GoSong, baseUrl: string, basePath?: string): string {
  const base = normalizeBaseUrl(baseUrl, basePath)
  if (!base) return ''
  const extra = encodeURIComponent(JSON.stringify(song.extra || {}))
  return (
    `${base}/inspect` +
    `?id=${encodeURIComponent(song.id)}` +
    `&source=${encodeURIComponent(song.source)}` +
    `&duration=${song.duration || 0}` +
    `&extra=${extra}`
  )
}

/**
 * 拉取原始歌词（go-music-dl /music/download_lrc）。
 * format=auto：上游 karaoke 逐字 LRC 原样返回，由调用方决定折叠（逐行）或
 * 转换（lxlyric 逐字），一次请求同时服务两种形态；失败返回空串。
 */
export async function fetchLyricRaw(
  song: GoSong,
  config: GoMusicDlConfig,
  timeoutMs = 25000,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const extra = encodeURIComponent(JSON.stringify(song.extra || {}))
  const url =
    `${base}/download_lrc` +
    `?id=${encodeURIComponent(song.id)}` +
    `&source=${encodeURIComponent(song.source)}` +
    `&name=${encodeURIComponent(song.name)}` +
    `&artist=${encodeURIComponent(song.artist)}` +
    `&album=${encodeURIComponent(song.album)}` +
    `&duration=${song.duration}` +
    `&extra=${extra}` +
    // auto：保留上游 karaoke 多时间戳逐字格式（line 会把逐字信息折叠丢失）
    `&format=auto`
  try {
    return await fetchText(url, timeoutMs)
  } catch {
    return ''
  }
}

/**
 * 拉取歌词并保证返回「一行一个时间戳」的逐行 LRC，失败返回空串。
 * 之前直接请求上游 format=line 由服务端折叠；现改为 auto 拉原始文本后本地折叠
 * （lyrics-format.ts，语义对齐上游 lyricOriginalLineOnly），折叠实现单点化，
 * 供 /lyric-search 等需要同时拿到逐字版的调用方复用同一份原始文本。
 */
export async function fetchLyric(
  song: GoSong,
  config: GoMusicDlConfig,
  timeoutMs = 25000,
): Promise<string> {
  const raw = await fetchLyricRaw(song, config, timeoutMs)
  if (!raw) return ''
  return classifyLyricFormat(raw) === 'karaoke'
    ? collapseKaraokeToLines(raw)
    : raw
}

/**
 * 拉取 go-music-dl 已登录账号的个人歌单页（HTML）。
 * 仅 netease/qq/kugou/soda 支持账号歌单（core.GetUserPlaylistSourceNames），
 * 全部要求 go-music-dl 网页端已扫码登录（cookie 在 go-music-dl 侧）。
 * 与前端「我的歌单」同源同实现（前端 playlists.js 用 DOMParser 解析，
 * 后端 QuickJS 无 DOM，用 parseSongCards 同构的正则通道）。
 */
export async function fetchUserPlaylistsHtml(
  config: GoMusicDlConfig,
  sources?: string[],
  timeoutMs = 25000,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const list =
    sources && sources.length
      ? sources
      : config.sources && config.sources.length
        ? config.sources
        : DEFAULT_SOURCES
  const params = list.map((s) => `sources=${encodeURIComponent(s)}`).join('&')
  return fetchText(`${base}/user_playlists?${params}`, timeoutMs)
}

/**
 * 分页拉取歌单/专辑详情页（HTML）。卡片与搜索结果同为 .song-card 结构
 * （go-music-dl 共用 partials/song_list.html 模板），用 parseSongCards 解析。
 */
export async function fetchCollectionSongsPage(
  config: GoMusicDlConfig,
  collection: { id: string; source: string },
  page = 1,
  timeoutMs = 25000,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const url =
    `${base}/playlist` +
    `?id=${encodeURIComponent(collection.id)}` +
    `&source=${encodeURIComponent(collection.source)}` +
    `&page=${page}`
  return fetchText(url, timeoutMs)
}

/**
 * 把音源原始封面 CDN 地址转成 go-music-dl /music/cover_proxy 代理地址，
 * 规避网易云/QQ 等封面的防盗链 403。与前端 api.js buildCoverUrl 同实现
 * （QuickJS/WebView 无法共享模块，两处需同步），宿主 GetPlaylistCover 仅在
 * CoverURL 非空时代理转发，故创建同步歌单时显式带上该地址。
 */
export function buildCoverProxyUrl(
  rawCover: string,
  baseUrl: string,
  basePath?: string,
): string {
  if (!rawCover) return ''
  if (/^(data:|blob:)/i.test(rawCover)) return rawCover
  const base = normalizeBaseUrl(baseUrl, basePath)
  if (!base) return rawCover
  if (rawCover.startsWith(base)) return rawCover // 已是本实例代理地址
  return `${base}/cover_proxy?url=${encodeURIComponent(rawCover)}`
}

// ---------- 排行榜（go-music-dl /music/toplists、/music/toplist_songs，仅 dl 有） ----------

export interface GoTopList {
  source: string
  /** 榜单名（query toplist_name / 卡片标题） */
  name: string
  toplistId: string
  updateFrequency: string
  cover: string
  description: string
  trackCount: number
}

/**
 * 解析 /toplists 页面中的榜单卡片。
 * 上游卡片（partials/toplists.html）形如：
 *   <a class="toplist-card" href="{root}/toplist_songs?source=..&toplist_id=..&toplist_name=..
 *      &update_frequency=..&cover=..&description=..&track_count=.." title="...">
 * 全部字段都在 href 的 query 里，正则取 href 后解码即可，不依赖卡片内部 DOM 结构。
 */
export function parseTopListCards(html: string): GoTopList[] {
  const out: GoTopList[] = []
  const seen = new Set<string>()
  const re =
    /<a\s+class="toplist-card"\s+href="([^"]+)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let url: URL
    try {
      url = new URL(unescapeHtml(m[1]), 'http://placeholder.local')
    } catch {
      continue
    }
    if (!url.searchParams.get('toplist_id')) continue
    const source = url.searchParams.get('source') || ''
    const id = url.searchParams.get('toplist_id') || ''
    const key = `${source}__${id}`
    if (!source || seen.has(key)) continue
    seen.add(key)
    out.push({
      source,
      name: unescapeHtml(url.searchParams.get('toplist_name') || id),
      toplistId: id,
      updateFrequency: unescapeHtml(url.searchParams.get('update_frequency') || ''),
      cover: unescapeHtml(url.searchParams.get('cover') || ''),
      description: unescapeHtml(url.searchParams.get('description') || ''),
      trackCount: Number(url.searchParams.get('track_count')) || 0,
    })
  }
  return out
}

/** 拉取榜单目录页（HTML），sources 缺省时用插件配置的音源与上游默认一致 */
export async function fetchTopLists(
  config: GoMusicDlConfig,
  sources?: string[],
  timeoutMs = 25000,
): Promise<GoTopList[]> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const list =
    sources && sources.length
      ? sources
      : config.sources && config.sources.length
        ? config.sources
        : DEFAULT_SOURCES
  const params = list.map((s) => `sources=${encodeURIComponent(s)}`).join('&')
  const html = await fetchText(`${base}/toplists?${params}`, timeoutMs)
  return parseTopListCards(html)
}

/** 拉取榜单歌曲页（与歌单详情共用 song_list 模板，复用 parseSongCards） */
export async function fetchTopListSongs(
  config: GoMusicDlConfig,
  topList: { source: string; id: string },
  timeoutMs = 25000,
): Promise<GoSong[]> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const url =
    `${base}/toplist_songs` +
    `?source=${encodeURIComponent(topList.source)}` +
    `&toplist_id=${encodeURIComponent(topList.id)}`
  const html = await fetchText(url, timeoutMs)
  return parseSongCards(html)
}

// ---------- 下载记录（go-music-dl /music/api/downloads/records，已下载标记用） ----------

export interface GoDownloadRecord {
  name: string
  artist: string
  source: string
  status: string
}

/**
 * 分页拉取服务器下载记录（status: success/skipped/failed）。
 * records 用于「已下载」徽标：拉前几页（每页上限 100）足够覆盖近期下载。
 */
export async function fetchDownloadRecords(
  config: GoMusicDlConfig,
  pages = 3,
  timeoutMs = 10000,
): Promise<GoDownloadRecord[]> {
  const base = normalizeBaseUrl(config.baseUrl, config.basePath)
  const out: GoDownloadRecord[] = []
  for (let page = 1; page <= Math.max(1, pages); page++) {
    const data: any = await requestJsonAny(
      `${base}/api/downloads/records?page=${page}&page_size=100`,
      timeoutMs,
    )
    const records = Array.isArray(data && data.records) ? data.records : []
    for (const r of records) {
      if (r && typeof r.name === 'string') {
        out.push({
          name: r.name,
          artist: typeof r.artist === 'string' ? r.artist : '',
          source: typeof r.source === 'string' ? r.source : '',
          status: typeof r.status === 'string' ? r.status : '',
        })
      }
    }
    const totalPages = Number(data && data.total_pages) || 1
    if (page >= totalPages) break
  }
  return out
}

/** GET JSON（下载记录等轻量接口；错误静默抛出，由调用方决定降级） */
async function requestJsonAny(url: string, timeoutMs: number): Promise<any> {
  const text = await fetchText(url, timeoutMs)
  return JSON.parse(text)
}


import { GoMusicDlConfig, DEFAULT_SOURCES, normalizeBaseUrl } from './config'

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
 */
async function fetchText(url: string): Promise<string> {
  let res: any
  try {
    res = await fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
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
        'go-music-dl 接口不存在 (404)：请确认地址正确，且插件已自动补上 /music 前缀。',
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
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl)
  const sources =
    config.sources && config.sources.length ? config.sources : DEFAULT_SOURCES
  const params: string[] = [
    `q=${encodeURIComponent(keyword)}`,
    `type=${type}`,
    `page=${page}`,
  ]
  // go-music-dl 认的是 page_size（不是 count）。仅当显式给定正数时才传，
  // 传 0 则不带该参数，让服务端使用其 WebPageSize 设置（默认 30），
  // 使插件搜索页每页条数与 go-music-dl 网页端保持一致。
  if (pageSize > 0) {
    params.push(`page_size=${pageSize}`)
  }
  for (const s of sources) {
    params.push(`sources=${encodeURIComponent(s)}`)
  }
  const url = `${base}/search?${params.join('&')}`
  return fetchText(url)
}

export async function searchSongs(
  keyword: string,
  config: GoMusicDlConfig,
  page = 1,
  pageSize = 20,
): Promise<GoSong[]> {
  const html = await fetchSearchHtml(keyword, config, 'song', page, pageSize)
  return parseSongCards(html)
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
    }
  }
  // 无 page-summary（结果为空，或只有一页且模板未渲染摘要）时的兜底
  return { page: 1, totalPages: 1, pageStart: 0, pageEnd: 0, total: 0 }
}

/**
 * 分页搜索歌曲：pageSize 传 0，让 go-music-dl 用其 WebPageSize 决定每页条数，
 * 仅用 page 翻页。返回歌曲列表与分页元信息。
 */
export async function searchSongsPage(
  keyword: string,
  config: GoMusicDlConfig,
  page = 1,
): Promise<{ items: GoSong[]; pagination: Pagination }> {
  const html = await fetchSearchHtml(keyword, config, 'song', page, 0)
  const items = parseSongCards(html)
  const pagination = parsePagination(html)
  // 摘要缺失时用当前页实际条数兜底，避免前端显示 0
  if (pagination.total === 0 && items.length > 0) {
    pagination.total = items.length
    pagination.pageStart = 1
    pagination.pageEnd = items.length
  }
  return { items, pagination }
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
): Promise<GoCollection[]> {
  const html = await fetchSearchHtml(keyword, config, type, page, pageSize)
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
): Promise<{ items: GoCollection[]; pagination: Pagination }> {
  const html = await fetchSearchHtml(keyword, config, type, page, 0)
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
  embed = true,
): string {
  const base = normalizeBaseUrl(baseUrl)
  const extra = encodeURIComponent(JSON.stringify(song.extra || {}))
  return (
    `${base}/download` +
    `?id=${encodeURIComponent(song.id)}` +
    `&source=${encodeURIComponent(song.source)}` +
    `&extra=${extra}` +
    (embed ? `&embed=1` : `&stream=1`)
  )
}

/** 拉取歌词（LRC 纯文本），失败返回空串 */
export async function fetchLyric(
  song: GoSong,
  config: GoMusicDlConfig,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl)
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
    // 强制按「一行一个时间戳」返回，避免 go-music-dl 把 karaoke 多时间戳行
    // 原样吐出；Songloft 全屏歌词按行解析会把每个时间戳拆成独立一行，
    // 导致同一句歌词重复出现。format=line 由 go-music-dl 折叠为多时间戳→单行。
    `&format=line`
  try {
    return await fetchText(url)
  } catch {
    return ''
  }
}

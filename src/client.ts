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

export async function searchSongs(
  keyword: string,
  config: GoMusicDlConfig,
  page = 1,
  pageSize = 20,
): Promise<GoSong[]> {
  const base = normalizeBaseUrl(config.baseUrl)
  const sources =
    config.sources && config.sources.length ? config.sources : DEFAULT_SOURCES
  const params: string[] = [
    `q=${encodeURIComponent(keyword)}`,
    `type=song`,
    `page=${page}`,
    `count=${pageSize}`,
  ]
  for (const s of sources) {
    params.push(`sources=${encodeURIComponent(s)}`)
  }
  const url = `${base}/search?${params.join('&')}`
  const html = await fetchText(url)
  return parseSongCards(html)
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

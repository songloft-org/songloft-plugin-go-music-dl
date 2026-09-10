// 导入核心：歌曲入库（宿主 /api/v1/songs/remote 批量写）与下载可达性探测。
// 自 router.ts 抽出，供 /import、/import/batch 路由与歌单同步（sync.ts）共用，
// 平移时逻辑保持不变。

import type { GoMusicDlConfig } from './config'
import { buildInspectUrl } from './client'

export interface SongItem {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  source: string
  duration: number
  extra: Record<string, any>
}

export function toRemoteSongRequest(item: SongItem) {
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

// 导入前校验：打 go-music-dl /music/inspect 做轻量可达性探测——服务端仅对上游发
// Range 0-1 两字节请求，返回 JSON { valid, url, size, bitrate }，与前端 inspectSong
// 判「可播」是同一套依据，前端徽标与后端导入校验从此不再可能分叉。
// 历史教训：早期用 download?stream=1 探测，而宿主 QuickJS fetch 会把响应体整曲读进
// 内存（上限 64MiB/首），批量导入时等于把每首歌都过一遍宿主内存，带宽/内存代价巨大。
// 返回：'ok' 可导入 / 'dead' 确属失效需拒绝 / 'unknown' 网络抖动等不确定，放行以免误杀
// （含 inspect 端点 404/5xx、200+非 JSON 等接口级异常——那是 go-music-dl 的问题，
//  不是「这首歌失效」的证据，不能据此判死）。
export async function probeDownloadable(
  item: SongItem,
  config: GoMusicDlConfig,
  deadline?: { hit: boolean },
): Promise<'ok' | 'dead' | 'unknown'> {
  if (deadline?.hit) return 'unknown'
  const url = buildInspectUrl(
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
  )
  if (!url) return 'dead' // baseUrl 为空：与旧口径一致按不可用处理（/import/batch 另有显式 400）
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
    // 超时分支返回的是字符串 'unknown'，直接放行（inspect 上游自带 5s 上限，8s 是余量）
    if (typeof res.status !== 'number') return 'unknown'
    if (!res.ok) return 'unknown'
    const j: any = await res.json().catch(() => null)
    if (!j || typeof j.valid !== 'boolean') return 'unknown'
    return j.valid ? 'ok' : 'dead'
  } catch {
    return 'unknown'
  }
}

// 并发受限遍历：避免一次性 100 个探测请求打爆 go-music-dl。
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const ret: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      ret[idx] = await fn(items[idx])
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return ret
}

// 批量导入整体时限：宿主网关默认 30s 会把插件调用掐成 504，但 /import/batch
// 的前端请求会带 X-Plugin-Timeout-Ms: 180000 显式放宽（上限 300s），故 50s
// 预算仍留足余量；超时则把已探明可播的歌先写库、未完成（多为换源/失效歌）
// 计入 failed，避免整批被网关 504 掐断。
export const BATCH_DEADLINE_MS = 50000

// 对单首做「下载可达性探测」判定：可导入返回 item，否则返回失效原因。
// 不尝试换源救回：换过源/失效的歌直接判 dead 丢弃，避免调用 go-music-dl
// /switch_source（极慢且常卡死）把整批拖到网关 504、连正常歌也一起丢失。
// 用户诉求是「失效歌直接不要，只导入有效歌」，故这里不求救回。
// 'unknown'（网络抖动/超时）放行，避免误杀慢速但有效的音源。
export async function resolveImportableItem(
  item: SongItem,
  config: GoMusicDlConfig,
  deadline?: { hit: boolean },
): Promise<{ item?: SongItem; reason?: string }> {
  if (deadline?.hit) return { reason: 'timeout' }
  const probe = await probeDownloadable(item, config, deadline)
  if (probe === 'dead') return { reason: 'dead' }
  // 超时且未确认可播：保守归入失败，不把不确定歌塞进曲库
  if (deadline?.hit && probe !== 'ok') return { reason: 'timeout' }
  return { item }
}

// 把一批歌曲作为 remote 歌曲一次性写进 Songloft 曲库（含 source_data）。
// 宿主 /api/v1/songs/remote 本就支持数组批量写入，这里按块切分，避免单请求体过大。
// 返回宿主创建的歌曲数组（含 id）。
export async function importRemoteSongs(items: SongItem[]): Promise<any[]> {
  // 过滤缺 id/name 的非法项，避免个别坏歌（如解析异常的换源歌）整批否决、
  // 把正常歌一起拖崩（保证正常歌稳定进库）。全部非法才报错。
  const valid = items.filter((it) => it && it.id && it.name)
  if (!valid.length) {
    throw new Error('Invalid download item')
  }
  const hostUrl = await (globalThis as any).songloft.plugin.getHostUrl()
  const token = await (globalThis as any).songloft.plugin.getToken()
  const out: any[] = []
  const CHUNK = 50
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK).map(toRemoteSongRequest)
    const res = await fetch(`${hostUrl}/api/v1/songs/remote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) {
      throw new Error(`Import failed: ${await res.text()}`)
    }
    const data = await res.json()
    const songs = Array.isArray(data.songs) ? data.songs : []
    if (!songs.length || typeof songs[0].id !== 'number') {
      throw new Error('Import response missing song id')
    }
    out.push(...songs)
  }
  return out
}

export async function importRemoteSong(item: SongItem): Promise<any> {
  const songs = await importRemoteSongs([item])
  return songs[0]
}

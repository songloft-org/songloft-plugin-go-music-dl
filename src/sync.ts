// sync.ts — 歌单手动同步引擎（单向：go-music-dl 账号歌单 → Songloft 本地歌单）
//
// 设计要点（详见 README「歌单同步」）：
// 1. 绑定模型：每张远端歌单按 `source + remoteId` 绑定一张本地歌单，
//    只存元数据（映射 + 时间 + 状态），**不存歌曲 key 集合**——
//    增量 diff 的真源是宿主歌单内容本身（GET /playlists/:id/songs 的 dedup_key），
//    用户手动删掉的歌下次同步自动补回，入库/加歌中断后重试即续传（宿主幂等）。
// 2. 宿主加歌 INSERT OR IGNORE 幂等、remote 歌曲按 dedup_key upsert，
//    因此重复同步零副作用。
// 3. 本地歌单中用户手动添加的非本插件歌曲（dedup_key 为空/不同源）绝不参与 diff，
//    不会被删除也不会被误判。
// 4. 探测+批量入库复用 import-core（与 /import/batch 同一套 50s 网关 deadline 策略），
//    超时截断标记 partial，前端提示「再点一次同步继续」。

import type { GoMusicDlConfig } from './config'
import { getConfig } from './config'
import {
  fetchCollectionSongsPage,
  buildCoverProxyUrl,
  parseSongCards,
  parsePagination,
  GoSong,
} from './client'
import { callHostApi } from './host'
import {
  SongItem,
  resolveImportableItem,
  importRemoteSongs,
  mapWithConcurrency,
  BATCH_DEADLINE_MS,
} from './import-core'

// ---------- 类型与常量 ----------

/** 远端歌单引用（由前端从 user_playlists 页面解析后上传） */
export interface RemotePlaylistRef {
  source: string
  id: string
  name?: string
  cover?: string
}

/** 绑定记录：远端歌单 ↔ 本地歌单 的映射与同步元数据 */
export interface SyncBinding {
  source: string
  remoteId: string
  remoteName: string
  remoteCover: string
  localPlaylistId: number
  lastSyncAt: number
  lastAdded: number
  lastStatus: 'ok' | 'partial' | 'failed'
  lastError?: string
}

const SYNC_KEY = 'gomusicdl_sync_bindings'

// 登录/初始化页特征（与前端 diagnoseUserPlaylists 同一套特征词）：
// go-music-dl cookie 失效时，详情接口会返回登录页 HTML 而非歌曲卡片
const AUTH_PAGE_RE =
  /登录 music-dl|初始化管理员账号|请输入用户名|setupRequired/

// 跨分页抓取上限（对齐前端 loadAllCollectionSongs 的防死循环 guard）
const MAX_PAGES = 100

// ---------- 纯函数（可单测） ----------

/** 绑定存储键 */
export function bindingKeyOf(source: string, remoteId: string): string {
  return `${source}__pl__${remoteId}`
}

/** 宿主 remote 歌曲的 dedup_key（与 import-core toRemoteSongRequest 同格式） */
export function dedupKeyOf(source: string, id: string): string {
  return `go-music-dl_${source}_${id}`
}

/**
 * 增量 diff：远端全量歌曲 vs 本地歌单现有 dedup_key 集合 → 需要新增的歌曲。
 * 本地 dedup_key 为空的歌曲（用户手动添加的本地/其他来源歌）不参与匹配，
 * 永远不会被本同步触碰。
 */
export function diffRemoteAgainstLocal(
  remote: GoSong[],
  localDedupKeys: Set<string>,
): GoSong[] {
  return remote.filter(
    (s) =>
      s &&
      s.id &&
      s.source &&
      !localDedupKeys.has(dedupKeyOf(s.source, s.id)),
  )
}

/** 绑定表的合并写入（纯函数，便于单测） */
export function mergeBinding(
  map: Record<string, SyncBinding>,
  binding: SyncBinding,
): Record<string, SyncBinding> {
  return { ...map, [bindingKeyOf(binding.source, binding.remoteId)]: binding }
}

// ---------- 绑定存储（songloft.storage，驱逐/重启不丢） ----------

export async function loadBindings(): Promise<Record<string, SyncBinding>> {
  try {
    const raw = await (globalThis as any).songloft?.storage?.get(SYNC_KEY)
    if (raw) {
      const parsed = JSON.parse(raw as string)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch (e) {
    console.error('[sync] loadBindings failed:', String(e))
  }
  return {}
}

async function saveBindings(
  map: Record<string, SyncBinding>,
): Promise<void> {
  const s = (globalThis as any).songloft?.storage
  if (s) {
    await s.set(SYNC_KEY, JSON.stringify(map))
  }
}

export async function getBinding(
  source: string,
  remoteId: string,
): Promise<SyncBinding | null> {
  const map = await loadBindings()
  return map[bindingKeyOf(source, remoteId)] || null
}

export async function listBindings(): Promise<SyncBinding[]> {
  const map = await loadBindings()
  return Object.values(map)
}

async function upsertBinding(binding: SyncBinding): Promise<void> {
  const map = await loadBindings()
  await saveBindings(mergeBinding(map, binding))
}

// ---------- 远端/本地数据抓取 ----------

/**
 * 跨分页抓取歌单全部歌曲（带单张同步全局 deadline）。
 * - deadline 到点后停止翻页，以已抓到的部分返回 → 已抓部分正常进入 diff，
 *   未抓部分下次再点同步由「本地歌单 dedup_key 真源 diff」自动续传；
 * - 登录失效检测（M1）：仅当首页「解析不出任何卡片」且页面命中登录页特征词时才判定，
 *   歌名/摘要含「请输入用户名」等词但首页正常有卡片时绝不误报。
 */
async function fetchRemoteSongs(
  config: GoMusicDlConfig,
  pl: RemotePlaylistRef,
  deadline: { hit: boolean },
): Promise<GoSong[]> {
  const all: GoSong[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (deadline.hit) break
    let html: string
    try {
      html = await fetchCollectionSongsPage(config, pl, page)
    } catch (e) {
      if (page === 1) throw e // 首页网络错误原样上抛（401/连接失败等）
      break // 翻页中断：以已抓到的为准（下次同步 diff 自动补齐）
    }
    const songs = parseSongCards(html)
    if (page === 1 && songs.length === 0 && AUTH_PAGE_RE.test(html)) {
      throw new Error(
        'go-music-dl 登录已失效（接口返回登录页），请到 go-music-dl 网页端重新扫码登录后再同步',
      )
    }
    if (!songs.length) break
    all.push(...songs)
    const p = parsePagination(html)
    if (!p || !p.totalPages || p.page >= p.totalPages) break
  }
  return all
}

/**
 * 拉取本地歌单现有的 remote 歌曲去重键集合。
 * 宿主 GET /api/v1/playlists/:id/songs 支持 limit 且无上限钳制，一次拉全量。
 * 返回结构做宽松归一（数组 / {songs} / {data:{songs}}），dedup_key 为空的歌
 * （用户手动添加的本地歌等）不进集合——它们不受同步影响。
 */
export async function fetchLocalDedupKeys(
  localPlaylistId: number,
): Promise<Set<string>> {
  const data = await callHostApi(
    'GET',
    `/api/v1/playlists/${localPlaylistId}/songs?limit=10000`,
  )
  let songs: any[] = []
  if (Array.isArray(data)) songs = data
  else if (data && Array.isArray(data.songs)) songs = data.songs
  else if (data && data.data && Array.isArray(data.data.songs))
    songs = data.data.songs
  else if (data && Array.isArray(data.items)) songs = data.items
  const keys = new Set<string>()
  for (const s of songs) {
    if (s && typeof s.dedup_key === 'string' && s.dedup_key) {
      keys.add(s.dedup_key)
    }
  }
  return keys
}

/** 宿主歌单列表返回结构归一（数组或 {playlists:[...]}） */
function toPlaylistArray(result: any): any[] {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.playlists)) return result.playlists
  if (result && result.data && Array.isArray(result.data.playlists))
    return result.data.playlists
  return []
}

/**
 * 解析本地歌单 id：已绑定则校验仍存在（被删则重建）；
 * 未绑定则同名幂等复用（与前端 importCollectionAsPlaylist 同策略），无同名才创建。
 */
async function resolveLocalPlaylist(
  config: GoMusicDlConfig,
  pl: RemotePlaylistRef,
  binding: SyncBinding | null,
): Promise<number> {
  // 1) 已绑定：校验歌单仍存在
  if (binding && binding.localPlaylistId) {
    try {
      await callHostApi('GET', `/api/v1/playlists/${binding.localPlaylistId}`)
      return binding.localPlaylistId
    } catch {
      /* 歌单已被用户删除：走下方重建 */
    }
  }
  // 2) 同名幂等复用
  const name = (pl.name || '').trim() || `${pl.source} 同步歌单`
  let candidates: any[] = []
  try {
    candidates = toPlaylistArray(
      await callHostApi('GET', '/api/v1/playlists?limit=1000'),
    )
  } catch {
    /* 拉不到列表就跳过复用，直接创建 */
  }
  const existed = candidates.find((p: any) => p && p.name === name && p.id)
  if (existed) return Number(existed.id)
  // 3) 创建（封面走 go-music-dl cover_proxy 代理，规避防盗链空白封面）
  const created = await callHostApi('POST', '/api/v1/playlists', {
    name,
    type: 'normal',
    cover_url: buildCoverProxyUrl(pl.cover || '', config.baseUrl),
  })
  if (!created || !created.id) {
    throw new Error('创建本地歌单失败')
  }
  return Number(created.id)
}

// ---------- 单张同步编排 ----------

export interface SyncOneResult {
  status: 'ok' | 'partial' | 'failed'
  source: string
  remoteId: string
  localPlaylistId?: number
  remoteTotal: number
  /** 本次实际加进歌单的歌数（宿主 added） */
  added: number
  /** 确认失效被丢弃的歌数 */
  dead: number
  /** 因 50s deadline 截断未处理完的歌数（>0 即 partial，重试续传） */
  pending: number
  message?: string
}

/**
 * 同步单张远端歌单：
 * 抓远端全量 → 解析/创建本地歌单 → diff 新增 → 探测+批量入库 → 幂等加歌单 → 更新绑定。
 * 任一环节失败都以 partial/failed 返回而非抛异常中断（错误信息进 result.message），
 * 便于前端串行多张时单张失败不阻断后续。
 */
export async function syncOne(pl: RemotePlaylistRef): Promise<SyncOneResult> {
  const base: SyncOneResult = {
    status: 'failed',
    source: pl.source,
    remoteId: pl.id,
    remoteTotal: 0,
    added: 0,
    dead: 0,
    pending: 0,
  }
  const config = await getConfig()
  if (!config.baseUrl) {
    return { ...base, message: '服务地址未配置，请先在插件设置中填写' }
  }
  // 1) 远端全量（含登录失效检测）
  let remote: GoSong[]
  const fetchDeadline = { hit: false }
  const fetchTimer = setTimeout(() => { fetchDeadline.hit = true }, BATCH_DEADLINE_MS)
  try {
    remote = await fetchRemoteSongs(config, pl, fetchDeadline)
    clearTimeout(fetchTimer)
  } catch (e) {
    clearTimeout(fetchTimer)
    return { ...base, message: String((e as Error)?.message || e) }
  }
  if (!remote.length) {
    return {
      ...base,
      status: 'ok',
      message: '远端歌单为空（或该源未返回任何歌曲）',
    }
  }
  // 2) 解析/创建本地歌单 + diff
  let localId: number
  try {
    const binding = await getBinding(pl.source, pl.id)
    localId = await resolveLocalPlaylist(config, pl, binding)
  } catch (e) {
    return { ...base, message: String((e as Error)?.message || e) }
  }
  let newSongs: GoSong[]
  try {
    const localKeys = await fetchLocalDedupKeys(localId)
    newSongs = diffRemoteAgainstLocal(remote, localKeys)
  } catch (e) {
    return {
      ...base,
      localPlaylistId: localId,
      remoteTotal: remote.length,
      message: String((e as Error)?.message || e),
    }
  }
  const finish = async (
    status: SyncOneResult['status'],
    added: number,
    dead: number,
    pending: number,
    message?: string,
  ): Promise<SyncOneResult> => {
    await upsertBinding({
      source: pl.source,
      remoteId: pl.id,
      remoteName: pl.name || '',
      remoteCover: pl.cover || '',
      localPlaylistId: localId,
      lastSyncAt: Date.now(),
      lastAdded: added,
      lastStatus: status,
      lastError: status === 'failed' ? message : undefined,
    })
    return {
      status,
      source: pl.source,
      remoteId: pl.id,
      localPlaylistId: localId,
      remoteTotal: remote.length,
      added,
      dead,
      pending,
      message,
    }
  }
  if (!newSongs.length) {
    // 全部已同步（或远端回退了）：幂等刷新一次绑定时间戳
    return finish('ok', 0, 0, 0)
  }
  // 3) 探测 + 批量入库（复用 /import/batch 的 deadline 与并发策略）
  const deadline = { hit: false }
  const timer = setTimeout(() => {
    deadline.hit = true
  }, BATCH_DEADLINE_MS)
  let imported: any[] = []
  let dead = 0
  let pending = 0
  try {
    const results = await mapWithConcurrency(newSongs, 8, (it) =>
      resolveImportableItem(it, config, deadline),
    )
    const okItems: SongItem[] = []
    for (const r of results) {
      if (r.item) okItems.push(r.item)
      else if (r.reason === 'dead') dead++
      else pending++ // deadline 截断的未处理歌（reason === 'timeout'）
    }
    if (okItems.length) {
      imported = await importRemoteSongs(okItems)
    }
  } catch (e) {
    clearTimeout(timer)
    // 入库整体失败（如宿主不可达）：下次重试 diff 会重新补齐
    return finish(
      'partial',
      0,
      dead,
      newSongs.length - dead,
      String((e as Error)?.message || e),
    )
  }
  clearTimeout(timer)
  // 4) 幂等加歌单（INSERT OR IGNORE，已存在自动 skipped）
  let added = 0
  try {
    const ids = imported
      .map((s) => s.id)
      .filter((id) => typeof id === 'number')
    if (ids.length) {
      const addRes = await callHostApi(
        'POST',
        `/api/v1/playlists/${localId}/songs`,
        { song_ids: ids },
      )
      added = Number(addRes && addRes.added) || 0
    }
  } catch (e) {
    // 歌已在曲库但未进歌单：下次同步 diff（按 dedup_key）仍视为新增，重试即续传
    return finish(
      'partial',
      0,
      dead,
      pending + imported.length,
      String((e as Error)?.message || e),
    )
  }
  const status: SyncOneResult['status'] = pending > 0 ? 'partial' : 'ok'
  const message =
    pending > 0
      ? `因超时截断，还有 ${pending} 首未处理，请再点一次同步继续`
      : undefined
  return finish(status, added, dead, pending, message)
}

// go-music-api 双后端映射纯函数测试（由 npm test 预先转译到 tests/.gen/client.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapApiSong,
  mapApiPlaylist,
  slicePage,
  API_PAGE_SIZE,
} from './.gen/client.mjs'

test('mapApiSong：api model.Song → GoSong 字段收口与兜底', () => {
  const s = mapApiSong(
    {
      id: '123',
      source: 'netease',
      name: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      cover: 'http://x/1.jpg',
      duration: 269,
      extra: { level: 'exhigh' },
    },
    'netease',
  )
  assert.equal(s.id, '123')
  assert.equal(s.source, 'netease')
  assert.equal(s.duration, 269)
  assert.deepEqual(s.extra, { level: 'exhigh' })
  // 坏数据兜底：null 歌 + fallback source
  const empty = mapApiSong(null, 'qq')
  assert.equal(empty.source, 'qq')
  assert.equal(empty.duration, 0)
  assert.deepEqual(empty.extra, {})
})

test('mapApiPlaylist：api model.Playlist → GoCollection（name→title、track_count→count）', () => {
  const p = mapApiPlaylist(
    {
      id: 'p1',
      source: 'netease',
      name: '华语热歌',
      cover: 'http://x/c.jpg',
      creator: '网易云',
      track_count: 100,
    },
    'netease',
  )
  assert.equal(p.id, 'p1')
  assert.equal(p.title, '华语热歌')
  assert.equal(p.count, 100)
  assert.equal(p.contentType, 'playlist')
  // 专辑搜索结果走同一映射后由调用方覆盖 contentType
  const a = { ...mapApiPlaylist({ id: 'a1', name: '专辑' }, 'qq'), contentType: 'album' }
  assert.equal(a.contentType, 'album')
})

test('slicePage：内存切片分页（对齐 API_PAGE_SIZE）', () => {
  assert.equal(API_PAGE_SIZE, 200)
  const items = Array.from({ length: 450 }, (_, i) => i)
  const p1 = slicePage(items, 1)
  assert.equal(p1.total, 450)
  assert.equal(p1.totalPages, 3)
  assert.equal(p1.items.length, 200)
  assert.equal(p1.items[0], 0)
  const p3 = slicePage(items, 3)
  assert.equal(p3.items.length, 50)
  assert.equal(p3.items[0], 400)
  // 越界页收敛到最后一页
  const p9 = slicePage(items, 9)
  assert.equal(p9.items.length, 50)
  // 空列表
  const pe = slicePage([], 1)
  assert.equal(pe.total, 0)
  assert.equal(pe.totalPages, 1)
  assert.equal(pe.items.length, 0)
})

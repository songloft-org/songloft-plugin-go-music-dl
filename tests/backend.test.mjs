// 后端 src/*.ts 纯函数测试：由 npm test 预先用 esbuild 转译到 tests/.gen/ 再导入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSongCards,
  parsePagination,
  parsePlaylistCards,
  buildDownloadUrl,
  buildInspectUrl,
  sortSongsByRelevance,
} from './.gen/client.mjs'
import { encodeToken, decodeToken } from './.gen/contract.mjs'

test('parseSongCards 解析 data-* 属性（含单引号 data-extra JSON）', () => {
  const html = `<ul>
    <li class="song-card" data-id="123" data-source="netease" data-name="晴天"
        data-artist="周杰伦" data-album="叶惠美" data-cover="http://x/1.jpg"
        data-duration="269" data-extra='{"level":"exhigh"}'></li>
    <li class="song-card" data-id="" data-source="qq"></li>
  </ul>`
  const songs = parseSongCards(html)
  assert.equal(songs.length, 1) // 缺 id 的卡片跳过
  assert.equal(songs[0].id, '123')
  assert.equal(songs[0].source, 'netease')
  assert.equal(songs[0].name, '晴天')
  assert.equal(songs[0].duration, 269)
  assert.deepEqual(songs[0].extra, { level: 'exhigh' })
})

test('parsePagination 解析中文分页摘要 + 缺摘要兜底', () => {
  const p = parsePagination('当前第 2 / 5 页，显示 31 - 60 / 150')
  assert.deepEqual(p, { page: 2, totalPages: 5, total: 150, pageStart: 31, pageEnd: 60, inferred: true })
  const empty = parsePagination('<div>没有摘要</div>')
  assert.deepEqual(empty, { page: 1, totalPages: 1, pageStart: 0, pageEnd: 0, total: 0, inferred: false })
})

test('parsePlaylistCards 解析导入按钮 data-* 序列', () => {
  const html = `<div><button class="ctrl-btn primary" data-name="华语经典" data-cover="http://c.jpg"
    data-creator="官方" data-track-count="50" data-source="qq" data-external-id="9" data-content-type="album"></button></div>`
  const cards = parsePlaylistCards(html)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].id, '9')
  assert.equal(cards[0].title, '华语经典')
  assert.equal(cards[0].contentType, 'album')
})

test('buildDownloadUrl / buildInspectUrl 拼参与 URL 编码', () => {
  const song = { id: 'a b', source: 'netease', name: '晴天', artist: '周', album: '', cover: '', duration: 269, extra: { level: 'hires' } }
  const dl = buildDownloadUrl(song, 'http://h:8080', true)
  assert.equal(dl, 'http://h:8080/music/download?id=a%20b&source=netease&extra=%7B%22level%22%3A%22hires%22%7D&embed=1')
  const stream = buildDownloadUrl(song, 'http://h:8080', false)
  assert.match(stream, /&stream=1$/)
  const ins = buildInspectUrl(song, 'http://h:8080')
  assert.equal(ins, 'http://h:8080/music/inspect?id=a%20b&source=netease&duration=269&extra=%7B%22level%22%3A%22hires%22%7D')
  assert.equal(buildInspectUrl(song, ''), '') // 未配置 baseUrl → 空串（上层按不可用处理）
})

test('sortSongsByRelevance：精确原唱优先、衍生版本降权', () => {
  // 同歌手下原曲与 Live 并存：降权前两者分数持平（稳定序会保持 Live 在前），
  // 降权后精确原唱必须胜出——用 sorted[0] 断言验证惩罚生效
  const songs = [
    { name: '晴天 Live', artist: '周杰伦', album: '' },
    { name: '晴天', artist: '周杰伦', album: '叶惠美' },
  ]
  const sorted = sortSongsByRelevance(songs, '晴天 周杰伦')
  assert.equal(sorted[0].name, '晴天')
  assert.equal(sorted[1].name, '晴天 Live')
})

test('sortSongsByRelevance：检索词含衍生词时不降权', () => {
  const songs = [
    { name: '晴天', artist: '周杰伦', album: '叶惠美' },
    { name: '晴天 Live', artist: '周杰伦', album: '' },
  ]
  const sorted = sortSongsByRelevance(songs, '晴天 live')
  assert.equal(sorted[0].name, '晴天 Live')
})

test('encodeToken/decodeToken 往返（对象含中文与特殊字符）', () => {
  // encodeToken 契约：对象 JSON 序列化后转 base64url；decodeToken 反序列化还原
  const song = { id: '123', source: 'netease', name: '晴天 & Live「测试」', extra: { a: 1 } }
  const tok = encodeToken(song)
  assert.ok(!/[+/=]/.test(tok), 'token 为 URL 安全的 base64url')
  assert.deepEqual(decodeToken(tok), song)
})

// 后端 src/*.ts 纯函数测试：由 npm test 预先用 esbuild 转译到 tests/.gen/ 再导入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSongCards,
  parsePagination,
  parsePlaylistCards,
  parseTopListCards,
  buildDownloadUrl,
  buildInspectUrl,
  sortSongsByRelevance,
  buildCoverProxyUrl,
} from './.gen/client.mjs'
import { encodeToken, decodeToken } from './.gen/contract.mjs'

test('api 模式 /api/v1 端点挂在服务根，不带 --base-path 网页前缀', () => {
  const song = { id: 'x', source: 'qq', duration: 1, extra: {} }
  assert.equal(
    buildInspectUrl(song, 'http://h:8080', '/music', true),
    'http://h:8080/api/v1/music/inspect?id=x&source=qq&duration=1',
  )
  assert.equal(
    buildCoverProxyUrl('http://cdn/a.jpg', 'http://h:8080', '/music', true),
    'http://h:8080/api/v1/music/cover?url=http%3A%2F%2Fcdn%2Fa.jpg',
  )
  // gmd 模式仍按 basePath 拼网页端点
  assert.match(
    buildInspectUrl(song, 'http://h:8080', '/dl', false),
    /^http:\/\/h:8080\/dl\/inspect/,
  )
})

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
  const dl = buildDownloadUrl(song, 'http://h:8080', '/music', true)
  assert.equal(dl, 'http://h:8080/music/download?id=a%20b&source=netease&extra=%7B%22level%22%3A%22hires%22%7D&embed=1')
  const stream = buildDownloadUrl(song, 'http://h:8080', '/music', false)
  assert.match(stream, /&stream=1$/)
  const ins = buildInspectUrl(song, 'http://h:8080', '/music')
  assert.equal(ins, 'http://h:8080/music/inspect?id=a%20b&source=netease&duration=269&extra=%7B%22level%22%3A%22hires%22%7D')
  assert.equal(buildInspectUrl(song, ''), '') // 未配置 baseUrl → 空串（上层按不可用处理）
  assert.equal(buildDownloadUrl(song, ''), '') // 同上：空 base 返回空串（router 的 404 守卫依赖此约定）
})

test('buildDownloadUrl / buildInspectUrl 自定义 basePath（上游 --base-path）', () => {
  const song = { id: 'x', source: 'qq', name: '歌', artist: '手', album: '', cover: '', duration: 1, extra: {} }
  assert.match(buildDownloadUrl(song, 'http://h:8080', '/dl', true), /^http:\/\/h:8080\/dl\/download/)
  assert.match(buildInspectUrl(song, 'http://h:8080', '/dl'), /^http:\/\/h:8080\/dl\/inspect/)
  // basePath 缺省回退 /music（旧调用点兼容）
  assert.match(buildDownloadUrl(song, 'http://h:8080', undefined, true), /^http:\/\/h:8080\/music\/download/)
  assert.match(buildInspectUrl(song, 'http://h:8080'), /^http:\/\/h:8080\/music\/inspect/)
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

test('parseTopListCards：从榜单卡片 href query 提取字段、去重并读取播放量文本', () => {
  const card = (q, body = '') =>
    `<a class="toplist-card" href="/music/toplist_songs?${q}">${body}</a>`
  const withPlay =
    '<div class="toplist-sub"><span><i class="fa-solid fa-music"></i> 100 首</span>' +
    '<span><i class="fa-solid fa-headphones"></i> 65.1亿</span></div>'
  const html = [
    card('source=netease&amp;toplist_id=19723756&amp;toplist_name=%E9%A3%99%E5%8D%87%E6%A6%9C&amp;update_frequency=%E6%AF%8F%E6%97%A5%E6%9B%B4%E6%96%B0&amp;cover=http%3A%2F%2Fx%2F1.jpg&amp;track_count=100', withPlay),
    card('source=netease&amp;toplist_id=19723756&amp;toplist_name=%E9%A3%99%E5%8D%87%E6%A6%9C'),
    card('source=qq&amp;toplist_id=26&amp;toplist_name=%E5%B3%B0%E5%B3%B0%E6%A6%9C'),
    card('source=qq&amp;toplist_id='),
  ].join('\n')
  const lists = parseTopListCards(html)
  // 同 source+id 去重、缺 toplist_id 跳过
  assert.equal(lists.length, 2)
  assert.equal(lists[0].source, 'netease')
  assert.equal(lists[0].toplistId, '19723756')
  assert.equal(lists[0].name, '飙升榜')
  assert.equal(lists[0].updateFrequency, '每日更新')
  assert.equal(lists[0].cover, 'http://x/1.jpg')
  assert.equal(lists[0].trackCount, 100)
  // [C] 只有带耳机图标 span 的卡片有播放量，且是上游已格式化的文本
  assert.equal(lists[0].playCountText, '65.1亿')
  assert.equal(lists[1].source, 'qq')
  assert.equal(lists[1].toplistId, '26')
  assert.equal(lists[1].playCountText, '')
})

test('parseSongCards 保留榜单名次 rank（供前端显示真实排名）', () => {
  const html = `<ul><li class="song-card" data-id="1" data-source="qq" data-name="A"
      data-artist="B" data-album="" data-cover="" data-duration="200"
      data-extra='{"rank":7,"toplist_id":"26"}'></li></ul>`
  const songs = parseSongCards(html)
  assert.equal(songs.length, 1)
  assert.equal(songs[0].extra.rank, 7)
})

test('parseTopListCards：description 含 &#43; 时不再吞掉 toplist_id', () => {
  // 线上真实形态：Go html/template 把 URL 里的 `+` 转义成 &#43;，
  // 未解码时残留的 # 会被 new URL 当成 fragment 起点，
  // 其后的 &source=..&toplist_id=.. 全部丢失，卡片被误判为「无 ID」而丢弃。
  const href =
    '/music/toplist_songs?cover=http%3A%2F%2Fx%2Fc.jpg' +
    '&amp;description=%E6%96%B0%E6%AD%8C%E6%A6%9C&#43;TOP' +
    '&amp;source=netease&amp;toplist_id=3779629&amp;toplist_name=%E6%96%B0%E6%AD%8C%E6%A6%9C'
  const card = (h) => `<a class="toplist-card" href="${h}"></a>`
  const lists = parseTopListCards(card(href))
  assert.equal(lists.length, 1)
  assert.equal(lists[0].source, 'netease')
  assert.equal(lists[0].toplistId, '3779629')
  assert.equal(lists[0].name, '新歌榜')
  // 十六进制实体同样要还原
  assert.equal(
    parseTopListCards(card(href.replace('&#43;', '&#x2B;')))[0].toplistId,
    '3779629',
  )
})

// state.js — 共享状态、常量与纯函数（无副作用、不依赖其他业务模块）
// 与 go-music-dl 的 GetAllSourceNames / GetSourceDescription 保持一致。
// 排除 "local"（本地音乐，非可在线搜索的音源平台）。
export const SOURCE_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  fivesing: '5sing',
  jamendo: 'Jamendo',
  joox: 'JOOX',
  qianqian: '千千音乐',
  soda: '汽水音乐',
  bilibili: 'Bilibili',
  apple: 'Apple Music',
}
export const ALL_SOURCES = Object.keys(SOURCE_LABELS)

export function sourceLabel(s) {
  return SOURCE_LABELS[s] || s
}

// 音质档位（对应网易云 level 取值）。UI 文案与后端 Extra.level 一致。
export const QUALITY_OPTIONS = [
  { value: 'standard', label: '标准' },
  { value: 'exhigh', label: '高品质' },
  { value: 'lossless', label: '无损' },
  { value: 'hires', label: 'Hi-Res' },
]

// 封面加载失败兜底（第三方 CDN 防盗链/证书问题），用内联 SVG 避免再次网络请求
export const FALLBACK_COVER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">' +
      '<rect width="48" height="48" rx="8" fill="#3a3a3a"/>' +
      '<text x="24" y="32" font-size="26" text-anchor="middle" fill="#9a9a9a">♪</text>' +
      '</svg>',
  )

// 未播放 / 无封面时，迷你播放条封面显示插件图标
export const PLUGIN_ICON = 'static/icon.svg'

// 播放失败自动换源：原样重试耗尽后，最多再自动换 N 个音源再播
export const MAX_AUDIO_RETRY = 3
export const MAX_AUDIO_SWITCH = 3
// 检测阶段失效歌曲多轮换源上限（每轮换到仍失效就换下一个源）
export const MAX_SWITCH_ROUNDS = 4

// 跨模块共享的可变状态。统一放在 store 上，各模块只“修改属性”不“重新赋值整个对象”，
// 以兼容 ES Module 的不可变绑定语义（builder 仍会打包成单个 iife）。
export const store = {
  config: {
    baseUrl: 'http://127.0.0.1:58091',
    sources: [...ALL_SOURCES],
    defaultQuality: 'exhigh', // 默认音质：standard(128) / exhigh(320) / lossless(FLAC) / hires(Hi-Res)，仅网易云生效
  },
  // 播放时的当前音质（用户可在播放器内临时切换），初始化为默认音质
  currentQuality: 'exhigh',
  // 搜索类型：单曲 / 歌单 / 专辑
  currentSearchType: 'song',
  // 推荐
  recommendLoaded: false,
  recommendPlaylists: [],
  recommendCat: 'all',
  // 播放队列
  queue: [],
  currentIndex: -1,
  // 歌词
  fpLyrics: [],
  lastLyricIndex: -1,
  // 全屏
  isFpOpen: false,
  // 我的歌单
  myListLoaded: false,
  allPlaylists: [],
  currentCat: 'all',
  songsBackToMyList: false,
  // 多选 / 批量导入
  selectMode: false,
  selectedSongs: new Map(),
  batchImport: false,
  batchList: [],
  // 导入面板
  pendingImportItem: null,
  importPlaylists: [],
  newPlaylistCallback: null,
  // 音频重试
  audioRetry: 0,
  audioSwitchRetry: 0,
  audioSwitching: false,
}

// 卡片与歌曲数据的绑定（避免挂在 DOM 上导致类型/序列化问题）
export const cardData = new WeakMap()

// 当前生效音质：播放器内临时切换优先，否则用默认音质
export function effectiveQuality() {
  return store.currentQuality || store.config.defaultQuality || 'exhigh'
}

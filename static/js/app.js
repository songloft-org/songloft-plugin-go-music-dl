// app.js — 入口：初始化播放器/标签页、绑定事件、启动应用。
// 其余业务逻辑拆分到同目录的 ES Module 中，由 builder（esbuild）打包为单个 app.bundle.js。
import { store, MAX_AUDIO_RETRY, MAX_AUDIO_SWITCH } from './state.js'
import {
  getAudio,
  setPlayIcon,
  syncProgress,
  nextSong,
  togglePlay,
  prevSong,
  startAudio,
} from './player.js'
import {
  openFullscreenPlayer,
  closeFullscreenPlayer,
  toggleLyricPage,
  bindSeek,
} from './fullscreen.js'
import { testConnection, switchSource } from './api.js'
import { applySwitchedSong } from './songlist.js'
import { showSnackbar } from './util.js'
import { loadConfig, saveConfig, setAllSources } from './config.js'
import {
  doSearch,
  loadRecommend,
  showBrowserHome,
  backToBrowserHome,
} from './search.js'
import { loadUserPlaylists, backToPlaylists } from './playlists.js'
import {
  loadDiscoverRecommend,
  loadDiscoverCategories,
} from './discover.js'
import {
  openImportPanel,
  closeImportPanel,
  importToLibrary,
  importToPlaylist,
  createNewPlaylist,
  closeNewPlaylistDialog,
  confirmNewPlaylist,
  setSelectMode,
  updateBatchBar,
  openImportPanelForBatch,
} from './imports.js'

function initTabs() {
  document.querySelectorAll('.tab-item').forEach((tab) => {
    tab.onclick = () => {
      // 切换 tab 时收起歌单详情全屏浮层，并把歌单列表视图恢复可见。
      // 否则若此前从「搜索」页进入详情（songsBackToMyList=false），backToPlaylists 不会恢复
      // myPlaylistView，回到「我的歌单」时列表视图仍为 display:none → 整页白屏（只能刷新）。
      document.getElementById('mySongsView').style.display = 'none'
      document.getElementById('myPlaylistView').style.display = 'block'
      document
        .querySelectorAll('.tab-item')
        .forEach((t) => t.classList.remove('active'))
      document
        .querySelectorAll('.tab-content')
        .forEach((c) => c.classList.remove('active'))
      tab.classList.add('active')
      document
        .getElementById('tab-' + tab.dataset.tab)
        .classList.add('active')
      if (tab.dataset.tab === 'mylist' && !store.myListLoaded) loadUserPlaylists()
      if (tab.dataset.tab === 'discover' && !store.discoverRecommendLoaded)
        loadDiscoverRecommend()
      if (tab.dataset.tab === 'browser') showBrowserHome()
    }
  })
}

function initPlayer() {
  const audio = getAudio()
  audio.addEventListener('loadedmetadata', () => {
    // 加载成功：若此前显示「重试/换源中」的进行态提示（含 spinner），清除它
    const sb = document.getElementById('snackbar')
    if (sb && sb.querySelector('.snackbar-spinner')) hideSnackbar()
    store.audioRetry = 0
    syncProgress()
  })
  audio.addEventListener('timeupdate', syncProgress)
  audio.addEventListener('play', () => setPlayIcon(true))
  audio.addEventListener('pause', () => setPlayIcon(false))
  audio.addEventListener('ended', nextSong)
  audio.addEventListener('error', async () => {
    const song = store.queue[store.currentIndex]
    if (!song || store.audioSwitching) return
    // 先原样重试（处理偶发网络抖动）
    if (store.audioRetry < MAX_AUDIO_RETRY) {
      store.audioRetry++
      showSnackbar(`加载失败，正在重试 (${store.audioRetry}/${MAX_AUDIO_RETRY})…`, true)
      setTimeout(() => startAudio(song, store.audioRetry), 700 * store.audioRetry)
      return
    }
    // 原样重试仍失败 → 自动换源再播（增强体验，无需用户手动操作）
    if (store.audioSwitchRetry < MAX_AUDIO_SWITCH) {
      store.audioSwitching = true
      store.audioSwitchRetry++
      showSnackbar(
        `当前音源不可播放，正在自动换源 (${store.audioSwitchRetry}/${MAX_AUDIO_SWITCH})…`,
        true,
      )
      try {
        const alt = await switchSource(song, { current: song.source })
        if (alt && typeof alt === 'object') {
          store.queue[store.currentIndex] = alt
          const card = document.querySelectorAll('#browserList .song-row')[
            store.currentIndex
          ]
          if (card) applySwitchedSong(card, alt)
          store.audioRetry = 0
          startAudio(alt, 0)
          return
        }
      } catch (e) {
        /* 换源异常，落到最终提示 */
      } finally {
        store.audioSwitching = false
      }
    }
    showSnackbar('播放失败：已尝试换源仍无法播放，可换一首或稍后重试。')
  })

  document.getElementById('pbPlayBtn').onclick = togglePlay
  document.getElementById('fpPlayBtn').onclick = togglePlay
  document.getElementById('fpPrevBtn').onclick = prevSong
  document.getElementById('fpNextBtn').onclick = nextSong
  document.getElementById('fpLyricToggle').onclick = toggleLyricPage

  bindSeek('pbTrack')
  bindSeek('fpProgressTrack')

  // 供 index.html 内联 onclick 调用
  window.openFullscreenPlayer = openFullscreenPlayer
  window.closeFullscreenPlayer = closeFullscreenPlayer
  window.openImportPanel = openImportPanel
  window.closeImportPanel = closeImportPanel
  window.importToLibrary = importToLibrary
  window.importToPlaylist = importToPlaylist
  window.createNewPlaylist = createNewPlaylist
  window.closeNewPlaylistDialog = closeNewPlaylistDialog
  window.confirmNewPlaylist = confirmNewPlaylist
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs()
  initPlayer()
  loadConfig().then(() => showBrowserHome())
  document.getElementById('searchBtn').onclick = () => doSearch()
  document
    .getElementById('searchInput')
    .addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch()
    })
  // 搜索框「单曲 / 歌单 / 专辑」分段切换
  document.getElementById('searchTypeSwitch').querySelectorAll('.mylist-cat').forEach((btn) => {
    btn.onclick = () => {
      document
        .getElementById('searchTypeSwitch')
        .querySelectorAll('.mylist-cat')
        .forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      store.currentSearchType = btn.dataset.type || 'song'
    }
  })
  document.getElementById('saveConfigBtn').onclick = saveConfig
  document.getElementById('testConnBtn').onclick = testConnection
  // 全选 / 清空：切换勾选后立即保存，免去再点「保存配置」
  document.getElementById('selectAllSourcesBtn').onclick = () => { setAllSources(true); saveConfig() }
  document.getElementById('clearAllSourcesBtn').onclick = () => { setAllSources(false); saveConfig() }
  // 单个音源勾选变动也即时保存
  document.getElementById('configSources').addEventListener('change', () => saveConfig())
  // 默认音质下拉改动即时保存（与其他设置项一致），保存后同步 currentQuality 立即生效
  const dq = document.getElementById('configDefaultQuality')
  if (dq) dq.addEventListener('change', () => {
    store.config.defaultQuality = dq.value
    store.currentQuality = dq.value
    saveConfig()
  })
  // 头部「刷新」：在搜索首页刷新推荐，否则执行搜索
  document.getElementById('refreshBtn').onclick = () => {
    const browserTab = document.querySelector('.tab-item[data-tab="browser"]')
    const isBrowser = browserTab && browserTab.classList.contains('active')
    if (isBrowser && document.getElementById('recommendCard').style.display !== 'none') {
      store.recommendLoaded = false
      loadRecommend()
    } else {
      doSearch()
    }
  }
  document.getElementById('refreshRecommendBtn').onclick = () => {
    store.recommendLoaded = false
    loadRecommend()
  }
  document.getElementById('refreshMyListBtn').onclick = loadUserPlaylists
  // 发现页：每日推荐 / 分类歌单 子切换
  const discoverSub = document.getElementById('discoverSubSwitch')
  if (discoverSub) {
    discoverSub.querySelectorAll('.mylist-cat').forEach((btn) => {
      btn.onclick = () => {
        discoverSub
          .querySelectorAll('.mylist-cat')
          .forEach((b) => b.classList.remove('active'))
        btn.classList.add('active')
        const sub = btn.dataset.sub
        document.getElementById('discoverRecommendSection').style.display =
          sub === 'recommend' ? 'block' : 'none'
        document.getElementById('discoverCategoriesSection').style.display =
          sub === 'categories' ? 'block' : 'none'
        if (sub === 'recommend' && !store.discoverRecommendLoaded)
          loadDiscoverRecommend()
        if (sub === 'categories' && !store.discoverCatsLoaded)
          loadDiscoverCategories()
      }
    })
  }
  const refreshDiscoverRecommendBtn = document.getElementById(
    'refreshDiscoverRecommendBtn',
  )
  if (refreshDiscoverRecommendBtn)
    refreshDiscoverRecommendBtn.onclick = loadDiscoverRecommend
  document.getElementById('backToPlaylistsBtn').onclick = backToPlaylists
  // 搜索结果页「返回首页」：回到每日推荐，无需刷新整页
  document.getElementById('backToHomeBtn').onclick = backToBrowserHome
  const confirmNewPlaylistBtn = document.getElementById('confirmNewPlaylist')
  if (confirmNewPlaylistBtn) confirmNewPlaylistBtn.onclick = confirmNewPlaylist
  // 批量多选：切换多选模式 + 底部批量操作栏
  const batchToggleBtn = document.getElementById('batchToggleBtn')
  if (batchToggleBtn) batchToggleBtn.onclick = () => setSelectMode(!store.selectMode)
  const batchToLibraryBtn = document.getElementById('batchToLibraryBtn')
  if (batchToLibraryBtn) batchToLibraryBtn.onclick = () => {
    if (!store.selectedSongs.size) return
    store.batchImport = true
    store.batchList = [...store.selectedSongs.values()]
    importToLibrary()
  }
  const batchToPlaylistBtn = document.getElementById('batchToPlaylistBtn')
  if (batchToPlaylistBtn) batchToPlaylistBtn.onclick = () => openImportPanelForBatch()
  const batchClearBtn = document.getElementById('batchClearBtn')
  if (batchClearBtn) batchClearBtn.onclick = () => {
    store.selectedSongs.clear()
    updateBatchBar()
  }
})

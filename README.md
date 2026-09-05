# Songloft Plugin: Go Music DL

一个把 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) 接入 Songloft 的音源插件。
它让 Songloft 直接通过本地或远程的 go-music-dl 实例聚合搜索网易云、QQ、酷狗、酷我、咪咕、Bilibili 等音源，并支持试听、歌词与导入本地库。



## 配置

在插件设置页填写：

- **go-music-dl 实例地址**：例如 `http://192.168.1.1:8080/music`（默认端口8080）。
- **搜索音源**：勾选需要参与搜索的平台。

### MIoT 口令联动

本插件已内置 `/api/search/topone` 端点，兼容 MIoT 智能音箱插件的 `OnlineSearcher` 契约。

插件在 `onInit` 时会通过插件间通信（`songloft.comm`）**自动把自身注册为 MIoT 的「外部搜索源候选」**（显示名 `GoMusicDL`）。在 miot 配置页即可一键选用，无需手写 URL。

之后对小爱说「播放 XXX」即会经 go-music-dl 搜索歌曲并通过音箱出声。

### 投放到音箱

插件底部迷你播放条右端有音箱图标，点击后列出 MIoT 插件下的所有小爱音箱设备（按账号分组），
点选即「连接」——此后插件内的一切播放（点歌、上一首/下一首、暂停、自动切歌）都转由音箱发声；
点「断开连接」则从音箱当前进度**无缝回本地续播**。

- 连接通过跨插件 HTTP 复用 miot 的 `/mina/*` 控制面（设备列表 / play-url / pause / resume / stop / volume / status），**miot 插件无需任何改动**。
- 音箱拉流走本插件 `/stream/:token` 302 直链（与口令直推同一机制），要求音箱可直连宿主：
  直链由后端 `/cast/stream-url` 按「serverHost → baseUrl host → 宿主地址 → 网卡 LAN 地址」四级推导，
  推导失败（如宿主只监听 127.0.0.1 且未填对外可达地址）时投放入口会提示配置。
- 连接选择持久化，刷新插件页后自动重连并接上音箱进度；音箱端支持设备组组网分发。
- 连接后可在投放面板内**滑杆调节音箱音量**（设备全局音量 0-100；拖动节流下发不刷爆云端，
  松手即按最终值生效；全屏播放器的静音按钮与滑杆联动）。
- **v1 已知限制**（受小米 MiNA 云端能力约束）：投放模式下不支持拖动进度条（云端无 seek 命令）；
  语音打断音箱时插件 UI 可能失真（状态探针无曲目标识）。

### 「不入库直接播放」与本插件 /stream 路由

MIoT 的 `external_search_no_import` 开关开启后，会把 `topone` 返回的 `url` 原样直推给音箱播放。
该 `url` 由本插件 `makeDirectStreamUrl` 直接拼出，**已不再依赖桥接插件（songloft-plugin-bridge）**：

- `topone` 返回形如 `http://<Songloft LAN>:<端口>/api/v1/jsplugin/go-music-dl/stream/<token>` 的直链。
- 音箱访问该 URL → 本插件 `/stream/:token` 路由 decode token 后 **302 重定向** 到 go-music-dl 真实直链，
  由音箱直连原生 Go 服务器拉流（支持 Range / 大文件，不经 QuickJS 缓冲避免 504）。
- 该路由已在 `plugin.json` 的 `publicPaths` 中声明免鉴权，**要求宿主版本 ≥ 2.7.0**。

**对外可达 host 推导（4 级优先级，全部失败时 url 置空 → MIoT 回退入库播放）：**
1. `serverHost`（推荐）：用户在「插件设置 → 对外可达地址」显式填写的音箱可直连地址，覆盖反代/异网场景。
2. `baseUrl` 的 host：go-music-dl 后端若部署在 LAN 某台机器（如 `192.168.1.190:8080`），
   则同一台机器跑的 Songloft 也通常可达该 IP，用该 host + Songloft 端口。
3. `getHostUrl`：宿主自身地址（非回环时可用）。
4. 网卡 LAN 地址：上述均为回环时的兜底，取 `getNetworkAddresses()[0]` 替换回环主机。

> 一句话：**host 自动推导多数场景能 work；若宿主只监听 127.0.0.1，请在「插件设置 → 对外可达地址」
> 填写 LAN IP（如 `http://192.168.1.190:58091`），否则直推 url 会置空，自动回退入库播放保证出声。**

> v2026.8.9 之前本插件依赖 songloft-plugin-bridge 转发，现已内联实现，**无需安装桥接插件**。
> 桥接插件项目本身仍保留（其他插件未来仍可使用）。


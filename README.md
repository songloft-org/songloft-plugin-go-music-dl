# Songloft Plugin: Go Music DL

一个把 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) 接入 Songloft 的音源插件。
它让 Songloft 直接通过本地或远程的 go-music-dl 实例聚合搜索网易云、QQ、酷狗、酷我、咪咕、Bilibili 等音源，并支持试听、歌词与导入本地库。



## 配置

在插件设置页填写：

- **go-music-dl 实例地址**：例如 `http://127.0.0.1:8080/music`（默认端口8080）。
- **搜索音源**：勾选需要参与搜索的平台。

### MIoT 口令联动（可选）

本插件已内置 `/api/search/topone` 端点，兼容 MIoT 智能音箱插件的 `OnlineSearcher` 契约。

**miot 设置页操作步骤：**

1. 进入 MIoT 插件设置 →「外部搜索」区域。
2. 新增一个源：
   - **名称**：`go-music-dl`
   - **URL**：`/api/v1/jsplugin/go-music-dl/api/search/topone`
3. 启用该源，并打开「外部搜索」总开关。
4. 搜索优先级 `search_priority` 设为 `external_first`（口令优先走 go-music-dl）或 `parallel`。

**确认前提：**
- MIoT 的 `server_host` 必须填写**局域网 IP**（否则音箱无法拉取宿主流）。
- go-music-dl 插件已完成构建（`pnpm build`）并上传 / 重启生效。

之后对小爱说「播放 XXX」即会经 go-music-dl 搜索歌曲并通过音箱出声。


# Songloft Plugin: Go Music DL

一个把 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) 接入 Songloft 的音源插件。
它让 Songloft 直接通过本地或远程的 go-music-dl 实例聚合搜索网易云、QQ、酷狗、酷我、咪咕、Bilibili 等音源，并支持试听、歌词与导入本地库。



## 配置

在插件设置页填写：

- **go-music-dl 实例地址**：例如 `http://127.0.0.1:8080/music`（默认端口8080）。
- **搜索音源**：勾选需要参与搜索的平台。

## 安装与开发

```bash
# 安装依赖
npm install

# 编译构建（自动生成 entryHash / zipHash 并产出 dist/go-music-dl.jsplugin.zip）
npm run build

# 本地联调（热重载上传到运行中的 Songloft）
npx songloft-plugin dev --host http://localhost:58091

# 校验插件
npm run validate
```


## 目录结构

```
src/
  config.ts   配置读写（实例地址、音源列表）
  client.ts   go-music-dl 接口对接（搜索 HTML 解析 / 直链 / 歌词）
  router.ts   插件路由（search / music-url / lyric-search / download / config）
  main.ts     生命周期与歌词提供者注册
static/       插件自有页面（搜索与设置）
```

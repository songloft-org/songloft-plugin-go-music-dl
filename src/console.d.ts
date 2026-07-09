// QuickJS 运行时提供 console 全局（polyfill），但 ES2022 lib 未包含其类型。
// 这里仅做最小声明，便于 tsc --noEmit 通过；esbuild 构建无需此文件。
declare const console: {
  log(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  debug(...args: any[]): void
}

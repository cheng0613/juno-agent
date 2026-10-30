/**
 * 全局类型补充。
 *
 * `?raw` 是 Vite 的专有语法，maker-core 里有 6 处用了它。
 * esbuild 构建时由 build.mjs 的插件处理，但 tsc 需要这个声明才能过。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

/** 验收专用后门，只在 APP_AUTOTEST 开启时由 preload 挂载 */
declare interface Window {
  __autotestInject?: {
    compactBoundary(sessionId: string): Promise<void>;
  };
}

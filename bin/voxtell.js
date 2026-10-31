#!/usr/bin/env node
/**
 * 薄壳:实现在 src/cli/main.ts,靠 Node ≥22.18 原生 type stripping 直跑 TS。
 * 发布 npm 前必须先把 CLI 打包成 JS(node_modules 内不做 type stripping),
 * package.json 的 prepublishOnly 设了闸。
 */
try {
  const { main } = await import(new URL('../src/cli/main.ts', import.meta.url).href);
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`voxtell: 内部错误:${err?.stack ?? err}`);
  process.exitCode = 4;
}

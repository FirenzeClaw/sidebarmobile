// sidebarmobile — 双端构建脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：esbuild 三入口打包 + 双清单分流

/**
 * [DONE] 双端扩展构建：把 src 下三个入口编译到 dist/chrome 与 dist/firefox。
 *
 * 双端差异只在清单层处理（宪法 VII）：同一份 TS 源码、同一份侧栏 HTML，
 * 仅 manifest 模板不同（Chrome side_panel vs Firefox sidebar_action）。
 */
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

/** 构建目标：目录名、清单模板、浏览器标识 */
const BUILD_TARGETS = [
  { name: 'chrome', manifest: 'manifest.chrome.json', define: { __BROWSER__: '"chrome"' } },
  { name: 'firefox', manifest: 'manifest.firefox.json', define: { __BROWSER__: '"firefox"' } },
] as const;

/** 扩展三入口（background / sidebar / content），产物名与清单引用一致 */
const ENTRY_POINTS = {
  background: path.join(SRC_DIR, 'background', 'index.ts'),
  sidebar: path.join(SRC_DIR, 'sidebar', 'app.ts'),
  content: path.join(SRC_DIR, 'content', 'frame-reporter.ts'),
};

const isWatchMode = process.argv.includes('--watch');

/** [DONE] 单目标构建：清目录 → 打包三入口 → 复制侧栏 HTML 与清单 */
async function buildTarget(target: (typeof BUILD_TARGETS)[number]): Promise<void> {
  const outDir = path.join(DIST_DIR, target.name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const options = {
    entryPoints: ENTRY_POINTS,
    outdir: outDir,
    bundle: true,
    format: 'iife' as const,
    target: ['chrome114', 'firefox115'],
    sourcemap: true,
    logLevel: 'info' as const,
    define: target.define,
  };

  if (isWatchMode) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }

  await cp(path.join(SRC_DIR, 'sidebar', 'index.html'), path.join(outDir, 'sidebar.html'));
  // 侧栏样式：六主题变量 + 组件样式，输出到 styles/ 以匹配 index.html 的 <link> 引用（T025）
  await cp(path.join(SRC_DIR, 'sidebar', 'styles'), path.join(outDir, 'styles'), { recursive: true });
  await cp(path.join(SRC_DIR, 'icons'), path.join(outDir, 'icons'), { recursive: true });
  const manifestTemplatePath = path.join(SRC_DIR, 'manifests', target.manifest);
  const manifestText = await readFile(manifestTemplatePath, 'utf8');
  await writeFile(path.join(outDir, 'manifest.json'), manifestText, 'utf8');

  // [WORKAROUND 2026-09-29] webextension-polyfill 在 IIFE 打包下需以全局方式注入；
  // 当前仅三入口空壳，尚未引用 polyfill，故不额外处理。接入 polyfill 时改为
  // 在 sidebar.html / background 顶部按需 import，勿在此处硬编码全局注入。
  console.log(`[build] ${target.name} → ${path.relative(PROJECT_ROOT, outDir)}`);
}

/** [DONE] 校验入口与模板齐备，缺文件时立即失败而非产出半成品 */
async function assertSourcesExist(): Promise<void> {
  const required = [
    ...Object.values(ENTRY_POINTS),
    path.join(SRC_DIR, 'sidebar', 'index.html'),
    path.join(SRC_DIR, 'sidebar', 'styles', 'themes.css'),
    path.join(SRC_DIR, 'sidebar', 'styles', 'app.css'),
    path.join(SRC_DIR, 'manifests', 'manifest.chrome.json'),
    path.join(SRC_DIR, 'manifests', 'manifest.firefox.json'),
  ];
  const missing = required.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `构建缺少必需文件：\n${missing.map((filePath) => `  - ${path.relative(PROJECT_ROOT, filePath)}`).join('\n')}`,
    );
  }
}

async function main(): Promise<void> {
  await assertSourcesExist();
  for (const target of BUILD_TARGETS) {
    await buildTarget(target);
  }
  if (!isWatchMode) {
    console.log('[build] 完成');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[build] 失败：${message}`);
  process.exitCode = 1;
});

// sidebarmobile — 后台消息监听器结构测试（测试）
// 2026-09-30 | Kimi(fix) | 用户实测缺陷回归：多个 onMessage 监听器会互相截断响应

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 本文件锁定一个用户实测缺陷（2026-09-30）：
 *
 * 后台曾注册**两个** `runtime.onMessage` 监听器 —— 一个处理 frame 上报，一个处理消息路由。
 * 前者的实现对 `permissions.apply-grant` 落到末尾 `return undefined`，而 Chrome / polyfill
 * 的语义是"同步返回 undefined 即关闭响应通道"，于是后者的异步结果永远送不回侧栏。
 *
 * 现象：用户点「允许」后，权限申请其实成功了（`permissions.request` 返回 granted），
 * 但 `sendApply` 永远等不到响应 → UA 开关卡在 pending 变成灰色不可点、登录复用点击无效。
 *
 * 这类缺陷靠行为测试很难覆盖（需要真实浏览器 + 真实用户手势），但**结构是可测的**：
 * 后台只允许存在一个 onMessage 注册点。本测试即锁定这条约束。
 */

const BACKGROUND_DIR = path.resolve(__dirname, '..', '..', 'src', 'background');

/** [DONE] 递归收集目录下所有 .ts 文件 */
function collectTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

/** [DONE] 统计某文件中 onMessage 的注册调用次数（忽略注释行） */
function countOnMessageRegistrations(source: string): number {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.includes('onMessage('));
  return lines.length;
}

describe('后台只允许一个 onMessage 监听器（用户实测缺陷回归）', () => {
  it('src/background 下 onMessage 注册点恰好为 1', () => {
    const files = collectTsFiles(BACKGROUND_DIR);
    const registrations: Array<{ file: string; count: number }> = [];

    for (const filePath of files) {
      const count = countOnMessageRegistrations(readFileSync(filePath, 'utf8'));
      if (count > 0) {
        registrations.push({ file: path.basename(filePath), count });
      }
    }

    const total = registrations.reduce((sum, item) => sum + item.count, 0);

    // 失败信息要直接指出问题与后果，便于后来者理解为何不能"顺手再加一个监听器"
    expect(
      total,
      `后台消息监听器注册点应为 1 个，实际 ${total} 个：${registrations
        .map((item) => `${item.file}×${item.count}`)
        .join(', ')}。\n` +
        '多个监听器会互相截断响应：先行者对不认识的类型同步返回 undefined 即关闭通道，' +
        '后续监听器的异步结果再也送不回发送方（2026-09-30 实测缺陷的根因）。\n' +
        '新增消息类型请加到 src/background/index.ts 的统一监听器分支里。',
    ).toBe(1);
  });

  it('统一监听器显式处理 frame.report 与 frame.open-request（它们无需响应）', () => {
    const source = readFileSync(path.join(BACKGROUND_DIR, 'index.ts'), 'utf8');
    // 这两类消息由 content script 发起、没有请求-响应语义，
    // 必须在统一监听器内前置处理并显式返回 undefined，否则会落到 handleMessage 的默认分支
    expect(source).toContain("type === 'frame.report'");
    expect(source).toContain("type === 'frame.open-request'");
  });
});

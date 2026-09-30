// sidebarmobile — 紧凑标签栏单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T070：标题截断与活动态（FR-024）

import { describe, expect, it } from 'vitest';
import { TAB_TITLE_MAX_CHARS, tabRowViewModel } from '../../src/sidebar/components/tab-bar.ts';
import type { BrowserTab } from '../../src/shared/types.ts';

function makeTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  const now = new Date().toISOString();
  return {
    tabId: 'tab-1',
    originKey: 'https://example.com',
    currentUrl: 'https://example.com/',
    title: '示例页面',
    history: [{ url: 'https://example.com/', title: '示例页面', visitedAt: now }],
    historyIndex: 0,
    loadState: 'loaded',
    createdAt: now,
    ...overrides,
  };
}

describe('标签行显示文本（spec FR-024）', () => {
  it('标题超过上限时截断并加省略号', () => {
    const longTitle = '这是一个非常非常长的页面标题用于验证截断行为';
    const view = tabRowViewModel(makeTab({ title: longTitle }), 'tab-1');

    expect(view.displayTitle.length).toBeLessThanOrEqual(TAB_TITLE_MAX_CHARS + 1);
    expect(view.displayTitle.endsWith('…')).toBe(true);
  });

  it('完整标题保留在 fullTitle 供 title 提示与 aria-label 使用', () => {
    const longTitle = '这是一个非常非常长的页面标题用于验证截断行为';
    const view = tabRowViewModel(makeTab({ title: longTitle }), 'tab-1');

    // 截断只影响显示，不丢信息：悬停提示与读屏器仍能拿到完整标题
    expect(view.fullTitle).toBe(longTitle);
  });

  it('短标题原样显示不加省略号', () => {
    const view = tabRowViewModel(makeTab({ title: '短标题' }), 'tab-1');

    expect(view.displayTitle).toBe('短标题');
    expect(view.displayTitle.endsWith('…')).toBe(false);
  });

  it('标题为空时回落到 URL（避免空白行无法辨认）', () => {
    const view = tabRowViewModel(makeTab({ title: null }), 'tab-1');

    expect(view.displayTitle.length).toBeGreaterThan(0);
    expect(view.fullTitle).toBe('https://example.com/');
  });

  it('标题为空串时同样回落到 URL', () => {
    const view = tabRowViewModel(makeTab({ title: '' }), 'tab-1');

    expect(view.fullTitle).toBe('https://example.com/');
  });

  it('URL 一并给出供副标题显示', () => {
    const view = tabRowViewModel(makeTab({ currentUrl: 'https://example.com/deep/path' }), 'tab-1');

    expect(view.url).toBe('https://example.com/deep/path');
  });
});

describe('活动态标记', () => {
  it('活动标签行标记 isActive', () => {
    const view = tabRowViewModel(makeTab({ tabId: 'tab-a' }), 'tab-a');

    expect(view.isActive).toBe(true);
  });

  it('非活动标签行不标记 isActive', () => {
    const view = tabRowViewModel(makeTab({ tabId: 'tab-a' }), 'tab-b');

    expect(view.isActive).toBe(false);
  });

  it('无活动标签时所有行都不标记', () => {
    const view = tabRowViewModel(makeTab({ tabId: 'tab-a' }), null);

    expect(view.isActive).toBe(false);
  });
});

describe('截断上限的合理区间', () => {
  it('截断长度足以区分同一站点的多个标签', () => {
    // 太短（如 4）会让同站多标签全显示成一样的前缀，用户无法分辨
    expect(TAB_TITLE_MAX_CHARS).toBeGreaterThanOrEqual(8);
  });

  it('截断长度不会挤掉右侧的关闭与菜单钮', () => {
    // 太长会在 360px 侧栏里把两个按钮推出可视区
    expect(TAB_TITLE_MAX_CHARS).toBeLessThanOrEqual(20);
  });
});

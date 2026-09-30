// sidebarmobile — frame 上报标签归属测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B4：同来源多标签时宁可拒认也不错配

import { describe, expect, it } from 'vitest';
import { findTabForFrameUrl, withoutHash } from '../../src/sidebar/state/frame-attribution.ts';
import type { BrowserTab } from '../../src/shared/types.ts';

/** 构造一个只关心归属判定所需字段的标签 */
function makeTab(tabId: string, currentUrl: string): BrowserTab {
  const originKey = currentUrl.slice(0, currentUrl.lastIndexOf('/') + 1).replace(/\/$/, '');
  return {
    tabId,
    originKey: originKey.includes('://') ? originKey : 'https://example.com',
    currentUrl,
    title: null,
    history: [{ url: currentUrl, title: null, visitedAt: new Date(0).toISOString() }],
    historyIndex: 0,
    loadState: 'loaded',
    createdAt: new Date(0).toISOString(),
  };
}

describe('withoutHash', () => {
  it('去掉 hash 片段', () => {
    expect(withoutHash('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('无 hash 时原样返回', () => {
    expect(withoutHash('https://example.com/a')).toBe('https://example.com/a');
  });
});

/**
 * 终审 B4：原实现按来源取首个（优先活动标签）匹配，同来源两个标签时会静默错配 ——
 * 把 A 标签的页面写进 B 标签的历史栈，B 的地址与标题被无声改掉。
 *
 * 判据必须"无歧义才认"，歧义时拒绝（返回 null 让调用方如实保持不确定态）。
 */
describe('frame 上报的标签归属（终审 B4）', () => {
  it('该来源只有一个标签时归属明确', () => {
    const tab = makeTab('tab-1', 'https://example.com/page');

    expect(findTabForFrameUrl([tab], 'https://example.com/other')?.tabId).toBe('tab-1');
  });

  it('同来源两个标签停在同一地址时拒绝归属（不猜）', () => {
    const first = makeTab('tab-1', 'https://example.com/page');
    const second = makeTab('tab-2', 'https://example.com/page');

    // 两个标签都在同一页：无法判断上报来自哪一个，宁可拒认
    expect(findTabForFrameUrl([first, second], 'https://example.com/new-page')).toBeNull();
  });

  it('同来源两个标签但上报地址精确命中一个时归属到它', () => {
    const first = makeTab('tab-1', 'https://example.com/page-a');
    const second = makeTab('tab-2', 'https://example.com/page-b');

    // load 上报：侧栏已知新地址，另一个标签还在旧地址 —— 可无歧义判定
    expect(findTabForFrameUrl([first, second], 'https://example.com/page-b')?.tabId).toBe('tab-2');
    expect(findTabForFrameUrl([first, second], 'https://example.com/page-a')?.tabId).toBe('tab-1');
  });

  it('hash 不参与归属判定（SPA 的 hash 变化仍属同一标签）', () => {
    const first = makeTab('tab-1', 'https://example.com/page-a');
    const second = makeTab('tab-2', 'https://example.com/page-b');

    // tab-1 的 hash 变化：去掉 hash 后精确命中 tab-1
    expect(findTabForFrameUrl([first, second], 'https://example.com/page-a#section')?.tabId).toBe('tab-1');
  });

  it('不同来源不互相匹配', () => {
    const other = makeTab('tab-1', 'https://other.example.org/page');

    expect(findTabForFrameUrl([other], 'https://example.com/page')).toBeNull();
  });

  it('同域不同端口视为不同来源（FR-038 精确来源）', () => {
    const other = makeTab('tab-1', 'https://example.com:8443/page');

    expect(findTabForFrameUrl([other], 'https://example.com/page')).toBeNull();
  });

  it('无标签时返回 null', () => {
    expect(findTabForFrameUrl([], 'https://example.com/page')).toBeNull();
  });

  it('非法 URL 返回 null', () => {
    expect(findTabForFrameUrl([makeTab('tab-1', 'https://example.com/page')], 'javascript:alert(1)')).toBeNull();
  });

  it('三个标签时同样拒绝（歧义不因数量增加而消失）', () => {
    const tabs = [
      makeTab('tab-1', 'https://example.com/same'),
      makeTab('tab-2', 'https://example.com/same'),
      makeTab('tab-3', 'https://example.com/same'),
    ];

    expect(findTabForFrameUrl(tabs, 'https://example.com/moved')).toBeNull();
  });
});

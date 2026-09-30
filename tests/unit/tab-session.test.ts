// sidebarmobile — 标签会话管理单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T020：先写失败测试（RED，FR-014/FR-015/FR-016）

import { beforeEach, describe, expect, it } from 'vitest';
import { createTabSession, type TabSession } from '../../src/sidebar/state/tab-session.ts';
import { HISTORY_LIMIT } from '../../src/shared/types.ts';

let session: TabSession;
let idCounter: number;
let clockTick: number;

/** 可重复的时钟：每次读取前进 1 秒，让时间戳可断言且严格递增 */
function tickingClock(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 8, 29, 10, 0, clockTick)).toISOString();
}

beforeEach(() => {
  idCounter = 0;
  clockTick = 0;
  session = createTabSession({
    createId: () => `tab-${++idCounter}`,
    now: tickingClock,
  });
});

describe('标签创建与切换（spec FR-014）', () => {
  it('打开网址创建一个标签并成为活动标签', () => {
    const tab = session.openTab('https://example.com/');

    expect(tab).not.toBeNull();
    expect(tab!.history).toHaveLength(1);
    expect(tab!.historyIndex).toBe(0);
    expect(tab!.currentUrl).toBe('https://example.com/');
    expect(tab!.originKey).toBe('https://example.com');
    expect(session.getActiveTabId()).toBe(tab!.tabId);
    expect(session.getTabs()).toHaveLength(1);
  });

  it('打开第二个标签后两个标签共存且后者为活动标签', () => {
    const first = session.openTab('https://example.com/');
    const second = session.openTab('https://other.example.org/page');

    expect(session.getTabs()).toHaveLength(2);
    expect(session.getActiveTabId()).toBe(second!.tabId);
    expect(session.getTab(first!.tabId)?.currentUrl).toBe('https://example.com/');
  });

  it('切换活动标签不影响其它标签的 URL 与历史', () => {
    const first = session.openTab('https://example.com/');
    const second = session.openTab('https://other.example.org/');
    session.navigate(second!.tabId, 'https://other.example.org/b');

    expect(session.activateTab(first!.tabId)).toBe(true);
    expect(session.getActiveTabId()).toBe(first!.tabId);
    expect(session.getTab(second!.tabId)?.currentUrl).toBe('https://other.example.org/b');
    expect(session.getTab(second!.tabId)?.history).toHaveLength(2);
    expect(session.getTab(first!.tabId)?.history).toHaveLength(1);
  });

  it('切换到不存在的标签返回 false 且活动标签不变', () => {
    const tab = session.openTab('https://example.com/');

    expect(session.activateTab('tab-does-not-exist')).toBe(false);
    expect(session.getActiveTabId()).toBe(tab!.tabId);
  });

  it('非法网址不开标签并返回 null', () => {
    expect(session.openTab('javascript:alert(1)')).toBeNull();
    expect(session.openTab('file:///etc/passwd')).toBeNull();
    expect(session.openTab('')).toBeNull();
    expect(session.getTabs()).toHaveLength(0);
    expect(session.getActiveTabId()).toBeNull();
  });

  it('每个标签拥有独立的加载状态', () => {
    const first = session.openTab('https://example.com/');
    const second = session.openTab('https://other.example.org/');

    session.setLoadState(first!.tabId, 'loaded');
    session.setLoadState(second!.tabId, 'blocked');

    expect(session.getTab(first!.tabId)?.loadState).toBe('loaded');
    expect(session.getTab(second!.tabId)?.loadState).toBe('blocked');
  });
});

describe('标签关闭语义（spec FR-016）', () => {
  it('关闭非活动标签后活动标签不变', () => {
    const first = session.openTab('https://example.com/');
    const second = session.openTab('https://other.example.org/');

    const outcome = session.closeTab(first!.tabId);

    expect(outcome.closed).toBe(true);
    expect(outcome.activeTabId).toBe(second!.tabId);
    expect(outcome.remaining).toBe(1);
  });

  it('关闭活动标签后接管同位置的相邻标签', () => {
    const first = session.openTab('https://a.example.com/');
    session.openTab('https://b.example.com/');
    const third = session.openTab('https://c.example.com/');

    session.activateTab(first!.tabId);
    const outcome = session.closeTab(first!.tabId);

    // 关掉索引 0 后，原索引 1 的标签接管
    expect(outcome.activeTabId).toBe(session.getTabs()[0]?.tabId);
    expect(outcome.activeTabId).not.toBe(third!.tabId);
  });

  it('关闭最后一个标签后会话无标签且无活动标签', () => {
    const only = session.openTab('https://example.com/');

    const outcome = session.closeTab(only!.tabId);

    expect(outcome.closed).toBe(true);
    expect(outcome.remaining).toBe(0);
    expect(outcome.activeTabId).toBeNull();
    expect(session.getTabs()).toHaveLength(0);
    expect(session.getActiveTab()).toBeNull();
  });

  it('关闭不存在的标签返回 closed=false 且不影响现有标签', () => {
    session.openTab('https://example.com/');

    const outcome = session.closeTab('tab-missing');

    expect(outcome.closed).toBe(false);
    expect(session.getTabs()).toHaveLength(1);
    expect(outcome.remaining).toBe(1);
  });
});

describe('历史栈与前进后退（spec FR-014/FR-015）', () => {
  it('导航追加历史并把索引推进到末尾', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');
    session.navigate(tab!.tabId, 'https://example.com/c');

    const current = session.getTab(tab!.tabId)!;
    expect(current.history.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    expect(current.historyIndex).toBe(2);
    expect(current.currentUrl).toBe('https://example.com/c');
  });

  it('后退与前进保持索引与 currentUrl 一致', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');
    session.navigate(tab!.tabId, 'https://example.com/c');

    session.goBack(tab!.tabId);
    expect(session.getTab(tab!.tabId)?.historyIndex).toBe(1);
    expect(session.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/b');

    session.goForward(tab!.tabId);
    expect(session.getTab(tab!.tabId)?.historyIndex).toBe(2);
    expect(session.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/c');
  });

  it('历史栈起点不能再后退，终点不能再前进', () => {
    const tab = session.openTab('https://example.com/');

    expect(session.canGoBack(tab!.tabId)).toBe(false);
    expect(session.canGoForward(tab!.tabId)).toBe(false);
    expect(session.goBack(tab!.tabId)).toBeNull();
    expect(session.goForward(tab!.tabId)).toBeNull();
    expect(session.getTab(tab!.tabId)?.historyIndex).toBe(0);
  });

  it('后退后导航会截断前向历史', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');
    session.navigate(tab!.tabId, 'https://example.com/c');
    session.goBack(tab!.tabId);
    session.goBack(tab!.tabId);

    session.navigate(tab!.tabId, 'https://example.com/new');

    const current = session.getTab(tab!.tabId)!;
    expect(current.history.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/new',
    ]);
    expect(current.historyIndex).toBe(1);
    expect(session.canGoForward(tab!.tabId)).toBe(false);
  });

  it('历史超过 100 条时淘汰最旧记录并保持当前位置可用', () => {
    const tab = session.openTab('https://example.com/page-0');
    for (let index = 1; index < HISTORY_LIMIT + 20; index += 1) {
      session.navigate(tab!.tabId, `https://example.com/page-${index}`);
    }

    const current = session.getTab(tab!.tabId)!;
    expect(current.history).toHaveLength(HISTORY_LIMIT);
    expect(current.historyIndex).toBe(HISTORY_LIMIT - 1);
    expect(current.currentUrl).toBe(`https://example.com/page-${HISTORY_LIMIT + 19}`);
    // 最新一条仍在，最旧的 20 条被淘汰
    expect(current.history[current.history.length - 1]?.url).toBe(`https://example.com/page-${HISTORY_LIMIT + 19}`);
    expect(current.history[0]?.url).toBe('https://example.com/page-20');
  });

  it('淘汰后连续后退仍逐条回退且索引合法', () => {
    const tab = session.openTab('https://example.com/page-0');
    for (let index = 1; index < HISTORY_LIMIT + 20; index += 1) {
      session.navigate(tab!.tabId, `https://example.com/page-${index}`);
    }

    let steps = 0;
    while (session.goBack(tab!.tabId) !== null) {
      steps += 1;
      const current = session.getTab(tab!.tabId)!;
      expect(current.historyIndex).toBeGreaterThanOrEqual(0);
      expect(current.historyIndex).toBeLessThan(current.history.length);
      expect(current.currentUrl).toBe(current.history[current.historyIndex]?.url);
    }

    expect(steps).toBe(HISTORY_LIMIT - 1);
    expect(session.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/page-20');
  });

  it('跨来源导航更新标签的 originKey', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'http://other.example.org:8443/x');

    expect(session.getTab(tab!.tabId)?.originKey).toBe('http://other.example.org:8443');
  });

  it('非法 URL 的导航被忽略且标签状态不变', () => {
    const tab = session.openTab('https://example.com/');

    expect(session.navigate(tab!.tabId, 'data:text/html,<h1>x</h1>')).toBeNull();
    expect(session.getTab(tab!.tabId)?.history).toHaveLength(1);
    expect(session.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/');
  });

  it('历史条目记录访问时间戳', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');

    const history = session.getTab(tab!.tabId)!.history;
    expect(history[0]?.visitedAt).toBe(new Date(Date.UTC(2026, 8, 29, 10, 0, 1)).toISOString());
    expect(history[1]?.visitedAt).toBe(new Date(Date.UTC(2026, 8, 29, 10, 0, 2)).toISOString());
  });
});

describe('会话快照与恢复（spec FR-016/FR-017）', () => {
  it('快照包含全部标签与活动标签', () => {
    const first = session.openTab('https://example.com/');
    session.openTab('https://other.example.org/');
    session.activateTab(first!.tabId);

    const snapshot = session.snapshot();

    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.activeTabId).toBe(first!.tabId);
  });

  it('恢复到新会话后标签、活动标签与历史位置一致', () => {
    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');
    session.navigate(tab!.tabId, 'https://example.com/c');
    session.goBack(tab!.tabId);
    const snapshot = session.snapshot();

    const restored = createTabSession({ createId: () => 'tab-new', now: tickingClock });
    restored.restore(snapshot);

    expect(restored.getTabs()).toHaveLength(1);
    expect(restored.getActiveTabId()).toBe(tab!.tabId);
    const restoredTab = restored.getTab(tab!.tabId)!;
    expect(restoredTab.history.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    expect(restoredTab.historyIndex).toBe(1);
    expect(restoredTab.currentUrl).toBe('https://example.com/b');
  });

  it('恢复后继续打开标签不会复用已恢复的 tabId', () => {
    const first = session.openTab('https://example.com/');
    const snapshot = session.snapshot();

    const restored = createTabSession({ createId: () => `tab-${++idCounter}`, now: tickingClock });
    restored.restore(snapshot);
    const second = restored.openTab('https://other.example.org/');

    expect(second!.tabId).not.toBe(first!.tabId);
    expect(restored.getTabs()).toHaveLength(2);
  });

  it('恢复时活动标签指向不存在的标签则置空并保留全部标签', () => {
    const tab = session.openTab('https://example.com/');
    const snapshot = { ...session.snapshot(), activeTabId: 'tab-ghost' };

    const restored = createTabSession({ createId: () => 'tab-new', now: tickingClock });
    restored.restore(snapshot);

    expect(restored.getTabs()).toHaveLength(1);
    expect(restored.getActiveTabId()).toBeNull();
    expect(restored.getTab(tab!.tabId)).not.toBeNull();
  });

  it('恢复空快照得到空会话', () => {
    const restored = createTabSession({ createId: () => 'tab-new', now: tickingClock });
    restored.restore({ tabs: [], activeTabId: null });

    expect(restored.getTabs()).toHaveLength(0);
    expect(restored.getActiveTabId()).toBeNull();
  });
});

describe('变更通知（spec FR-017 持久化接线）', () => {
  it('每次状态变更通知订阅者，退订后不再通知', () => {
    let notifications = 0;
    const unsubscribe = session.onChange(() => {
      notifications += 1;
    });

    const tab = session.openTab('https://example.com/');
    session.navigate(tab!.tabId, 'https://example.com/b');
    expect(notifications).toBe(2);

    unsubscribe();
    session.navigate(tab!.tabId, 'https://example.com/c');
    expect(notifications).toBe(2);
  });

  it('被忽略的无效操作不触发通知', () => {
    let notifications = 0;
    session.onChange(() => {
      notifications += 1;
    });

    session.openTab('javascript:alert(1)');
    session.activateTab('tab-missing');
    session.closeTab('tab-missing');

    expect(notifications).toBe(0);
  });
});

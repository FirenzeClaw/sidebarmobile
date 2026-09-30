// sidebarmobile — 会话存储单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T016：先写失败测试（RED）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createSessionStore, type SessionStore } from '../../src/shared/session-store.ts';
import { STORAGE_KEYS, HISTORY_LIMIT, type BrowserTab, type SiteEntry, createDefaultSiteSettings } from '../../src/shared/types.ts';

let mock: BrowserMock;
let store: SessionStore;

/** 构造一个最小可用标签页，避免测试里重复样板 */
function makeTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  const now = new Date().toISOString();
  return {
    tabId: 'tab-1',
    originKey: 'https://example.com',
    currentUrl: 'https://example.com/',
    title: '示例',
    history: [{ url: 'https://example.com/', title: '示例', visitedAt: now }],
    historyIndex: 0,
    loadState: 'loaded',
    createdAt: now,
    ...overrides,
  };
}

function makeSite(overrides: Partial<SiteEntry> = {}): SiteEntry {
  const now = new Date().toISOString();
  return {
    originKey: 'https://example.com',
    title: '示例站',
    faviconUrl: null,
    entryPoints: [{ url: 'https://example.com/', label: null }],
    settings: createDefaultSiteSettings(),
    addedBy: 'user',
    createdAt: now,
    updatedAt: now,
    lastVisitedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local);
});

describe('会话读写（spec FR-017/FR-018）', () => {
  it('空存储时返回空会话而非报错', async () => {
    const session = await store.loadSession();
    expect(session.tabs).toEqual([]);
    expect(session.activeTabId).toBeNull();
  });

  it('保存后可完整读回标签页与活动标签', async () => {
    const tabs = [makeTab({ tabId: 'tab-a' }), makeTab({ tabId: 'tab-b', currentUrl: 'https://example.com/b' })];
    await store.saveSession({ tabs, activeTabId: 'tab-b' });

    const session = await store.loadSession();
    expect(session.tabs).toHaveLength(2);
    expect(session.activeTabId).toBe('tab-b');
  });

  it('站点列表与标签会话分键存储，互不覆盖', async () => {
    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    await store.saveSites([makeSite()]);

    const session = await store.loadSession();
    const sites = await store.loadSites();
    expect(session.tabs).toHaveLength(1);
    expect(sites).toHaveLength(1);
  });

  it('持久化内容不含页面内容、密码或 Cookie 值字段', async () => {
    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    const rawText = JSON.stringify(mock.storage.local.snapshot());
    expect(rawText).not.toContain('password');
    expect(rawText).not.toContain('cookieValue');
    expect(rawText).not.toContain('formData');
  });
});

describe('坏记录粒度丢弃（spec FR-031）', () => {
  it('单条标签损坏时丢弃该条，其余照常加载', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.session]: {
        version: 1,
        savedAt: new Date().toISOString(),
        activeTabId: 'tab-good',
        tabs: [
          makeTab({ tabId: 'tab-good' }),
          // 故意损坏：historyIndex 越界
          makeTab({ tabId: 'tab-bad', historyIndex: 99 }),
        ],
      },
    });

    const session = await store.loadSession();
    expect(session.tabs.map((tab) => tab.tabId)).toEqual(['tab-good']);
  });

  it('非法 URL 的历史条目被丢弃且标签仍可加载', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.session]: {
        version: 1,
        savedAt: new Date().toISOString(),
        activeTabId: 'tab-1',
        tabs: [
          makeTab({
            tabId: 'tab-1',
            history: [
              { url: 'https://example.com/', title: null, visitedAt: new Date().toISOString() },
              { url: 'javascript:alert(1)', title: null, visitedAt: new Date().toISOString() },
            ],
            historyIndex: 0,
          }),
        ],
      },
    });

    const session = await store.loadSession();
    expect(session.tabs).toHaveLength(1);
    expect(session.tabs[0]?.history).toHaveLength(1);
  });

  it('activeTabId 指向不存在标签时置空而保留其余数据', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.session]: {
        version: 1,
        savedAt: new Date().toISOString(),
        activeTabId: 'tab-missing',
        tabs: [makeTab({ tabId: 'tab-1' })],
      },
    });

    const session = await store.loadSession();
    expect(session.tabs).toHaveLength(1);
    expect(session.activeTabId).toBeNull();
  });

  it('顶层结构完全损坏时返回空会话', async () => {
    await mock.storage.local.set({ [STORAGE_KEYS.session]: 'not-an-object' });
    const session = await store.loadSession();
    expect(session.tabs).toEqual([]);
  });

  it('站点列表中非法来源被丢弃，合法项保留', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [makeSite({ originKey: 'https://good.com' }), makeSite({ originKey: 'ftp://bad.com' })],
      },
    });

    const sites = await store.loadSites();
    expect(sites.map((site) => site.originKey)).toEqual(['https://good.com']);
  });
});

describe('历史上限与裁剪（spec FR-015）', () => {
  it('保存时把超长历史裁剪到上限并保留最新条目', async () => {
    const longHistory = Array.from({ length: HISTORY_LIMIT + 20 }, (_unused, index) => ({
      url: `https://example.com/page-${index}`,
      title: null,
      visitedAt: new Date().toISOString(),
    }));
    const tab = makeTab({ history: longHistory, historyIndex: longHistory.length - 1 });

    await store.saveSession({ tabs: [tab], activeTabId: 'tab-1' });
    const session = await store.loadSession();
    const savedHistory = session.tabs[0]?.history ?? [];

    expect(savedHistory.length).toBe(HISTORY_LIMIT);
    // 保留的是最新的一批：最后一条应为原最后一条
    expect(savedHistory[savedHistory.length - 1]?.url).toBe(`https://example.com/page-${HISTORY_LIMIT + 19}`);
  });

  it('裁剪后 historyIndex 仍在合法范围内', async () => {
    const longHistory = Array.from({ length: HISTORY_LIMIT + 5 }, (_unused, index) => ({
      url: `https://example.com/p-${index}`,
      title: null,
      visitedAt: new Date().toISOString(),
    }));
    await store.saveSession({
      tabs: [makeTab({ history: longHistory, historyIndex: longHistory.length - 1 })],
      activeTabId: 'tab-1',
    });

    const session = await store.loadSession();
    const tab = session.tabs[0];
    expect(tab).toBeDefined();
    expect(tab!.historyIndex).toBeGreaterThanOrEqual(0);
    expect(tab!.historyIndex).toBeLessThan(tab!.history.length);
  });
});

describe('写入失败与防抖（spec FR-032）', () => {
  it('写入失败时重试一次，仍失败则返回失败而非抛出', async () => {
    mock.storage.local.failNextWriteWith(new Error('quota exceeded'));
    mock.storage.local.failNextWriteWith(new Error('quota exceeded'));

    const result = await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    expect(result.persisted).toBe(false);
    expect(result.reason).toBe('storage-failed');
  });

  it('首次失败但重试成功时报告已持久化', async () => {
    mock.storage.local.failNextWriteWith(new Error('transient'));
    const result = await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    expect(result.persisted).toBe(true);
  });

  it('防抖写入把多次调用合并为一次落盘', async () => {
    const debouncedResult = await store.saveSessionDebounced({ tabs: [makeTab()], activeTabId: 'tab-1' }, 20);
    const secondResult = await store.saveSessionDebounced(
      { tabs: [makeTab({ title: '更新后' })], activeTabId: 'tab-1' },
      20,
    );
    expect(debouncedResult).toBeNull();
    expect(secondResult).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 60));
    const session = await store.loadSession();
    expect(session.tabs[0]?.title).toBe('更新后');
  });
});

describe('写入失败通知（spec FR-032）', () => {
  it('成功写入也会广播结果，订阅者可据此撤下警示条', async () => {
    const received: Array<{ persisted: boolean }> = [];
    const unsubscribe = store.onWriteResult((result) => received.push(result));

    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });

    expect(received).toHaveLength(1);
    expect(received[0]?.persisted).toBe(true);
    unsubscribe();
  });

  it('防抖路径的写入失败也会广播（这是订阅存在的理由）', async () => {
    const received: Array<{ persisted: boolean; reason?: string }> = [];
    store.onWriteResult((result) => received.push(result));

    mock.storage.local.failNextWriteWith(new Error('quota'));
    mock.storage.local.failNextWriteWith(new Error('quota'));

    await store.saveSessionDebounced({ tabs: [makeTab()], activeTabId: 'tab-1' }, 10);
    // 防抖路径没有调用方可以接收返回值，只能靠订阅知道失败
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(received).toHaveLength(1);
    expect(received[0]?.persisted).toBe(false);
    expect(received[0]?.reason).toBe('storage-failed');
  });

  it('退订后不再收到通知', async () => {
    const received: unknown[] = [];
    const unsubscribe = store.onWriteResult((result) => received.push(result));

    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    expect(received).toHaveLength(1);

    unsubscribe();
    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });
    expect(received).toHaveLength(1);
  });

  it('订阅者自身抛错不影响存储写入（写入结果仍正确返回）', async () => {
    store.onWriteResult(() => {
      throw new Error('listener boom');
    });

    const result = await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });

    expect(result.persisted).toBe(true);
  });
});

describe('读取诊断（spec FR-031/FR-032）', () => {
  it('会话读取回报丢弃条数', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.session]: {
        version: 1,
        savedAt: new Date().toISOString(),
        activeTabId: 'tab-good',
        tabs: [makeTab({ tabId: 'tab-good' }), makeTab({ tabId: 'tab-bad', historyIndex: 99 })],
      },
    });

    const { session, diagnostics } = await store.loadSessionWithDiagnostics();

    expect(session.tabs).toHaveLength(1);
    expect(diagnostics.rawCount).toBe(2);
    expect(diagnostics.acceptedCount).toBe(1);
    expect(diagnostics.discardedCount).toBe(1);
  });

  it('网站列表读取回报丢弃条数', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [makeSite({ originKey: 'https://ok.com' }), 'corrupted'],
      },
    });

    const { sites, diagnostics } = await store.loadSitesWithDiagnostics();

    expect(sites).toHaveLength(1);
    expect(diagnostics.discardedCount).toBe(1);
  });

  it('数据完好时诊断计数为 0', async () => {
    await store.saveSession({ tabs: [makeTab()], activeTabId: 'tab-1' });

    const { diagnostics } = await store.loadSessionWithDiagnostics();

    expect(diagnostics.discardedCount).toBe(0);
    expect(diagnostics.rawCount).toBe(1);
  });

  it('顶层结构损坏时诊断不虚报丢弃条数', async () => {
    await mock.storage.local.set({ [STORAGE_KEYS.session]: 'corrupted' });

    const { diagnostics } = await store.loadSessionWithDiagnostics();

    // 整份数据不可用不是"丢了几条"，计数应为 0 而不是凭空一个数字
    expect(diagnostics.discardedCount).toBe(0);
  });
});

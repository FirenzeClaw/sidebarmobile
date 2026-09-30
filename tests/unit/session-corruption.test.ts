// sidebarmobile — 损坏数据粒度丢弃单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T061：先写失败测试（RED，FR-031）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createSessionStore, type SessionStore } from '../../src/shared/session-store.ts';
import { HISTORY_LIMIT, STORAGE_KEYS } from '../../src/shared/types.ts';
import { createTabSession } from '../../src/sidebar/state/tab-session.ts';
import { createSiteRegistry } from '../../src/sidebar/state/site-registry.ts';
import { createSiteSettingsStore } from '../../src/sidebar/state/site-settings.ts';
import { createSessionPersistence } from '../../src/sidebar/state/session-persistence.ts';

let mock: BrowserMock;
let store: SessionStore;

/** 一个「扩展实例」 */
function createAppInstance() {
  let tabCounter = 0;
  const tabs = createTabSession({ createId: () => `tab-${++tabCounter}`, now: () => new Date().toISOString() });
  const sites = createSiteRegistry({ now: () => new Date().toISOString() });
  const siteSettings = createSiteSettingsStore();
  const persistence = createSessionPersistence({ store, tabs, sites, siteSettings, debounceMs: 5 });
  return { tabs, sites, siteSettings, persistence };
}

/** 构造一条合法标签的原始存储记录（可覆盖任一字段以制造损坏） */
function rawTab(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    tabId: 'tab-ok',
    originKey: 'https://example.com',
    currentUrl: 'https://example.com/',
    title: '正常标签',
    history: [{ url: 'https://example.com/', title: '正常标签', visitedAt: now }],
    historyIndex: 0,
    loadState: 'loaded',
    createdAt: now,
    ...overrides,
  };
}

/** 直接写入一份会话快照（绕过写入侧的校验，模拟"别的版本写坏的"） */
async function seedSession(tabs: unknown[], activeTabId: unknown = null): Promise<void> {
  await mock.storage.local.set({
    [STORAGE_KEYS.session]: { version: 1, tabs, activeTabId, savedAt: new Date().toISOString() },
  });
}

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local, 5);
});

describe('坏标签粒度丢弃（spec FR-031）', () => {
  it('historyIndex 越界的标签被丢弃，其余正常加载', async () => {
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-bad', historyIndex: 99 })], 'tab-good');

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
  });

  it('缺 tabId 的标签被丢弃', async () => {
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: undefined })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toHaveLength(1);
  });

  it('currentUrl 非法的标签被丢弃', async () => {
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-bad', currentUrl: 'javascript:alert(1)' })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
  });

  it('history 为空数组的标签被丢弃（无历史的标签无从恢复）', async () => {
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-bad', history: [], historyIndex: 0 })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
  });

  it('history 不是数组的标签被丢弃', async () => {
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-bad', history: 'corrupted' })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toHaveLength(1);
  });

  it('标签是字符串而不是对象的记录被丢弃', async () => {
    await seedSession([rawTab(), 'not-an-object', 42, null]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toHaveLength(1);
  });

  it('loadState 取值非法时回落 idle 而保留标签（可修复字段不回落到丢弃）', async () => {
    await seedSession([rawTab({ tabId: 'tab-1', loadState: 'teleporting' })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTab('tab-1')?.loadState).toBe('idle');
  });

  it('title 类型非法时回落 null 而保留标签', async () => {
    await seedSession([rawTab({ tabId: 'tab-1', title: { nested: true } })]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTab('tab-1')?.title).toBeNull();
  });
});

describe('坏历史条目粒度丢弃（spec FR-031）', () => {
  it('单个非法历史条目被丢弃，同标签其余条目保留', async () => {
    const now = new Date().toISOString();
    await seedSession([
      rawTab({
        tabId: 'tab-1',
        currentUrl: 'https://example.com/a',
        history: [
          { url: 'https://example.com/a', title: 'A', visitedAt: now },
          { url: 'javascript:alert(1)', title: '坏', visitedAt: now },
          { url: 'https://example.com/b', title: 'B', visitedAt: now },
        ],
        historyIndex: 0,
      }),
    ]);

    const app = createAppInstance();
    await app.persistence.restore();

    const history = app.tabs.getTab('tab-1')?.history ?? [];
    expect(history.map((entry) => entry.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('历史条目缺 visitedAt 时补零时间戳而不是丢弃', async () => {
    await seedSession([
      rawTab({
        tabId: 'tab-1',
        history: [{ url: 'https://example.com/', title: 'x' }],
        historyIndex: 0,
      }),
    ]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTab('tab-1')?.history).toHaveLength(1);
    expect(app.tabs.getTab('tab-1')?.history[0]?.visitedAt).toBeDefined();
  });

  it('历史整体非法时该标签被丢弃，其他标签不受影响', async () => {
    await seedSession([
      rawTab({ tabId: 'tab-good' }),
      rawTab({ tabId: 'tab-bad', history: [{ url: 'not-a-url' }], historyIndex: 0 }),
    ]);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
  });
});

describe('activeTabId 损坏的处理（data-model §5）', () => {
  it('指向不存在标签时置空而保留全部标签', async () => {
    await seedSession([rawTab({ tabId: 'tab-1' })], 'tab-ghost');

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toHaveLength(1);
    expect(app.tabs.getActiveTabId()).toBeNull();
  });

  it('不是字符串时置空', async () => {
    await seedSession([rawTab({ tabId: 'tab-1' })], 12345);

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getActiveTabId()).toBeNull();
  });

  it('activeTabId 指向的标签被丢弃后，活动标签随之置空', async () => {
    // 这是最隐蔽的一种：activeTabId 本身合法，但它指向的标签是坏记录
    await seedSession([rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-broken', historyIndex: 99 })], 'tab-broken');

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
    expect(app.tabs.getActiveTabId()).toBeNull();
  });
});

describe('顶层结构损坏（spec FR-031）', () => {
  it('会话不是对象时恢复空会话', async () => {
    await mock.storage.local.set({ [STORAGE_KEYS.session]: 'corrupted-string' });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toEqual([]);
  });

  it('tabs 不是数组时恢复空会话', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.session]: { version: 1, tabs: { not: 'array' }, activeTabId: null },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toEqual([]);
  });

  it('会话键缺失时恢复空会话', async () => {
    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs()).toEqual([]);
  });
});

describe('坏网站条目粒度丢弃（spec FR-031）', () => {
  it('来源非法的条目被丢弃，合法条目保留', async () => {
    const now = new Date().toISOString();
    /** 入口必须属于该条目的来源，否则会被当成坏入口丢弃（data-model §2） */
    const site = (originKey: string): Record<string, unknown> => ({
      originKey,
      title: 't',
      faviconUrl: null,
      entryPoints: [{ url: `${originKey}/`, label: null }],
      settings: { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'never' },
      addedBy: 'user',
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: null,
    });
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [site('https://good.example.com'), site('ftp://bad.example.com'), site('not-a-url')],
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.sites.getSites().map((entry) => entry.originKey)).toEqual(['https://good.example.com']);
  });

  it('入口不属于该条目的来源时丢弃该入口（其余入口保留）', async () => {
    const now = new Date().toISOString();
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [
          {
            originKey: 'https://example.com',
            title: '示例',
            faviconUrl: null,
            entryPoints: [
              { url: 'https://example.com/ok', label: null },
              // 归属错误：声称是 example.com 的入口，其实是别的来源
              { url: 'https://evil.example.org/x', label: null },
            ],
            settings: { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'never' },
            addedBy: 'user',
            createdAt: now,
            updatedAt: now,
            lastVisitedAt: null,
          },
        ],
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.sites.getSite('https://example.com')?.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/ok',
    ]);
  });

  it('条目没有合法入口时被整条丢弃', async () => {
    const now = new Date().toISOString();
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [
          {
            originKey: 'https://example.com',
            title: '空入口',
            faviconUrl: null,
            entryPoints: [],
            settings: { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'never' },
            addedBy: 'user',
            createdAt: now,
            updatedAt: now,
            lastVisitedAt: null,
          },
        ],
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.sites.getSites()).toEqual([]);
  });
});

describe('坏站点设置粒度丢弃（含 US2–US4 新增字段）', () => {
  it('来源键非法时丢弃该条设置，其余保留', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://good.example.com': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'never' },
        'not-a-url': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(Object.keys(app.siteSettings.snapshot())).toEqual(['https://good.example.com']);
  });

  it('displayMode 取值非法时回落 mobile（US2 字段）', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://example.com': { displayMode: 'tablet', uaGrant: 'never', cookieGrant: 'never' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.getDisplayMode('https://example.com')).toBe('mobile');
  });

  it('uaGrant 取值非法时回落 never（US2 字段）', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://example.com': { displayMode: 'mobile', uaGrant: 'maybe', cookieGrant: 'never' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.getGrant('https://example.com', 'ua')).toBe('never');
  });

  it('cookieGrant 取值非法时回落 never（US3 字段）', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://example.com': { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'yes' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.getGrant('https://example.com', 'cookie')).toBe('never');
  });

  it('设置不是对象时整条回落默认值而保留该来源', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: { 'https://example.com': 'corrupted' },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.getSettings('https://example.com')).toEqual({
      displayMode: 'mobile',
      uaGrant: 'never',
      cookieGrant: 'never',
    });
  });

  it('整份设置损坏时回落为空而不是抛错', async () => {
    await mock.storage.local.set({ [STORAGE_KEYS.siteSettings]: ['not', 'an', 'object'] });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.snapshot()).toEqual({});
  });
});

describe('混合损坏：坏记录不影响好记录（spec FR-031 的核心承诺）', () => {
  it('三类存储同时含坏记录时，好记录全部正常恢复', async () => {
    const now = new Date().toISOString();
    await seedSession(
      [rawTab({ tabId: 'tab-good' }), rawTab({ tabId: 'tab-bad', historyIndex: 999 })],
      'tab-good',
    );
    await mock.storage.local.set({
      [STORAGE_KEYS.sites]: {
        version: 1,
        sites: [
          {
            originKey: 'https://good.example.com',
            title: '好站点',
            faviconUrl: null,
            entryPoints: [{ url: 'https://good.example.com/', label: null }],
            settings: { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'never' },
            addedBy: 'user',
            createdAt: now,
            updatedAt: now,
            lastVisitedAt: null,
          },
          'corrupted-site-record',
        ],
      },
      [STORAGE_KEYS.siteSettings]: {
        'https://good.example.com': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'never' },
        'ftp://bad.example.com': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.tabs.getTabs().map((tab) => tab.tabId)).toEqual(['tab-good']);
    expect(app.tabs.getActiveTabId()).toBe('tab-good');
    expect(app.sites.getSites().map((entry) => entry.originKey)).toEqual(['https://good.example.com']);
    expect(app.siteSettings.getDisplayMode('https://good.example.com')).toBe('desktop');
  });
});

describe('历史超限的读取侧裁剪（spec FR-015）', () => {
  it('存储中超限的历史被裁剪到上限且当前项不变', async () => {
    const now = new Date().toISOString();
    const longHistory = Array.from({ length: HISTORY_LIMIT + 30 }, (_unused, index) => ({
      url: `https://example.com/page-${index}`,
      title: null,
      visitedAt: now,
    }));
    await seedSession([
      rawTab({
        tabId: 'tab-1',
        currentUrl: `https://example.com/page-${HISTORY_LIMIT + 29}`,
        history: longHistory,
        historyIndex: longHistory.length - 1,
      }),
    ]);

    const app = createAppInstance();
    await app.persistence.restore();

    const tab = app.tabs.getTab('tab-1')!;
    expect(tab.history).toHaveLength(HISTORY_LIMIT);
    expect(tab.historyIndex).toBe(HISTORY_LIMIT - 1);
    expect(tab.currentUrl).toBe(`https://example.com/page-${HISTORY_LIMIT + 29}`);
  });
});

// sidebarmobile — 完整会话恢复单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T060：先写失败测试（RED，FR-017/FR-018）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createSessionStore, type SessionStore } from '../../src/shared/session-store.ts';
import { STORAGE_KEYS } from '../../src/shared/types.ts';
import { createTabSession } from '../../src/sidebar/state/tab-session.ts';
import { createSiteRegistry } from '../../src/sidebar/state/site-registry.ts';
import { createSiteSettingsStore } from '../../src/sidebar/state/site-settings.ts';
import { createSessionPersistence } from '../../src/sidebar/state/session-persistence.ts';

let mock: BrowserMock;
let store: SessionStore;
let clockTick: number;

/** 可重复的时钟：让时间戳可断言 */
function tick(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 8, 29, 14, 0, clockTick)).toISOString();
}

/** 一个「扩展实例」：与 app.ts 的装配方式一致 */
function createAppInstance() {
  let tabCounter = 0;
  const tabs = createTabSession({ createId: () => `tab-${++tabCounter}`, now: tick });
  const sites = createSiteRegistry({ now: tick });
  const siteSettings = createSiteSettingsStore();
  const persistence = createSessionPersistence({ store, tabs, sites, siteSettings, debounceMs: 5 });
  return { tabs, sites, siteSettings, persistence };
}

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local, 5);
  clockTick = 0;
});

describe('完整恢复：标签与活动标签（spec FR-017）', () => {
  it('多标签全部恢复且活动标签保持原样', async () => {
    const first = createAppInstance();
    const tabA = first.tabs.openTab('https://a.example.com/');
    const tabB = first.tabs.openTab('https://b.example.com/');
    const tabC = first.tabs.openTab('https://c.example.com/');
    // 活动标签故意选中间那个：验证恢复的是"记录的那个"而不是"最后一个"
    first.tabs.activateTab(tabB!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.tabs.getTabs().map((tab) => tab.tabId)).toEqual([tabA!.tabId, tabB!.tabId, tabC!.tabId]);
    expect(second.tabs.getActiveTabId()).toBe(tabB!.tabId);
  });

  it('活动标签的 URL 与历史位置一并恢复', async () => {
    const first = createAppInstance();
    const tab = first.tabs.openTab('https://example.com/1');
    first.tabs.navigate(tab!.tabId, 'https://example.com/2');
    first.tabs.navigate(tab!.tabId, 'https://example.com/3');
    // 回退一格：历史位置停在中间，恢复后必须还是中间
    first.tabs.goBack(tab!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    const restored = second.tabs.getTab(tab!.tabId)!;
    expect(restored.history.map((entry) => entry.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
    expect(restored.historyIndex).toBe(1);
    expect(restored.currentUrl).toBe('https://example.com/2');
  });

  it('非活动标签各自的历史位置独立恢复', async () => {
    const first = createAppInstance();
    const tabA = first.tabs.openTab('https://a.example.com/1');
    first.tabs.navigate(tabA!.tabId, 'https://a.example.com/2');
    first.tabs.navigate(tabA!.tabId, 'https://a.example.com/3');
    first.tabs.goBack(tabA!.tabId);
    const tabB = first.tabs.openTab('https://b.example.com/1');
    first.tabs.navigate(tabB!.tabId, 'https://b.example.com/2');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.tabs.getTab(tabA!.tabId)?.historyIndex).toBe(1);
    expect(second.tabs.getTab(tabB!.tabId)?.historyIndex).toBe(1);
  });

  it('加载状态一并恢复（loaded 不退回 idle）', async () => {
    const first = createAppInstance();
    const tab = first.tabs.openTab('https://example.com/');
    first.tabs.setLoadState(tab!.tabId, 'loaded');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.tabs.getTab(tab!.tabId)?.loadState).toBe('loaded');
  });
});

describe('完整恢复：网站列表与站点设置（spec FR-017/FR-039）', () => {
  it('网站条目与入口全部恢复', async () => {
    const first = createAppInstance();
    first.sites.addFromUserInput('https://example.com/a');
    first.sites.addFromUserInput('https://example.com/b');
    first.sites.addFromUserInput('https://other.example.org/');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.sites.getSites()).toHaveLength(2);
    expect(second.sites.getSite('https://example.com')?.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('站点设置（显示模式 + 两项授权）全部恢复', async () => {
    const first = createAppInstance();
    first.siteSettings.setDisplayMode('https://example.com', 'desktop');
    first.siteSettings.setGrant('https://example.com', 'ua', 'granted');
    first.siteSettings.setGrant('https://example.com', 'cookie', 'revoked');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.siteSettings.getSettings('https://example.com')).toEqual({
      displayMode: 'desktop',
      uaGrant: 'granted',
      cookieGrant: 'revoked',
    });
  });

  it('设置按精确来源隔离恢复（不同端口不串）', async () => {
    const first = createAppInstance();
    first.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.siteSettings.getDisplayMode('https://example.com')).toBe('desktop');
    expect(second.siteSettings.getDisplayMode('https://example.com:8443')).toBe('mobile');
  });

  it('恢复摘要如实报告各项数量，供界面决定进哪个视图', async () => {
    const first = createAppInstance();
    first.sites.addFromUserInput('https://example.com/');
    const tab = first.tabs.openTab('https://example.com/');
    first.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    const summary = await second.persistence.restore();

    expect(summary.tabs).toBe(1);
    expect(summary.sites).toBe(1);
    expect(summary.activeTabId).toBe(tab!.tabId);
    // 有标签 → 界面进浏览视图；这一字段让调用方不必再自己数
    expect(summary.shouldOpenBrowserView).toBe(true);
  });
});

describe('全关后恢复回主页（spec FR-016）', () => {
  it('全部标签关闭后恢复摘要指示回主页', async () => {
    const first = createAppInstance();
    first.sites.addFromUserInput('https://example.com/');
    const tab = first.tabs.openTab('https://example.com/');
    await first.persistence.persistImmediately();
    first.tabs.closeTab(tab!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    const summary = await second.persistence.restore();

    expect(summary.tabs).toBe(0);
    expect(summary.activeTabId).toBeNull();
    expect(summary.shouldOpenBrowserView).toBe(false);
    // 网站列表不受标签全关影响（FR-017：两键独立）
    expect(second.sites.getSites()).toHaveLength(1);
  });

  it('空存储时恢复摘要指示回主页且不报错', async () => {
    const app = createAppInstance();
    const summary = await app.persistence.restore();

    expect(summary.tabs).toBe(0);
    expect(summary.shouldOpenBrowserView).toBe(false);
    expect(summary.corruptedRecords).toBe(0);
  });
});

describe('不恢复页面内容（spec FR-018）', () => {
  it('恢复只带回 URL 与标题，不带任何页面内容字段', async () => {
    const first = createAppInstance();
    const tab = first.tabs.openTab('https://example.com/');
    first.tabs.setTitle(tab!.tabId, '页面标题');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();
    const restored = second.tabs.getTab(tab!.tabId)!;

    // 标签的形状只允许这些字段：多一个都说明有不该持久化的东西
    expect(Object.keys(restored).sort()).toEqual([
      'createdAt',
      'currentUrl',
      'history',
      'historyIndex',
      'loadState',
      'originKey',
      'tabId',
      'title',
    ]);
    expect(restored.title).toBe('页面标题');
  });

  it('历史条目只含 url/title/visitedAt 三个字段', async () => {
    const first = createAppInstance();
    const tab = first.tabs.openTab('https://example.com/');
    first.tabs.navigate(tab!.tabId, 'https://example.com/next');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    for (const entry of second.tabs.getTab(tab!.tabId)!.history) {
      expect(Object.keys(entry).sort()).toEqual(['title', 'url', 'visitedAt']);
    }
  });
});

describe('恢复健壮性（spec FR-031 的调用方承诺）', () => {
  it('重复恢复是幂等的（不会叠加标签）', async () => {
    const first = createAppInstance();
    first.tabs.openTab('https://example.com/');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();
    await second.persistence.restore();

    expect(second.tabs.getTabs()).toHaveLength(1);
  });

  it('恢复后继续开标签不会与已恢复的 tabId 冲突', async () => {
    const first = createAppInstance();
    const existing = first.tabs.openTab('https://example.com/');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();
    const fresh = second.tabs.openTab('https://other.example.org/');

    expect(fresh!.tabId).not.toBe(existing!.tabId);
    expect(second.tabs.getTabs()).toHaveLength(2);
  });

  it('存储读取出错时恢复出空会话而不是抛异常', async () => {
    // 模拟 storage.get 不可用（配额清理期间/权限问题）
    const brokenStore: SessionStore = {
      ...store,
      async loadSession() {
        throw new Error('storage unavailable');
      },
    };
    const app = createAppInstance();
    const persistence = createSessionPersistence({
      store: brokenStore,
      tabs: app.tabs,
      sites: app.sites,
      siteSettings: app.siteSettings,
      debounceMs: 5,
    });

    await expect(persistence.restore()).resolves.toBeTypeOf('object');
  });
});

describe('存储键契约（contracts/storage-schema.md）', () => {
  it('一次落盘写入三个独立键，互不覆盖', async () => {
    const app = createAppInstance();
    app.sites.addFromUserInput('https://example.com/');
    app.tabs.openTab('https://example.com/');
    app.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await app.persistence.persistImmediately();

    const keys = Object.keys(mock.storage.local.snapshot()).sort();
    expect(keys).toEqual([STORAGE_KEYS.meta, STORAGE_KEYS.session, STORAGE_KEYS.siteSettings, STORAGE_KEYS.sites].sort());
  });

  it('会话键含 version/tabs/activeTabId/savedAt 四个字段', async () => {
    const app = createAppInstance();
    app.tabs.openTab('https://example.com/');
    await app.persistence.persistImmediately();

    const session = mock.storage.local.snapshot()[STORAGE_KEYS.session] as Record<string, unknown>;
    expect(Object.keys(session).sort()).toEqual(['activeTabId', 'savedAt', 'tabs', 'version']);
    expect(session['version']).toBe(1);
  });
});

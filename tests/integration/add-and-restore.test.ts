// sidebarmobile — 添加与恢复集成测试（测试）
// 2026-09-29 | Kimi(speckit-implement) | T022：先写失败集成测试（RED，FR-004/FR-016/FR-017）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createSessionStore, type SessionStore } from '../../src/shared/session-store.ts';
import { STORAGE_KEYS } from '../../src/shared/types.ts';
import { createTabSession, type TabSession } from '../../src/sidebar/state/tab-session.ts';
import { createSiteRegistry, type SiteRegistry } from '../../src/sidebar/state/site-registry.ts';
import { createSessionPersistence, type SessionPersistence } from '../../src/sidebar/state/session-persistence.ts';

let mock: BrowserMock;
let store: SessionStore;
let idCounter: number;
let clockTick: number;

/** 一个「扩展实例」：模拟一次侧栏打开期间的完整状态层 */
interface AppInstance {
  tabs: TabSession;
  sites: SiteRegistry;
  persistence: SessionPersistence;
}

/**
 * 构造扩展实例。
 *
 * 关键：多次调用共享同一个 mock.storage，模型化「关闭侧栏再重开 / 扩展重载」，
 * 从而验证恢复路径而非内存态的延续。
 */
function createAppInstance(): AppInstance {
  const tabs = createTabSession({
    createId: () => `tab-${++idCounter}`,
    now: () => {
      clockTick += 1;
      return new Date(Date.UTC(2026, 8, 29, 12, 0, clockTick)).toISOString();
    },
  });
  const sites = createSiteRegistry({
    now: () => {
      clockTick += 1;
      return new Date(Date.UTC(2026, 8, 29, 12, 0, clockTick)).toISOString();
    },
  });
  const persistence = createSessionPersistence({ store, tabs, sites, debounceMs: 5 });
  return { tabs, sites, persistence };
}

/** 等待防抖写入窗口结束 */
function settleDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local, 5);
  idCounter = 0;
  clockTick = 0;
});

describe('添加网址并打开新标签（spec FR-004）', () => {
  it('添加合法网址后网站条目与新标签同时存在，且新标签是活动标签', async () => {
    const app = createAppInstance();

    const added = app.sites.addFromUserInput('https://example.com/');
    const tab = app.tabs.openTab(added!.site.entryPoints[0]!.url);

    expect(added!.created).toBe(true);
    expect(tab).not.toBeNull();
    expect(app.tabs.getActiveTabId()).toBe(tab!.tabId);
    expect(app.tabs.getTabs()).toHaveLength(1);
  });

  it('重复添加同一网址复用已有条目但仍打开新标签', () => {
    const app = createAppInstance();
    app.sites.addFromUserInput('https://example.com/');
    app.tabs.openTab('https://example.com/');

    const again = app.sites.addFromUserInput('https://example.com/');
    const secondTab = app.tabs.openTab(again!.site.entryPoints[0]!.url);

    expect(again!.created).toBe(false);
    expect(app.sites.getSites()).toHaveLength(1);
    expect(app.tabs.getTabs()).toHaveLength(2);
    expect(app.tabs.getActiveTabId()).toBe(secondTab!.tabId);
  });

  it('非法网址既不建条目也不开标签', () => {
    const app = createAppInstance();

    expect(app.sites.addFromUserInput('javascript:alert(1)')).toBeNull();
    expect(app.tabs.openTab('javascript:alert(1)')).toBeNull();

    expect(app.sites.getSites()).toHaveLength(0);
    expect(app.tabs.getTabs()).toHaveLength(0);
  });

  it('多标签各自保持独立 URL 与历史（spec FR-014）', () => {
    const app = createAppInstance();
    const first = app.tabs.openTab('https://example.com/');
    const second = app.tabs.openTab('https://other.example.org/');

    app.tabs.navigate(second!.tabId, 'https://other.example.org/page-2');

    expect(app.tabs.getTab(first!.tabId)?.currentUrl).toBe('https://example.com/');
    expect(app.tabs.getTab(first!.tabId)?.history).toHaveLength(1);
    expect(app.tabs.getTab(second!.tabId)?.currentUrl).toBe('https://other.example.org/page-2');
    expect(app.tabs.getTab(second!.tabId)?.history).toHaveLength(2);
  });
});

describe('历史位置驱动导航键状态（spec FR-014/FR-022）', () => {
  it('导航推进历史后前进可用性回落到无；后退一次后前进恢复可用', () => {
    const app = createAppInstance();
    const tab = app.tabs.openTab('https://example.com/');

    expect(app.tabs.canGoBack(tab!.tabId)).toBe(false);
    expect(app.tabs.canGoForward(tab!.tabId)).toBe(false);

    app.tabs.navigate(tab!.tabId, 'https://example.com/second');
    expect(app.tabs.canGoBack(tab!.tabId)).toBe(true);
    expect(app.tabs.canGoForward(tab!.tabId)).toBe(false);

    app.tabs.goBack(tab!.tabId);
    // 后退后历史位置落在中间，前进重新可用（底栏据此重绘，不依赖缓存的按钮态）
    expect(app.tabs.canGoForward(tab!.tabId)).toBe(true);
    expect(app.tabs.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/');

    app.tabs.goForward(tab!.tabId);
    expect(app.tabs.canGoBack(tab!.tabId)).toBe(true);
    expect(app.tabs.canGoForward(tab!.tabId)).toBe(false);
    expect(app.tabs.getTab(tab!.tabId)?.currentUrl).toBe('https://example.com/second');
  });

  it('切换标签后导航键状态跟随新活动标签，而非上一标签', () => {
    const app = createAppInstance();
    const shallow = app.tabs.openTab('https://example.com/');
    const deep = app.tabs.openTab('https://other.example.org/');
    app.tabs.navigate(deep!.tabId, 'https://other.example.org/second');

    expect(app.tabs.canGoBack(deep!.tabId)).toBe(true);

    app.tabs.activateTab(shallow!.tabId);
    const active = app.tabs.getActiveTab();
    expect(active?.tabId).toBe(shallow!.tabId);
    // 活动标签的历史只有一条：底栏必须显示为不可后退
    expect(app.tabs.canGoBack(active!.tabId)).toBe(false);
  });
});

describe('重开侧栏后的恢复（spec FR-016/FR-017）', () => {
  it('标签、活动标签、历史位置与网站列表全部恢复', async () => {
    const first = createAppInstance();
    first.sites.addFromUserInput('https://example.com/');
    const tabA = first.tabs.openTab('https://example.com/');
    first.tabs.navigate(tabA!.tabId, 'https://example.com/docs');
    const tabB = first.tabs.openTab('https://other.example.org/');
    first.tabs.activateTab(tabA!.tabId);

    await first.persistence.persistImmediately();

    const second = createAppInstance();
    const hydration = await second.persistence.restore();

    expect(hydration.sites).toBe(1);
    expect(hydration.tabs).toBe(2);
    expect(second.sites.getSite('https://example.com')?.title).toBe('example.com');
    expect(second.tabs.getActiveTabId()).toBe(tabA!.tabId);
    const restoredTab = second.tabs.getTab(tabA!.tabId)!;
    expect(restoredTab.history.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/docs',
    ]);
    expect(restoredTab.currentUrl).toBe('https://example.com/docs');
    expect(second.tabs.getTab(tabB!.tabId)).not.toBeNull();
  });

  it('恢复标签不再重新加载页面内容以外的状态时不产生重复标签', async () => {
    const first = createAppInstance();
    first.tabs.openTab('https://example.com/');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();
    await second.persistence.restore();

    expect(second.tabs.getTabs()).toHaveLength(1);
  });

  it('空存储时恢复出空会话与空网站列表', async () => {
    const app = createAppInstance();

    const hydration = await app.persistence.restore();

    expect(hydration.tabs).toBe(0);
    expect(hydration.sites).toBe(0);
    expect(hydration.activeTabId).toBeNull();
    // 空存储 → 不进浏览视图（回主页，FR-016）；且没有坏记录要报告
    expect(hydration.shouldOpenBrowserView).toBe(false);
    expect(hydration.corruptedRecords).toBe(0);
    expect(app.tabs.getTabs()).toHaveLength(0);
    expect(app.sites.getSites()).toHaveLength(0);
  });
});

describe('关闭标签不随重启恢复（spec FR-016）', () => {
  it('关闭标签后立即落盘，重开后该标签不再出现', async () => {
    const first = createAppInstance();
    const keepTab = first.tabs.openTab('https://example.com/');
    const dropTab = first.tabs.openTab('https://drop.example.org/');
    await first.persistence.persistImmediately();

    first.tabs.closeTab(dropTab!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.tabs.getTabs().map((tab) => tab.tabId)).toEqual([keepTab!.tabId]);
    expect(second.tabs.getTab(dropTab!.tabId)).toBeNull();
  });

  it('关闭标签即落到存储，无需等待防抖窗口', async () => {
    const app = createAppInstance();
    const tab = app.tabs.openTab('https://example.com/');
    app.persistence.startAutoSave();
    await settleDebounce();

    app.tabs.closeTab(tab!.tabId);
    // 不等待防抖窗口：关闭语义必须即时可见
    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.session] as { tabs: unknown[] } | undefined;

    expect(stored?.tabs).toEqual([]);
  });

  it('全部标签关闭后重开回到无标签状态（网站列表仍在，spec FR-017）', async () => {
    const first = createAppInstance();
    first.sites.addFromUserInput('https://example.com/');
    const onlyTab = first.tabs.openTab('https://example.com/');
    await first.persistence.persistImmediately();

    first.tabs.closeTab(onlyTab!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    const hydration = await second.persistence.restore();

    expect(hydration.tabs).toBe(0);
    expect(hydration.activeTabId).toBeNull();
    expect(second.sites.getSites().map((site) => site.originKey)).toEqual(['https://example.com']);
  });

  it('关闭非活动标签不影响活动标签的恢复', async () => {
    const first = createAppInstance();
    const dropTab = first.tabs.openTab('https://drop.example.org/');
    const activeTab = first.tabs.openTab('https://keep.example.org/');
    await first.persistence.persistImmediately();

    first.tabs.closeTab(dropTab!.tabId);
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.tabs.getActiveTabId()).toBe(activeTab!.tabId);
  });
});

describe('变更自动保存（spec FR-017）', () => {
  it('导航变更经防抖后落盘', async () => {
    const app = createAppInstance();
    const tab = app.tabs.openTab('https://example.com/');
    app.persistence.startAutoSave();

    app.tabs.navigate(tab!.tabId, 'https://example.com/next');
    await settleDebounce();

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.session] as
      | { tabs: Array<{ currentUrl: string }> }
      | undefined;
    expect(stored?.tabs[0]?.currentUrl).toBe('https://example.com/next');
  });

  it('网站列表新增随即落盘（无需等待防抖窗口）', async () => {
    const app = createAppInstance();
    app.persistence.startAutoSave();

    app.sites.addFromUserInput('https://example.com/');
    // 网站列表变更频率低（增删改），存储层走即时写入，不必等防抖窗口
    await new Promise((resolve) => setTimeout(resolve, 5));

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.sites] as
      | { sites: Array<{ originKey: string }> }
      | undefined;
    expect(stored?.sites.map((site) => site.originKey)).toEqual(['https://example.com']);
  });

  it('停止自动保存后不再写入', async () => {
    const app = createAppInstance();
    app.persistence.startAutoSave();
    const tab = app.tabs.openTab('https://example.com/');
    await settleDebounce();

    app.persistence.stopAutoSave();
    app.tabs.navigate(tab!.tabId, 'https://example.com/after-stop');
    app.tabs.closeTab(tab!.tabId);
    await settleDebounce();

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.session] as
      | { tabs: Array<{ currentUrl: string }> }
      | undefined;
    expect(stored?.tabs[0]?.currentUrl).toBe('https://example.com/');
  });

  it('写入失败时记录失败结果而不抛出（spec FR-032）', async () => {
    const app = createAppInstance();
    app.tabs.openTab('https://example.com/');
    mock.storage.local.failNextWriteWith(new Error('quota exceeded'));
    mock.storage.local.failNextWriteWith(new Error('quota exceeded'));

    const result = await app.persistence.persistImmediately();

    expect(result?.persisted).toBe(false);
    expect(app.persistence.lastResult()?.persisted).toBe(false);
  });

  it('持久化内容不含 Cookie 值、密码与表单字段（spec FR-018/FR-033）', async () => {
    const app = createAppInstance();
    app.sites.addFromUserInput('https://example.com/');
    const tab = app.tabs.openTab('https://example.com/');
    app.tabs.navigate(tab!.tabId, 'https://example.com/docs');
    await app.persistence.persistImmediately();

    // 注意：cookieGrant 是合法持久化的「用户意愿」标记（FR-011/FR-039），
    // 因此这里断言的是敏感值字段名，而非 cookie 一词本身。
    const rawText = JSON.stringify(mock.storage.local.snapshot());
    expect(rawText).not.toContain('cookieValue');
    expect(rawText).not.toContain('password');
    expect(rawText).not.toContain('formData');
    expect(rawText).not.toContain('document.cookie');
    expect(rawText).not.toContain('<script');
  });
});

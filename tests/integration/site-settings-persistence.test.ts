// sidebarmobile — 站点设置持久化集成测试（测试）
// 2026-09-29 | Kimi(speckit-implement) | T033/T039：设置跨重启恢复（FR-039），坏数据粒度丢弃（FR-031）

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

/** 一个「扩展实例」：与 app.ts 的装配方式一致 */
function createAppInstance() {
  const tabs = createTabSession({ createId: () => `tab-${Math.random().toString(36).slice(2)}`, now: () => new Date().toISOString() });
  const sites = createSiteRegistry({ now: () => new Date().toISOString() });
  const siteSettings = createSiteSettingsStore();
  const persistence = createSessionPersistence({ store, tabs, sites, siteSettings, debounceMs: 5 });
  return { tabs, sites, siteSettings, persistence };
}

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local, 5);
});

describe('站点设置跨重启恢复（spec FR-039）', () => {
  it('显示模式与授权标记重开后一致恢复', async () => {
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

  it('不同来源的设置各自恢复（不串用）', async () => {
    const first = createAppInstance();
    first.siteSettings.setDisplayMode('https://a.example.com', 'desktop');
    first.siteSettings.setDisplayMode('https://b.example.com', 'mobile');
    first.siteSettings.setGrant('https://a.example.com', 'ua', 'granted');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.siteSettings.getDisplayMode('https://a.example.com')).toBe('desktop');
    expect(second.siteSettings.getDisplayMode('https://b.example.com')).toBe('mobile');
    expect(second.siteSettings.getGrant('https://a.example.com', 'ua')).toBe('granted');
    expect(second.siteSettings.getGrant('https://b.example.com', 'ua')).toBe('never');
  });

  it('未设置的来源在恢复后仍是默认值（不被凭空写入）', async () => {
    const first = createAppInstance();
    first.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await first.persistence.persistImmediately();

    const second = createAppInstance();
    await second.persistence.restore();

    expect(second.siteSettings.getSettings('https://untouched.example.org')).toEqual({
      displayMode: 'mobile',
      uaGrant: 'never',
      cookieGrant: 'never',
    });
    expect(second.siteSettings.snapshot()['https://untouched.example.org']).toBeUndefined();
  });

  it('设置变更自动落盘（无需显式 persistImmediately）', async () => {
    const app = createAppInstance();
    app.persistence.startAutoSave();

    app.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 40));

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.siteSettings] as
      | Record<string, { displayMode: string }>
      | undefined;
    expect(stored?.['https://example.com']?.displayMode).toBe('desktop');
  });

  it('设置与会话、网站列表分键存储，互不覆盖', async () => {
    const app = createAppInstance();
    app.sites.addFromUserInput('https://example.com/');
    app.tabs.openTab('https://example.com/');
    app.siteSettings.setDisplayMode('https://example.com', 'desktop');
    await app.persistence.persistImmediately();

    const keys = Object.keys(mock.storage.local.snapshot()).sort();
    expect(keys).toContain(STORAGE_KEYS.session);
    expect(keys).toContain(STORAGE_KEYS.sites);
    expect(keys).toContain(STORAGE_KEYS.siteSettings);
  });
});

describe('设置坏数据粒度丢弃（spec FR-031）', () => {
  it('非法来源键被丢弃，合法项保留', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://good.example.com': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'never' },
        'not-a-url': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
        'ftp://bad.example.com': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
      },
    });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(Object.keys(app.siteSettings.snapshot())).toEqual(['https://good.example.com']);
  });

  it('非法字段回落默认值，条目本身保留', async () => {
    await mock.storage.local.set({
      [STORAGE_KEYS.siteSettings]: {
        'https://example.com': { displayMode: 'tablet', uaGrant: 'yes', cookieGrant: 42 },
      },
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
    await mock.storage.local.set({ [STORAGE_KEYS.siteSettings]: 'corrupted-string' });

    const app = createAppInstance();
    await app.persistence.restore();

    expect(app.siteSettings.snapshot()).toEqual({});
  });
});

describe('未接线站点设置时行为不变（US1 兼容性）', () => {
  it('不传 siteSettings 时恢复与保存照常工作', async () => {
    const persistenceWithoutSettings = createSessionPersistence({ store, tabs: createTabSession({ createId: () => 'tab-1', now: () => new Date().toISOString() }), sites: createSiteRegistry({ now: () => new Date().toISOString() }), debounceMs: 5 });

    const summary = await persistenceWithoutSettings.restore();
    expect(summary.tabs).toBe(0);
    expect(summary.sites).toBe(0);
    expect(summary.activeTabId).toBeNull();
    expect(summary.shouldOpenBrowserView).toBe(false);

    await persistenceWithoutSettings.persistImmediately();
    expect(mock.storage.local.snapshot()[STORAGE_KEYS.siteSettings]).toBeUndefined();
  });
});

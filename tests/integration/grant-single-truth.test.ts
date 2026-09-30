// sidebarmobile — 授权状态单一真相集成测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A1/A2/A4：storage 是授权标记的唯一真相

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createSessionStore, type SessionStore } from '../../src/shared/session-store.ts';
import { STORAGE_KEYS } from '../../src/shared/types.ts';
import { createSiteSettingsStore } from '../../src/sidebar/state/site-settings.ts';
import { createSessionPersistence } from '../../src/sidebar/state/session-persistence.ts';
import { createTabSession } from '../../src/sidebar/state/tab-session.ts';
import { createSiteRegistry } from '../../src/sidebar/state/site-registry.ts';

const ORIGIN = 'http://127.0.0.1:8921';

let mock: BrowserMock;
let store: SessionStore;

beforeEach(() => {
  mock = createBrowserMock();
  store = createSessionStore(mock.storage.local, 5);
});

/** 一个「侧栏实例」：与 app.ts 的装配方式一致 */
function createSidebar() {
  let counter = 0;
  const tabs = createTabSession({ createId: () => `tab-${++counter}`, now: () => new Date().toISOString() });
  const sites = createSiteRegistry({ now: () => new Date().toISOString() });
  const siteSettings = createSiteSettingsStore();
  const persistence = createSessionPersistence({ store, tabs, sites, siteSettings, debounceMs: 5 });
  return { tabs, sites, siteSettings, persistence };
}

/** 后台写授权标记的方式（与 background/index.ts 的 writeSettings 同构） */
async function backgroundWriteGrant(originKey: string, grant: 'ua' | 'cookie'): Promise<void> {
  const raw = await mock.storage.local.get(STORAGE_KEYS.siteSettings);
  const storedAll = raw[STORAGE_KEYS.siteSettings];
  const all = typeof storedAll === 'object' && storedAll !== null ? (storedAll as Record<string, unknown>) : {};
  const entry = (all[originKey] ?? {}) as Record<string, unknown>;
  await mock.storage.local.set({
    [STORAGE_KEYS.siteSettings]: {
      ...all,
      [originKey]: {
        displayMode: entry['displayMode'] ?? 'mobile',
        uaGrant: grant === 'ua' ? 'granted' : (entry['uaGrant'] ?? 'never'),
        cookieGrant: grant === 'cookie' ? 'granted' : (entry['cookieGrant'] ?? 'never'),
      },
    },
  });
}

/**
 * 终审 A1：`syncGrantFromState` 只降级不升格，全库无 `setGrant(..., 'granted')`。
 *
 * 后台写了 granted 但侧栏内存态不知道 → 用户点了允许、规则已生效，界面显示开关仍关。
 * 修法：storage 是授权标记的唯一真相，侧栏订阅它的变更并把后台写入镜像到内存。
 */
describe('授权标记的单一真相（终审 A1）', () => {
  it('后台写入 granted 后，侧栏内存态同步为 granted', async () => {
    const sidebar = createSidebar();
    await sidebar.persistence.restore();
    // 订阅变更（修复后提供的能力）
    sidebar.persistence.startAutoSave();

    await backgroundWriteGrant(ORIGIN, 'ua');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sidebar.siteSettings.getGrant(ORIGIN, 'ua')).toBe('granted');
  });

  it('订阅前已存在的 granted 在恢复时读入', async () => {
    await backgroundWriteGrant(ORIGIN, 'ua');

    const sidebar = createSidebar();
    await sidebar.persistence.restore();

    expect(sidebar.siteSettings.getGrant(ORIGIN, 'ua')).toBe('granted');
  });
});

/**
 * 终审 A2：`scheduleSettingsWrite` 把侧栏整份内存快照覆盖写，会把后台刚写的 granted 抹成 never。
 * 修法：侧栏写入时只改自己的字段（displayMode），授权字段以 storage 现有值为准。
 */
describe('侧栏写入不覆盖后台的授权标记（终审 A2）', () => {
  it('后台写 granted 后侧栏改显示模式，granted 仍在', async () => {
    const sidebar = createSidebar();
    await sidebar.persistence.restore();
    sidebar.persistence.startAutoSave();

    await backgroundWriteGrant(ORIGIN, 'ua');
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 侧栏改显示模式（会触发设置写入）
    sidebar.siteSettings.setDisplayMode(ORIGIN, 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.siteSettings] as
      | Record<string, { uaGrant?: string; displayMode?: string }>
      | undefined;
    expect(stored?.[ORIGIN]?.uaGrant).toBe('granted');
    expect(stored?.[ORIGIN]?.displayMode).toBe('desktop');
  });

  it('侧栏内存态不含 granted 时写入也不会抹掉它', async () => {
    const sidebar = createSidebar();
    await sidebar.persistence.restore();
    sidebar.persistence.startAutoSave();

    // 侧栏内存态先写入 displayMode（此时它并不知道后台稍后授予）
    sidebar.siteSettings.setDisplayMode(ORIGIN, 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 40));

    // 后台授予
    await backgroundWriteGrant(ORIGIN, 'cookie');
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 侧栏再次改动显示模式
    sidebar.siteSettings.setDisplayMode(ORIGIN, 'mobile');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.siteSettings] as
      | Record<string, { cookieGrant?: string }>
      | undefined;
    expect(stored?.[ORIGIN]?.cookieGrant).toBe('granted');
  });

  it('两项授权与其他来源的显示模式互不干扰', async () => {
    const sidebar = createSidebar();
    await sidebar.persistence.restore();
    sidebar.persistence.startAutoSave();

    sidebar.siteSettings.setDisplayMode('https://a.example.com', 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await backgroundWriteGrant(ORIGIN, 'ua');
    await new Promise((resolve) => setTimeout(resolve, 60));
    sidebar.siteSettings.setDisplayMode(ORIGIN, 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const stored = mock.storage.local.snapshot()[STORAGE_KEYS.siteSettings] as
      | Record<string, { displayMode?: string; uaGrant?: string }>
      | undefined;
    expect(stored?.['https://a.example.com']?.displayMode).toBe('desktop');
    expect(stored?.[ORIGIN]?.displayMode).toBe('desktop');
    expect(stored?.[ORIGIN]?.uaGrant).toBe('granted');
  });
});

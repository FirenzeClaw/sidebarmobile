// sidebarmobile — 站点设置单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T030：先写失败测试（RED，FR-008/FR-038）

import { beforeEach, describe, expect, it } from 'vitest';
import { createSiteSettingsStore, type SiteSettingsStore } from '../../src/sidebar/state/site-settings.ts';

let store: SiteSettingsStore;

beforeEach(() => {
  store = createSiteSettingsStore();
});

describe('显示模式默认与切换（spec FR-008）', () => {
  it('未设置过的来源默认移动模式', () => {
    expect(store.getDisplayMode('https://example.com')).toBe('mobile');
  });

  it('切换为桌面模式后该来源记住设置', () => {
    expect(store.setDisplayMode('https://example.com', 'desktop')).toBe(true);
    expect(store.getDisplayMode('https://example.com')).toBe('desktop');
  });

  it('切回移动模式同样被记住', () => {
    store.setDisplayMode('https://example.com', 'desktop');
    expect(store.setDisplayMode('https://example.com', 'mobile')).toBe(true);
    expect(store.getDisplayMode('https://example.com')).toBe('mobile');
  });

  it('设为相同值不产生变更通知', () => {
    let notifications = 0;
    store.onChange(() => {
      notifications += 1;
    });

    // 默认即 mobile，重复设为 mobile 属空操作
    expect(store.setDisplayMode('https://example.com', 'mobile')).toBe(false);
    expect(notifications).toBe(0);
  });
});

describe('按精确来源隔离（spec FR-038）', () => {
  it('切换某来源的模式不影响其他来源', () => {
    store.setDisplayMode('https://example.com', 'desktop');

    expect(store.getDisplayMode('https://example.com')).toBe('desktop');
    expect(store.getDisplayMode('https://other.example.org')).toBe('mobile');
  });

  it('不同端口是不同来源，各自独立', () => {
    store.setDisplayMode('https://example.com', 'desktop');

    expect(store.getDisplayMode('https://example.com')).toBe('desktop');
    expect(store.getDisplayMode('https://example.com:8443')).toBe('mobile');
  });

  it('不同协议是不同来源，各自独立', () => {
    store.setDisplayMode('http://example.com', 'desktop');

    expect(store.getDisplayMode('http://example.com')).toBe('desktop');
    expect(store.getDisplayMode('https://example.com')).toBe('mobile');
  });

  it('子域名不与主域名共享设置', () => {
    store.setDisplayMode('https://example.com', 'desktop');

    expect(store.getDisplayMode('https://www.example.com')).toBe('mobile');
  });

  it('非法来源键被拒绝且不产生设置项', () => {
    expect(store.setDisplayMode('', 'desktop')).toBe(false);
    expect(store.setDisplayMode('not-a-url', 'desktop')).toBe(false);
    expect(store.setDisplayMode('ftp://example.com', 'desktop')).toBe(false);
    expect(store.snapshot()).toEqual({});
  });
});

describe('授权标记状态机（data-model §4）', () => {
  it('授权标记默认为 never', () => {
    expect(store.getGrant('https://example.com', 'ua')).toBe('never');
    expect(store.getGrant('https://example.com', 'cookie')).toBe('never');
  });

  it('开启授权把标记置为 granted', () => {
    expect(store.setGrant('https://example.com', 'ua', 'granted')).toBe(true);
    expect(store.getGrant('https://example.com', 'ua')).toBe('granted');
  });

  it('revoked 是合法状态（用户关闭或外部撤销）', () => {
    store.setGrant('https://example.com', 'ua', 'granted');
    store.setGrant('https://example.com', 'ua', 'revoked');

    expect(store.getGrant('https://example.com', 'ua')).toBe('revoked');
  });

  it('再次开启可从 revoked 回到 granted', () => {
    store.setGrant('https://example.com', 'ua', 'revoked');
    store.setGrant('https://example.com', 'ua', 'granted');

    expect(store.getGrant('https://example.com', 'ua')).toBe('granted');
  });

  it('UA 与 Cookie 授权严格独立（spec FR-009/FR-011）', () => {
    store.setGrant('https://example.com', 'ua', 'granted');

    expect(store.getGrant('https://example.com', 'ua')).toBe('granted');
    expect(store.getGrant('https://example.com', 'cookie')).toBe('never');
  });

  it('清理授权标记（外部撤销后回归未授权）', () => {
    store.setGrant('https://example.com', 'ua', 'granted');
    expect(store.clearGrant('https://example.com', 'ua')).toBe(true);

    expect(store.getGrant('https://example.com', 'ua')).toBe('never');
    expect(store.getGrant('https://example.com', 'cookie')).toBe('never');
  });

  it('清理未授权的标记不产生变更', () => {
    expect(store.clearGrant('https://example.com', 'ua')).toBe(false);
  });

  it('授权标记同样按精确来源隔离', () => {
    store.setGrant('https://example.com', 'ua', 'granted');

    expect(store.getGrant('https://a.example.com', 'ua')).toBe('never');
    expect(store.getGrant('https://example.com:9443', 'ua')).toBe('never');
  });
});

describe('设置快照（spec FR-039 持久化契约）', () => {
  it('未设置的来源取到默认设置', () => {
    expect(store.getSettings('https://example.com')).toEqual({
      displayMode: 'mobile',
      uaGrant: 'never',
      cookieGrant: 'never',
    });
  });

  it('快照只包含被显式改动过的来源', () => {
    store.setDisplayMode('https://example.com', 'desktop');
    store.setGrant('https://other.example.org', 'cookie', 'granted');

    expect(store.snapshot()).toEqual({
      'https://example.com': { displayMode: 'desktop', uaGrant: 'never', cookieGrant: 'never' },
      'https://other.example.org': { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'granted' },
    });
  });

  it('恢复到新存储后设置一致', () => {
    store.setDisplayMode('https://example.com', 'desktop');
    store.setGrant('https://example.com', 'ua', 'granted');
    store.setGrant('https://example.com', 'cookie', 'revoked');

    const restored = createSiteSettingsStore();
    restored.restore(store.snapshot());

    expect(restored.getSettings('https://example.com')).toEqual({
      displayMode: 'desktop',
      uaGrant: 'granted',
      cookieGrant: 'revoked',
    });
  });

  it('恢复时丢弃非法来源键与非法取值（spec FR-031）', () => {
    const restored = createSiteSettingsStore();
    restored.restore({
      'https://good.example.org': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'never' },
      'not-a-url': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
      'ftp://bad.example.org': { displayMode: 'desktop', uaGrant: 'granted', cookieGrant: 'granted' },
    });

    expect(Object.keys(restored.snapshot())).toEqual(['https://good.example.org']);
  });

  it('恢复时非法字段回落到默认值而不是整条丢弃', () => {
    const restored = createSiteSettingsStore();
    restored.restore({
      'https://example.com': { displayMode: 'tablet', uaGrant: 'maybe', cookieGrant: 1 },
    });

    expect(restored.getSettings('https://example.com')).toEqual({
      displayMode: 'mobile',
      uaGrant: 'never',
      cookieGrant: 'never',
    });
  });
});

describe('变更通知（持久化接线）', () => {
  it('有效变更触发通知，退订后停止', () => {
    let notifications = 0;
    const unsubscribe = store.onChange(() => {
      notifications += 1;
    });

    store.setDisplayMode('https://example.com', 'desktop');
    store.setGrant('https://example.com', 'ua', 'granted');
    expect(notifications).toBe(2);

    unsubscribe();
    store.setDisplayMode('https://other.example.org', 'desktop');
    expect(notifications).toBe(2);
  });
});

// sidebarmobile — 授权标记同步测试（测试）
// 2026-09-30 | Kimi(fix) | 用户实测缺陷回归：点「允许」后开关必须升格为已授权

import { beforeEach, describe, expect, it } from 'vitest';
import { syncGrantsFromReview } from '../../src/sidebar/state/grant-sync.ts';
import { createSiteSettingsStore, type SiteSettingsStore } from '../../src/sidebar/state/site-settings.ts';
import type { CapabilityState } from '../../src/shared/types.ts';
import { createInitialCapabilityState } from '../../src/shared/types.ts';

/**
 * 本文件锁定一个用户实测缺陷（2026-09-30）：
 *
 * 权限弹窗出现、用户点「允许」、后台复核通过、DNR 规则也落了，**开关却弹回关闭** ——
 * 因为同步函数只做降级（unauthorized → revoked）、从不升格，全 src 没有任何一处
 * 把标记写成 `granted`。
 *
 * 关键区分：开关 = 用户是否授权（复核通过即开）；徽章 = 能力生效到什么程度。
 * 若混为一谈（只在 active 时升格），授权到手但规则落地有延迟时开关会弹回，
 * 用户会以为"我明明点了允许"。
 *
 * 测试直接调用**真实实现**（`syncGrantsFromReview`）—— 此前该规则藏在 app.ts 内部，
 * 只能靠复刻等价实现来测，而复刻测的是复刻本身，这正是缺陷能漏过 590 项测试的原因。
 */

/** 构造一个只含指定能力字段的状态，其余取初始值 */
function stateWith(overrides: Partial<CapabilityState>): CapabilityState {
  return { ...createInitialCapabilityState(), ...overrides };
}

const ORIGIN = 'https://example.com';

let settings: SiteSettingsStore;

beforeEach(() => {
  settings = createSiteSettingsStore();
});

describe('授权成功必须升格开关（用户实测缺陷回归）', () => {
  it('UA 复核通过且规则生效（active）→ 标记升格为 granted', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'active' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('granted');
  });

  it('UA 已授权但规则未落地（degraded）→ 开关仍应开启，由徽章说明降级', () => {
    // 最容易修错的一档：只认 active 会让这种情形下开关弹回，
    // 用户看到"我明明点了允许，开关却关着"
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'degraded' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('granted');
  });

  it('Cookie 复核通过（available）→ 标记升格为 granted', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ cookie: 'available' }));
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('granted');
  });

  it('Cookie 能力受限（limited）→ 开关仍应开启', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ cookie: 'limited' }));
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('granted');
  });

  it('Cookie 未检测到会话（absent）→ 开关仍应开启（授权与"有无会话"无关）', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ cookie: 'absent' }));
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('granted');
  });

  it('两项授权互不影响：升格 UA 不改动 Cookie', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'active', cookie: 'unauthorized' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('granted');
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('never');
  });

  it('返回被改动的项，供调用方决定是否重绘', () => {
    expect(syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'active' }))).toEqual(['ua']);
    // 已经是 granted 时不重复上报改动
    expect(syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'active' }))).toEqual([]);
  });
});

describe('降级与撤销语义保持不变（FR-030）', () => {
  it('已授权后被复核为 unauthorized → 标记回到 revoked', () => {
    settings.setGrant(ORIGIN, 'ua', 'granted');
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'unauthorized' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('revoked');
  });

  it('从未授权且复核未通过 → 保持 never（不伪造 revoked）', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'unauthorized' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('never');
  });

  it('浏览器不支持（unsupported）→ 不升格，也不写成 revoked', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'unsupported' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('never');
  });

  it('未知状态（unknown）→ 不升格（未探测到不等于已授权）', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'unknown' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('never');
  });

  it('能力失败（failed）→ 不升格', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ cookie: 'failed' }));
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('never');
  });

  it('两项都通过时同时升格', () => {
    syncGrantsFromReview(settings, ORIGIN, stateWith({ ua: 'active', cookie: 'available' }));
    expect(settings.getGrant(ORIGIN, 'ua')).toBe('granted');
    expect(settings.getGrant(ORIGIN, 'cookie')).toBe('granted');
  });
});

// sidebarmobile — Cookie 存在性结论的诚实映射测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B2：未检测到会话不得显示为「已检测到会话」

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createPermissionsPort } from '../../src/adapters/permissions.ts';
import { createUaOverride } from '../../src/adapters/ua-override.ts';
import { createCookieInsight } from '../../src/adapters/cookie-insight.ts';
import { createGrantCoordinator } from '../../src/background/grant-coordinator.ts';
import { createDefaultSiteSettings } from '../../src/shared/types.ts';
import { cookieBadgeFor } from '../../src/sidebar/components/status-badge.ts';
import { createCapabilityState } from '../../src/shared/capability-state.ts';

const ORIGIN = 'https://example.com';

let mock: BrowserMock;

beforeEach(() => {
  mock = createBrowserMock();
});

function createCoordinator() {
  return createGrantCoordinator({
    permissions: createPermissionsPort(mock.permissions),
    uaOverride: createUaOverride({ dnr: undefined }),
    cookieInsight: createCookieInsight(mock.cookies),
  });
}

/**
 * 终审 B2：`buildCookieInput` 把 `present` 与 `absent` 同等对待，两者都落到 `available`，
 * 而 `available` 的徽章文案是「已检测到会话」—— 于是**授权了但没有会话的站点会被声称检测到会话**。
 *
 * 能力可用（API 正常）与会话存在是两件事，必须分开表达。修法：探测到 `absent` 时给出独立状态。
 */
describe('Cookie 未检测到会话与已检测到会话是两档（终审 B2）', () => {
  it('站点无 Cookie 时能力为 absent，不是 available', async () => {
    // 不设置任何 Cookie：探测结果必然是 absent
    const outcome = await createCoordinator().requestGrant(ORIGIN, 'cookie', createDefaultSiteSettings());

    expect(outcome.granted).toBe(true);
    expect(outcome.state.cookie).toBe('absent');
  });

  it('站点有 Cookie 时能力为 available', async () => {
    mock.cookies.setCookieCountForUrl(`${ORIGIN}/`, 2);

    const outcome = await createCoordinator().requestGrant(ORIGIN, 'cookie', createDefaultSiteSettings());

    expect(outcome.state.cookie).toBe('available');
  });

  it('absent 的徽章文案不得声称已检测到会话', () => {
    const absentBadge = cookieBadgeFor('absent');
    const availableBadge = cookieBadgeFor('available');

    expect(absentBadge.label).not.toBe(availableBadge.label);
    expect(absentBadge.label).not.toContain('已检测到');
    expect(absentBadge.label).toContain('未检测到');
  });

  it('absent 既不是失败也不是未授权（能力本身可用）', () => {
    const absent = cookieBadgeFor('absent');

    expect(absent.tone).not.toBe('danger');
    expect(absent.label).not.toContain('未授权');
  });

  it('能力状态映射：探测结果为 absent 时不给 available', () => {
    const state = createCapabilityState({
      cookie: { grant: 'granted', permissionHeld: true, sessionPresent: false },
    });

    expect(state.cookie).toBe('absent');
  });

  it('能力状态映射：探测结果为 present 时给 available', () => {
    const state = createCapabilityState({
      cookie: { grant: 'granted', permissionHeld: true, sessionPresent: true },
    });

    expect(state.cookie).toBe('available');
  });

  it('未授权优先于探测结果：外部撤销后不因曾有会话而报 available', () => {
    const state = createCapabilityState({
      cookie: { grant: 'granted', permissionHeld: false, sessionPresent: true },
    });

    expect(state.cookie).toBe('unauthorized');
  });
});

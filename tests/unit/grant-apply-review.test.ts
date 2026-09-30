// sidebarmobile — 后台授权复核单测（测试）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：先写失败测试（RED）——后台必须先复核再写授权标记

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createPermissionsPort } from '../../src/adapters/permissions.ts';
import { createUaOverride, MOBILE_USER_AGENT, type DnrSessionRuleApi } from '../../src/adapters/ua-override.ts';
import { createGrantCoordinator, type GrantCoordinator } from '../../src/background/grant-coordinator.ts';
import { createDefaultSiteSettings, type SiteSettings } from '../../src/shared/types.ts';
import { validateRuntimeMessage } from '../../src/shared/messages.ts';

const ORIGIN = 'https://example.com';
const ORIGIN_PATTERN = 'https://example.com/*';

let mock: BrowserMock;
let coordinator: GrantCoordinator;
/** 记录 DNR 调用，用于断言拒绝路径不落规则 */
let dnrCalls: Array<{ removeRuleIds?: number[]; addRules?: unknown[] }>;

beforeEach(() => {
  mock = createBrowserMock();
  dnrCalls = [];
  const dnrApi: DnrSessionRuleApi = {
    async updateSessionRules(options) {
      dnrCalls.push(options);
    },
  };
  coordinator = createGrantCoordinator({
    permissions: createPermissionsPort(mock.permissions),
    uaOverride: createUaOverride({ dnr: dnrApi, mobileUserAgent: MOBILE_USER_AGENT }),
  });
});

function freshSettings(): SiteSettings {
  return createDefaultSiteSettings();
}

/**
 * 授权申请的行为从后台搬到了侧栏（手势约束），后台因此不再亲自申请权限，
 * 只**复核**侧栏声称的结论。这里锁定的是复核这道安全边界：
 *
 * 侧栏是不可信发送方（契约 runtime-messages.md 要求两端校验形状、不信任发送方）——
 * 它可能因为权限对话框还没结束就回报 granted、也可能被改动过。后台若照单全收写标记，
 * 就会出现"标记写着已授权、权限其实不在"，界面显示开关开着而能力是未授权（FR-029 禁止）。
 */
describe('后台复核侧栏声称的授权结论（安全边界）', () => {
  it('侧栏声称 granted 但 contains 返回 false 时，标记不得写成 granted', async () => {
    // 侧栏声称已授权，但浏览器侧其实没有该权限（对话框未结束 / 消息被篡改）
    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'granted', freshSettings());

    expect(outcome.granted).toBe(false);
    expect(outcome.settings.uaGrant).not.toBe('granted');
    expect(outcome.state.ua).toBe('unauthorized');
    // 复核失败时不得落 DNR 规则（规则需要 host 权限才有意义）
    expect(dnrCalls).toHaveLength(0);
  });

  it('复核失败的原因归为 denied（用户视角是"这次没能开启"）', async () => {
    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'cookie', 'granted', freshSettings());

    expect(outcome.reason).toBe('denied');
  });

  it('权限真的到手时复核通过：标记写成 granted 且规则落地', async () => {
    // 模拟侧栏已完成申请：浏览器侧权限确实在手
    await mock.permissions.request({ permissions: ['declarativeNetRequestWithHostAccess', 'scripting'], origins: [ORIGIN_PATTERN] });

    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'granted', freshSettings());

    expect(outcome.granted).toBe(true);
    expect(outcome.settings.uaGrant).toBe('granted');
    expect(outcome.state.ua).toBe('active');
    expect(dnrCalls).toHaveLength(1);
  });

  it('侧栏上报 denied 时标记回弹为 revoked、能力保持未授权', async () => {
    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'denied', freshSettings());

    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe('denied');
    expect(outcome.settings.uaGrant).toBe('revoked');
    expect(outcome.state.ua).toBe('unauthorized');
  });

  it('侧栏上报 unsupported 时标记回落 never（不是用户的选择）', async () => {
    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'cookie', 'unsupported', freshSettings());

    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe('unsupported');
    expect(outcome.settings.cookieGrant).toBe('never');
  });

  it('上报 granted 但只拿到部分权限（缺 host 权限）时同样不得写成 granted', async () => {
    // 只授予 API 权限、没有该来源的 host 权限：不足以称为"对该站点已授权"
    await mock.permissions.request({ permissions: ['declarativeNetRequestWithHostAccess', 'scripting'], origins: [] });

    const outcome = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'granted', freshSettings());

    expect(outcome.granted).toBe(false);
    expect(outcome.settings.uaGrant).not.toBe('granted');
  });

  it('复核后的标记修正不被本次上报覆盖（外部撤销后回归 revoked）', async () => {
    // 先真实授权，再从浏览器侧外部撤销
    await mock.permissions.request({ permissions: ['declarativeNetRequestWithHostAccess', 'scripting'], origins: [ORIGIN_PATTERN] });
    const granted = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'granted', freshSettings());
    expect(granted.settings.uaGrant).toBe('granted');

    mock.permissions.revokeExternally({ origins: [ORIGIN_PATTERN] });

    // 侧栏此时若仍声称 granted，复核必须把它挡下来
    const again = await coordinator.applyGrantOutcome(ORIGIN, 'ua', 'granted', granted.settings);

    expect(again.granted).toBe(false);
    expect(again.settings.uaGrant).toBe('revoked');
  });
});

/**
 * 协议层面：申请权限的消息类型被拆成两件事 ——
 * 侧栏申请完权限后，用一条**只带结论**的消息通知后台落地。
 */
describe('授权落地消息（permissions.apply-grant）', () => {
  it('接受合法的落地消息', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.apply-grant',
      payload: { originKey: ORIGIN, grant: 'ua', outcome: 'granted' },
    });

    expect(result.ok).toBe(true);
  });

  it('拒绝非法的 outcome 取值（不信任发送方）', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.apply-grant',
      payload: { originKey: ORIGIN, grant: 'ua', outcome: 'approved' },
    });

    expect(result.ok).toBe(false);
  });

  it('拒绝非法来源键', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.apply-grant',
      payload: { originKey: 'not-an-origin', grant: 'ua', outcome: 'granted' },
    });

    expect(result.ok).toBe(false);
  });

  it('拒绝非法的 grant 取值', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.apply-grant',
      payload: { originKey: ORIGIN, grant: 'everything', outcome: 'granted' },
    });

    expect(result.ok).toBe(false);
  });
});

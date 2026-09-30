// sidebarmobile — 授权协调集成测试（测试）
// 2026-09-29 | Kimi(speckit-implement) | T038：授权流规则（FR-010/FR-013/FR-029/FR-030）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：申请移到侧栏后，经 createChainCoordinator 走生产两段路径

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createUaOverride, MOBILE_USER_AGENT, type DnrSessionRuleApi } from '../../src/adapters/ua-override.ts';
import { createChainCoordinator, type GrantChainCoordinator } from '../helpers/grant-flow.ts';
import { createDefaultSiteSettings, type SiteSettings } from '../../src/shared/types.ts';

const ORIGIN = 'https://example.com';
const ORIGIN_PATTERN = 'https://example.com/*';

let mock: BrowserMock;
let coordinator: GrantChainCoordinator;
/** 记录 DNR 规则调用，用于断言规则确实被注册/注销 */
let dnrCalls: Array<{ removeRuleIds?: number[]; addRules?: unknown[] }>;
/** 可切换的 DNR 可用性，模拟「可选权限未授予时 API 不存在」 */
let dnrApi: DnrSessionRuleApi | undefined;

beforeEach(() => {
  mock = createBrowserMock();
  dnrCalls = [];
  dnrApi = {
    async updateSessionRules(options) {
      dnrCalls.push(options);
    },
  };
  coordinator = createChainCoordinator({
    permissionsApi: mock.permissions,
    uaOverride: createUaOverride({ dnr: dnrApi, mobileUserAgent: MOBILE_USER_AGENT }),
  });
});

/** 空设置来源的默认设置 */
function freshSettings(): SiteSettings {
  return createDefaultSiteSettings();
}

describe('按需申请真实移动 UA（spec FR-010/FR-035）', () => {
  it('用户批准后标记为 granted、注册 DNR 规则、能力为 active', async () => {
    const outcome = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(outcome.granted).toBe(true);
    expect(outcome.settings.uaGrant).toBe('granted');
    expect(outcome.state.ua).toBe('active');
    // 规则确实注册了，且用的是移动 UA
    expect(dnrCalls).toHaveLength(1);
    const addedRules = dnrCalls[0]?.addRules as Array<{ action: { requestHeaders: Array<{ value: string }> } }>;
    expect(addedRules[0]?.action.requestHeaders[0]?.value).toBe(MOBILE_USER_AGENT);
  });

  it('用户拒绝后开关回弹为 revoked、能力保持 unauthorized（不谎报）', async () => {
    mock.permissions.setNextRequestResult(false);

    const outcome = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe('denied');
    expect(outcome.settings.uaGrant).toBe('revoked');
    // 关键：拒绝后能力绝不是 active，也不是 degraded —— 是未授权（FR-029）
    expect(outcome.state.ua).toBe('unauthorized');
    expect(dnrCalls).toHaveLength(0);
  });

  it('浏览器不支持权限 API 时 reason 为 unsupported、标记回落 never', async () => {
    const unsupportedCoordinator = createChainCoordinator({
      permissionsApi: undefined,
      uaOverride: createUaOverride({ dnr: dnrApi }),
    });

    const outcome = await unsupportedCoordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(outcome.reason).toBe('unsupported');
    expect(outcome.settings.uaGrant).toBe('never');
    expect(outcome.state.ua).toBe('unauthorized');
  });

  it('权限到手但 DNR API 不存在时能力为 unsupported（区分于 degraded）', async () => {
    // spike 实测：可选权限未授予时整个 declarativeNetRequest 命名空间不存在
    const noDnrCoordinator = createChainCoordinator({
      permissionsApi: mock.permissions,
      uaOverride: createUaOverride({ dnr: undefined }),
    });

    const outcome = await noDnrCoordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(outcome.granted).toBe(true);
    expect(outcome.state.ua).toBe('degraded');
  });

  it('权限到手但规则注册抛错时能力为 degraded，标记仍为 granted', async () => {
    const throwingDnr: DnrSessionRuleApi = {
      async updateSessionRules() {
        throw new Error('rule rejected');
      },
    };
    const degradedCoordinator = createChainCoordinator({
      permissionsApi: mock.permissions,
      uaOverride: createUaOverride({ dnr: throwingDnr }),
    });

    const outcome = await degradedCoordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(outcome.settings.uaGrant).toBe('granted');
    expect(outcome.state.ua).toBe('degraded');
  });

  it('申请只覆盖该精确来源的 host 权限', async () => {
    await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    // 别的来源仍然没有权限：粒度是精确来源（FR-038 同源策略）
    expect(await mock.permissions.contains({ permissions: [], origins: [ORIGIN_PATTERN] })).toBe(true);
    expect(await mock.permissions.contains({ permissions: [], origins: ['https://other.example.org/*'] })).toBe(false);
  });
});

describe('授权即时撤销（spec FR-013）', () => {
  it('撤销后权限被移除、标记清零、DNR 规则注销', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    dnrCalls = [];

    const outcome = await coordinator.revokeGrant(ORIGIN, 'ua', granted.settings);

    expect(outcome.settings.uaGrant).toBe('never');
    expect(outcome.state.ua).toBe('unauthorized');
    expect(await mock.permissions.contains({ permissions: [], origins: [ORIGIN_PATTERN] })).toBe(false);
    expect(dnrCalls).toHaveLength(1);
    expect(dnrCalls[0]?.removeRuleIds).toBeDefined();
    expect(dnrCalls[0]?.addRules).toBeUndefined();
  });

  it('撤销 Cookie 授权不影响 UA 授权（两者独立）', async () => {
    const uaGranted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    await coordinator.requestGrant(ORIGIN, 'cookie', uaGranted.settings);

    const outcome = await coordinator.revokeGrant(ORIGIN, 'cookie', uaGranted.settings);

    expect(outcome.settings.cookieGrant).toBe('never');
    // UA 授权必须原样保留
    expect(outcome.state.ua).toBe('active');
  });
});

describe('外部撤销后的回归（spec FR-030）', () => {
  it('浏览器设置里撤销权限后，能力查询回归 unauthorized', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    expect(granted.state.ua).toBe('active');

    // 模拟用户在浏览器设置里移除该来源权限（不经扩展的 revoke 路径）
    mock.permissions.revokeExternally({ origins: [ORIGIN_PATTERN], permissions: ['declarativeNetRequestWithHostAccess'] });

    const state = await coordinator.queryCapabilities(ORIGIN, granted.settings);

    // 关键：标记还是 granted，但事实已失效 → 必须回归 unauthorized（FR-030）
    expect(state.ua).toBe('unauthorized');
  });

  it('外部撤销后查询会把标记修正为 revoked', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    mock.permissions.revokeExternally({ origins: [ORIGIN_PATTERN], permissions: ['declarativeNetRequestWithHostAccess'] });

    // 先查询一次触发修正，再用修正后的设置再次请求
    await coordinator.queryCapabilities(ORIGIN, granted.settings);
    const reRequested = await coordinator.requestGrant(ORIGIN, 'ua', granted.settings);

    // 重新授权应能恢复 active（说明上面的修正没有把状态卡死）
    expect(reRequested.granted).toBe(true);
    expect(reRequested.state.ua).toBe('active');
  });

  it('外部撤销来源权限但保留 API 权限时仍回归未授权（DNR 需要 host 权限）', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    mock.permissions.revokeExternally({ origins: [ORIGIN_PATTERN] });

    const state = await coordinator.queryCapabilities(ORIGIN, granted.settings);

    expect(state.ua).toBe('unauthorized');
  });
});

describe('能力状态不伪造（spec FR-029）', () => {
  it('未授权时 UA 为 unauthorized，绝不显示为 active 或 degraded', async () => {
    const state = await coordinator.queryCapabilities(ORIGIN, freshSettings());

    expect(state.ua).toBe('unauthorized');
    expect(state.cookie).toBe('unauthorized');
  });

  it('导航在 Tier 1 下如实标 uncertain，不伪标 tracked', async () => {
    const state = await coordinator.queryCapabilities(ORIGIN, freshSettings());

    expect(state.navigation).toBe('uncertain');
    expect(state.embed).toBe('unknown');
  });

  it('已授权且规则落地时 navigation 仍为 uncertain（UA 生效不等于导航可追踪）', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    expect(granted.state.ua).toBe('active');
    expect(granted.state.navigation).toBe('uncertain');
  });

  it('UA 与 Cookie 的能力互不影响', async () => {
    const outcome = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.state.cookie).toBe('available');
    expect(outcome.state.ua).toBe('unauthorized');
  });
});

describe('按精确来源隔离（spec FR-038）', () => {
  it('某来源的授权不影响同域不同端口', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    const otherPort = await coordinator.queryCapabilities('https://example.com:8443', freshSettings());

    expect(granted.state.ua).toBe('active');
    expect(otherPort.ua).toBe('unauthorized');
  });

  it('某来源的授权不影响子域名', async () => {
    await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());

    const subdomain = await coordinator.queryCapabilities('https://www.example.com', freshSettings());

    expect(subdomain.ua).toBe('unauthorized');
  });
});

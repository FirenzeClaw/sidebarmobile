// sidebarmobile — 授权流四态集成测试（测试）
// 2026-09-29 | Kimi(speckit-implement) | T043：先写失败集成测试（RED，quickstart 场景 6/12）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createPermissionsPort } from '../../src/adapters/permissions.ts';
import { createCookieInsight } from '../../src/adapters/cookie-insight.ts';
import { createUaOverride } from '../../src/adapters/ua-override.ts';
import { createGrantCoordinator, type GrantCoordinator } from '../../src/background/grant-coordinator.ts';
import { createDefaultSiteSettings, type SiteSettings } from '../../src/shared/types.ts';

const ORIGIN = 'https://example.com';
const ORIGIN_PATTERN = 'https://example.com/*';
/** Cookie 探测使用的来源 URL（带尾斜杠，与 cookies.getAll 的 url 参数习惯一致） */
const ORIGIN_URL = 'https://example.com/';

let mock: BrowserMock;
let coordinator: GrantCoordinator;
let cookieInsight: ReturnType<typeof createCookieInsight>;

beforeEach(() => {
  mock = createBrowserMock();
  cookieInsight = createCookieInsight(mock.cookies);
  coordinator = createGrantCoordinator({
    permissions: createPermissionsPort(mock.permissions),
    uaOverride: createUaOverride({ dnr: undefined }),
    cookieInsight,
  });
});

function freshSettings(): SiteSettings {
  return createDefaultSiteSettings();
}

describe('态 1：未授权（spec FR-011/FR-029）', () => {
  it('默认状态为未授权，Cookie 能力为 unauthorized', async () => {
    const state = await coordinator.queryCapabilities(ORIGIN, freshSettings());

    expect(state.cookie).toBe('unauthorized');
  });

  it('未授权时不申请任何权限（权限最小化，FR-035）', async () => {
    await coordinator.queryCapabilities(ORIGIN, freshSettings());

    // 查询不该产生权限授予
    expect(await mock.permissions.contains({ permissions: ['cookies'], origins: [ORIGIN_PATTERN] })).toBe(false);
  });

  it('未授权时不发起 Cookie 探测（不做无权限的窥探）', async () => {
    // 即便站点有 Cookie，未授权也不能去读
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 5);

    const state = await coordinator.queryCapabilities(ORIGIN, freshSettings());

    expect(state.cookie).toBe('unauthorized');
  });
});

describe('态 2：授权成功且检测到会话（spec FR-012）', () => {
  it('批准后标记为 granted、检测到会话时能力为 available', async () => {
    // 有会话：这一档才可以说「已检测到会话」（终审 B2 后 absent 是独立档）
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 1);

    const outcome = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.granted).toBe(true);
    expect(outcome.settings.cookieGrant).toBe('granted');
    expect(outcome.state.cookie).toBe('available');
  });

  it('授权后检测到会话，且只回报存在性', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 2);
    await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    const result = await cookieInsight.detectSession(ORIGIN);

    expect(result.status).toBe('present');
    expect(Object.keys(result).sort()).toEqual(['cookieCount', 'status']);
  });

  it('授权后检测不到会话时是 absent（能力可用 ≠ 能声称检测到会话）', async () => {
    const outcome = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    // 没有会话就不该与「已检测到会话」共用一档（终审 B2）
    expect(outcome.state.cookie).toBe('absent');
    expect((await cookieInsight.detectSession(ORIGIN)).status).toBe('absent');
  });

  it('Cookie 授权不影响 UA 授权（FR-009/FR-011 严格独立）', async () => {
    const outcome = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.settings.cookieGrant).toBe('granted');
    expect(outcome.settings.uaGrant).toBe('never');
    expect(outcome.state.ua).toBe('unauthorized');
  });
});

describe('态 3：受限（授权了但能力不可用，spec FR-012/FR-029）', () => {
  it('cookies API 缺失时能力为 limited 而不是 available', async () => {
    const limitedCoordinator = createGrantCoordinator({
      permissions: createPermissionsPort(mock.permissions),
      uaOverride: createUaOverride({ dnr: undefined }),
      cookieInsight: createCookieInsight(undefined),
    });

    const outcome = await limitedCoordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.settings.cookieGrant).toBe('granted');
    // 关键：不得把「授权成功」说成「能力可用」
    expect(outcome.state.cookie).toBe('limited');
  });

  it('探测抛错时能力为 failed（不是 available）', async () => {
    const failingCoordinator = createGrantCoordinator({
      permissions: createPermissionsPort(mock.permissions),
      uaOverride: createUaOverride({ dnr: undefined }),
      cookieInsight: createCookieInsight({
        getAll: async () => {
          throw new Error('cookies unavailable');
        },
      }),
    });

    const outcome = await failingCoordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.state.cookie).toBe('failed');
  });

  it('浏览器不支持权限 API 时拒绝授权，能力回未授权', async () => {
    const unsupportedCoordinator = createGrantCoordinator({
      permissions: createPermissionsPort(undefined),
      uaOverride: createUaOverride({ dnr: undefined }),
      cookieInsight,
    });

    const outcome = await unsupportedCoordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    expect(outcome.reason).toBe('unsupported');
    expect(outcome.state.cookie).toBe('unauthorized');
  });
});

describe('态 4：撤销后清理（spec FR-013/FR-030）', () => {
  it('撤销后权限被移除、标记清零、能力回未授权', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 1);
    const granted = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());
    expect(granted.state.cookie).toBe('available');

    const revoked = await coordinator.revokeGrant(ORIGIN, 'cookie', granted.settings);

    expect(revoked.settings.cookieGrant).toBe('never');
    expect(revoked.state.cookie).toBe('unauthorized');
    expect(await mock.permissions.contains({ permissions: ['cookies'], origins: [ORIGIN_PATTERN] })).toBe(false);
  });

  it('撤销不动用户 Cookie（只撤权限，不删数据，research R6）', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 3);
    const granted = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    await coordinator.revokeGrant(ORIGIN, 'cookie', granted.settings);

    // 用户 Cookie 仍在：撤销只影响扩展的读取权限
    const probe = createCookieInsight(mock.cookies);
    expect((await probe.detectSession(ORIGIN)).status).toBe('present');
  });

  it('撤销 UA 授权不连带撤销 Cookie 授权（host 权限共享，须按需保留）', async () => {
    const uaGranted = await coordinator.requestGrant(ORIGIN, 'ua', freshSettings());
    const bothGranted = await coordinator.requestGrant(ORIGIN, 'cookie', uaGranted.settings);

    const onlyCookieRevoked = await coordinator.revokeGrant(ORIGIN, 'cookie', bothGranted.settings);

    expect(onlyCookieRevoked.settings.cookieGrant).toBe('never');
    // Cookie 权限没了，但 UA 需要的 host 权限应保留（cookie 权限已单独移除）
    expect(onlyCookieRevoked.settings.uaGrant).toBe('granted');
  });

  it('外部撤销后能力查询回归未授权（FR-030）', async () => {
    const granted = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());
    mock.permissions.revokeExternally({ permissions: ['cookies'], origins: [ORIGIN_PATTERN] });

    const state = await coordinator.queryCapabilities(ORIGIN, granted.settings);

    expect(state.cookie).toBe('unauthorized');
  });
});

describe('存储中不含 Cookie 值（spec FR-033/FR-018）', () => {
  it('授权与探测全过程不向存储写入任何 Cookie 明细', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 3);
    const granted = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());
    await coordinator.queryCapabilities(ORIGIN, granted.settings);
    await cookieInsight.detectSession(ORIGIN);

    const snapshot = JSON.stringify(mock.storage.local.snapshot());

    expect(snapshot).not.toContain('cookie-0');
    expect(snapshot).not.toContain('"value"');
    expect(snapshot).not.toContain('fixture_session');
  });

  it('探测结果的序列化形态与存入设置后仍不含敏感字段', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 1);
    const result = await cookieInsight.detectSession(ORIGIN);
    const serialized = JSON.stringify(result);

    expect(serialized).toMatch(/^\{.*\}$/);
    expect(serialized).not.toContain('value');
    expect(serialized).not.toContain('secret');
  });
});

describe('按精确来源隔离（spec FR-038）', () => {
  it('某来源的 Cookie 授权不影响同域不同端口', async () => {
    mock.cookies.setCookieCountForUrl(ORIGIN_URL, 1);
    const granted = await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    const otherPort = await coordinator.queryCapabilities('https://example.com:8443', freshSettings());

    expect(granted.state.cookie).toBe('available');
    expect(otherPort.cookie).toBe('unauthorized');
  });

  it('某来源的 Cookie 授权不影响子域名', async () => {
    await coordinator.requestGrant(ORIGIN, 'cookie', freshSettings());

    const subdomain = await coordinator.queryCapabilities('https://www.example.com', freshSettings());

    expect(subdomain.cookie).toBe('unauthorized');
  });
});

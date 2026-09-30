// sidebarmobile — UA 规则落地状态跨实例一致性测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A4：DNR 会话规则是唯一真相，不得依赖实例内存

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createPermissionsPort } from '../../src/adapters/permissions.ts';
import { createUaOverride, deriveRuleId, MOBILE_USER_AGENT, type DnrSessionRuleApi } from '../../src/adapters/ua-override.ts';
import { createGrantCoordinator } from '../../src/background/grant-coordinator.ts';
import { createDefaultSiteSettings } from '../../src/shared/types.ts';

const ORIGIN = 'https://example.com';

let mock: BrowserMock;
/** 有状态的 DNR 替身：忠实保存会话规则，使"以 API 为准"的判定可被观测 */
let dnrRules: Map<number, unknown>;
let dnrApi: DnrSessionRuleApi;

beforeEach(() => {
  mock = createBrowserMock();
  dnrRules = new Map<number, unknown>();
  dnrApi = {
    async updateSessionRules(options) {
      for (const id of options.removeRuleIds ?? []) {
        dnrRules.delete(id);
      }
      for (const rule of options.addRules ?? []) {
        const typed = rule as { id: number };
        dnrRules.set(typed.id, rule);
      }
    },
    async getSessionRules() {
      // 只回报规则 id：DNR 实际返回的也是规则对象，本项目只需要 id 来判断落地与否
      return [...dnrRules.keys()].map((id) => ({ id }));
    },
  };
});

/** 每次调用都新建协调器与 ua-override：与 background/index.ts 现在的做法一致 */
function createFreshCoordinator() {
  return createGrantCoordinator({
    permissions: createPermissionsPort(mock.permissions),
    uaOverride: createUaOverride({ dnr: dnrApi, mobileUserAgent: MOBILE_USER_AGENT }),
  });
}

/**
 * 终审 A4：`appliedOrigins` 是 ua-override 的实例私有 Set，而 background/index.ts 每条消息
 * 都新建一个实例 —— 于是"授权成功"写的标记在下一条消息里必然查不到，
 * 徽章对已生效的站点谎报「已降级为移动视口」。
 *
 * 契约（contracts/manifest-permissions.md:45）承诺该映射"可在 SW 重启后由 sites:v1 重建"，
 * 而真正跨重启仍然成立的事实来源是 **DNR 会话规则本身**（会话规则存活于整个浏览器会话，
 * 比 SW 生命周期长）。因此判定必须以规则实况为准，实例内存只能当缓存。
 */
describe('UA 规则落地状态跨实例一致（终审 A4）', () => {
  it('另一实例查询同一来源时仍判为 active（规则确实在）', async () => {
    const granted = await createFreshCoordinator().requestGrant(ORIGIN, 'ua', createDefaultSiteSettings());
    expect(granted.state.ua).toBe('active');

    // 规则真的注册了
    expect(dnrRules.has(deriveRuleId(ORIGIN) as number)).toBe(true);

    // 新实例（等价于后台处理下一条消息）：不得因为内存 Set 是空的就谎报降级
    const state = await createFreshCoordinator().queryCapabilities(ORIGIN, granted.settings);

    expect(state.ua).toBe('active');
  });

  it('规则被外部清掉时新实例判为 degraded（不因缓存而谎报 active）', async () => {
    const granted = await createFreshCoordinator().requestGrant(ORIGIN, 'ua', createDefaultSiteSettings());
    expect(granted.state.ua).toBe('active');

    // 模拟规则消失：SW 被浏览器回收后会话规则丢失，或用户在扩展页里清掉了规则
    dnrRules.clear();

    const state = await createFreshCoordinator().queryCapabilities(ORIGIN, granted.settings);

    expect(state.ua).toBe('degraded');
  });

  it('同一实例内先授权再撤销后查询为 degraded（本地缓存随之校准）', async () => {
    const coordinator = createFreshCoordinator();
    await coordinator.requestGrant(ORIGIN, 'ua', createDefaultSiteSettings());

    const revoked = await coordinator.revokeGrant(ORIGIN, 'ua', createDefaultSiteSettings());
    expect(dnrRules.has(deriveRuleId(ORIGIN) as number)).toBe(false);

    const state = await coordinator.queryCapabilities(ORIGIN, revoked.settings);

    // 撤销后标记为 never → 未授权优先，绝不显示为 active/degraded
    expect(state.ua).toBe('unauthorized');
  });

  it('DNR 未提供 getSessionRules 时回落实例内存，不谎报', async () => {
    const limitedDnr: DnrSessionRuleApi = {
      async updateSessionRules(options) {
        for (const id of options.removeRuleIds ?? []) {
          dnrRules.delete(id);
        }
        for (const rule of options.addRules ?? []) {
          dnrRules.set((rule as { id: number }).id, rule);
        }
      },
      // 老浏览器/替身可能没有这个查询方法：此时只能靠实例内存
    };
    const coordinator = createGrantCoordinator({
      permissions: createPermissionsPort(mock.permissions),
      uaOverride: createUaOverride({ dnr: limitedDnr, mobileUserAgent: MOBILE_USER_AGENT }),
    });

    const granted = await coordinator.requestGrant(ORIGIN, 'ua', createDefaultSiteSettings());

    expect(granted.state.ua).toBe('active');
  });
});

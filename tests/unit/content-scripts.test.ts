// sidebarmobile — content script 注册单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T056：动态注册/注销契约（contracts/manifest-permissions.md）

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createContentScriptPort,
  FRAME_REPORTER_FILE,
  matchPatternFor,
  originKeyFromFrameUrl,
  scriptIdFor,
  type ContentScriptPort,
  type ScriptingApiLike,
} from '../../src/adapters/content-scripts.ts';

/** 记录调用的 scripting 替身 */
let registeredCalls: unknown[][];
let unregisteredCalls: Array<{ ids?: string[] } | undefined>;
let scripting: ScriptingApiLike;
let port: ContentScriptPort;

beforeEach(() => {
  registeredCalls = [];
  unregisteredCalls = [];
  scripting = {
    async registerContentScripts(scripts) {
      registeredCalls.push(scripts);
    },
    async unregisterContentScripts(filter) {
      unregisteredCalls.push(filter);
    },
    async getRegisteredContentScripts() {
      return [];
    },
  };
  port = createContentScriptPort({ scripting });
});

describe('注册 id 与 match pattern 推导', () => {
  it('同一来源永远得到同一 id（SW 重启后可重建）', () => {
    expect(scriptIdFor('https://example.com')).toBe(scriptIdFor('https://example.com'));
  });

  it('不同来源得到不同 id', () => {
    expect(scriptIdFor('https://example.com')).not.toBe(scriptIdFor('https://other.example.org'));
  });

  it('不同端口是不同 id（精确来源）', () => {
    expect(scriptIdFor('https://example.com')).not.toBe(scriptIdFor('https://example.com:8443'));
  });

  it('非法来源键返回 null', () => {
    expect(scriptIdFor('not-a-url')).toBeNull();
    expect(scriptIdFor('ftp://example.com')).toBeNull();
    expect(scriptIdFor('')).toBeNull();
  });

  it('match pattern 精确到来源（含端口）', () => {
    expect(matchPatternFor('https://example.com')).toBe('https://example.com/*');
    expect(matchPatternFor('https://example.com:8443')).toBe('https://example.com:8443/*');
    expect(matchPatternFor('http://127.0.0.1:8919')).toBe('http://127.0.0.1:8919/*');
  });

  it('非法来源键的 match pattern 为 null', () => {
    expect(matchPatternFor('not-a-url')).toBeNull();
  });

  it('由 frame URL 反查来源键', () => {
    expect(originKeyFromFrameUrl('https://example.com:8443/page?x=1')).toBe('https://example.com:8443');
    expect(originKeyFromFrameUrl('https://example.com/page')).toBe('https://example.com');
    expect(originKeyFromFrameUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('注册（spec FR-020 Tier 2）', () => {
  it('注册时带上精确来源、allFrames 与构建产物文件名', async () => {
    const ok = await port.register('https://example.com');

    expect(ok).toBe(true);
    expect(registeredCalls).toHaveLength(1);
    const script = (registeredCalls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(script['matches']).toEqual(['https://example.com/*']);
    expect(script['js']).toEqual([FRAME_REPORTER_FILE]);
    // allFrames 必须为真：侧栏的 iframe 本身是子框架
    expect(script['allFrames']).toBe(true);
    expect(script['runAt']).toBe('document_idle');
  });

  it('重复注册幂等，不产生第二次 API 调用', async () => {
    await port.register('https://example.com');
    const second = await port.register('https://example.com');

    expect(second).toBe(true);
    expect(registeredCalls).toHaveLength(1);
  });

  it('注册后 isRegistered 为真', async () => {
    await port.register('https://example.com');
    expect(port.isRegistered('https://example.com')).toBe(true);
    expect(port.isRegistered('https://other.example.org')).toBe(false);
  });

  it('非法来源不注册也不登记', async () => {
    const ok = await port.register('not-a-url');

    expect(ok).toBe(false);
    expect(registeredCalls).toHaveLength(0);
    expect(port.isRegistered('not-a-url')).toBe(false);
  });

  it('API 不可用时返回 false（Tier 2 不可用，降级为 Tier 1）', async () => {
    const noApi = createContentScriptPort({ scripting: undefined });

    expect(noApi.isSupported()).toBe(false);
    await expect(noApi.register('https://example.com')).resolves.toBe(false);
    expect(noApi.isRegistered('https://example.com')).toBe(false);
  });

  it('注册抛错时返回 false 且不登记（不谎报已启用）', async () => {
    const failing = createContentScriptPort({
      scripting: {
        async registerContentScripts() {
          throw new Error('scripting permission not granted');
        },
        async unregisterContentScripts() {},
      },
    });

    await expect(failing.register('https://example.com')).resolves.toBe(false);
    expect(failing.isRegistered('https://example.com')).toBe(false);
  });
});

describe('注销（spec FR-013 即时撤销）', () => {
  it('注销使用精确 id', async () => {
    await port.register('https://example.com');
    const ok = await port.unregister('https://example.com');

    expect(ok).toBe(true);
    expect(unregisteredCalls).toHaveLength(1);
    expect(unregisteredCalls[0]?.ids).toEqual([scriptIdFor('https://example.com')]);
  });

  it('注销后 isRegistered 为假', async () => {
    await port.register('https://example.com');
    await port.unregister('https://example.com');

    expect(port.isRegistered('https://example.com')).toBe(false);
  });

  it('注销未注册的来源幂等，不抛异常', async () => {
    await expect(port.unregister('https://never.example.org')).resolves.toBeTypeOf('boolean');
  });

  it('注销一个来源不影响其它来源的注册', async () => {
    await port.register('https://a.example.com');
    await port.register('https://b.example.com');

    await port.unregister('https://a.example.com');

    expect(port.isRegistered('https://a.example.com')).toBe(false);
    expect(port.isRegistered('https://b.example.com')).toBe(true);
  });

  it('API 不可用时注销仍会清掉本地登记（避免界面谎报已启用）', async () => {
    // 先用可用 API 注册，再模拟 API 消失（扩展重载后权限被外部撤销）
    await port.register('https://example.com');
    const degraded = createContentScriptPort({ scripting: undefined });
    await degraded.unregister('https://example.com');

    expect(degraded.isRegistered('https://example.com')).toBe(false);
  });

  it('注销抛错时不冒泡', async () => {
    const failing = createContentScriptPort({
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts() {
          throw new Error('boom');
        },
      },
    });

    await expect(failing.unregister('https://example.com')).resolves.toBeTypeOf('boolean');
  });
});

describe('来源隔离（spec FR-038）', () => {
  it('每个来源独立注册与注销', async () => {
    await port.register('https://example.com');
    await port.register('https://example.com:8443');
    await port.register('https://sub.example.com');

    expect(registeredCalls).toHaveLength(3);
    await port.unregister('https://example.com');

    expect(port.isRegistered('https://example.com')).toBe(false);
    expect(port.isRegistered('https://example.com:8443')).toBe(true);
    expect(port.isRegistered('https://sub.example.com')).toBe(true);
  });
});

/**
 * 挂起防护（2026-09-30 用户实测缺陷的同类问题）。
 *
 * `scripting` 与 DNR 一样是**刚授予**的可选权限，其 API 在权限窗口期可能永不 settle。
 * 而本调用位于授权成功后的必经路径上（`permissions.apply-grant` → `syncContentScript`），
 * 挂起会让整个授权流程卡死：存储不写、响应不回、开关永久停在灰色。
 *
 * 修法与 DNR 一致：套超时，超时按失败如实降级（Tier 2 → Tier 1 不确定态）。
 */
describe('scripting 调用挂起必须被超时截断', () => {
  it('registerContentScripts 挂起时 register 在超时内返回 false', async () => {
    const hanging = createContentScriptPort({
      scripting: {
        registerContentScripts: () => new Promise<void>(() => {
          // 故意永不 settle：模拟权限窗口期挂起
        }),
        unregisterContentScripts: async () => {},
        getRegisteredContentScripts: async () => [],
      },
    });

    const start = Date.now();
    const result = await hanging.register('https://example.com');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
    expect(result).toBe(false);
    expect(hanging.isRegistered('https://example.com')).toBe(false);
  }, 15_000);

  it('unregisterContentScripts 挂起时不卡死，且本地登记已清除', async () => {
    const hanging = createContentScriptPort({
      scripting: {
        registerContentScripts: async () => {},
        unregisterContentScripts: () => new Promise<void>(() => {
          // 故意永不 settle
        }),
        getRegisteredContentScripts: async () => [],
      },
    });

    await hanging.register('https://example.com');
    expect(hanging.isRegistered('https://example.com')).toBe(true);

    const start = Date.now();
    await hanging.unregister('https://example.com');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
    // 注销失败不影响撤销授权的语义：本地登记必须已清掉，否则归属校验会误判
    expect(hanging.isRegistered('https://example.com')).toBe(false);
  }, 15_000);
});

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

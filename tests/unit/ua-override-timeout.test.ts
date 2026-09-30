// sidebarmobile — DNR 调用挂起防护测试（测试）
// 2026-09-30 | Kimi(fix) | 用户实测缺陷回归：DNR 调用挂起会卡死整条授权流程

import { describe, expect, it, vi } from 'vitest';
import { createUaOverride } from '../../src/adapters/ua-override.ts';

/**
 * 本文件锁定一个用户实测缺陷（2026-09-30）：
 *
 * 用户点「允许」后，后台日志显示 `held: true`（权限确实到手、复核通过），
 * 但**存储不写、响应不回**，开关永久卡在灰色不可点。
 *
 * 实测定位：卡在 `uaOverride.apply()` 内部的 `updateSessionRules` ——
 * 权限刚授予的窗口期它**永不 settle**（既不 resolve 也不 reject）。
 * Cookie 授权走同一条上层路径却正常，因为它不经过 DNR。
 *
 * 修法：所有 DNR 调用（注册规则 / 注销规则 / 查询规则）都套超时，
 * 超时按 rejected 如实降级 —— 宁可降级，不可卡死（FR-029）。
 */

/** 构造一个永不 settle 的 DNR 假实现 */
function createHangingDnr() {
  return {
    updateSessionRules: vi.fn(() => new Promise<void>(() => {
      // 故意永不 resolve / reject：模拟权限窗口期的挂起
    })),
    getSessionRules: vi.fn(() => new Promise<Array<{ id: number }>>(() => {
      // 同上
    })),
  };
}

/** 构造一个正常工作的 DNR 假实现 */
function createWorkingDnr() {
  const rules = new Map<number, boolean>();
  return {
    updateSessionRules: vi.fn(async (options: { removeRuleIds?: number[]; addRules?: Array<{ id: number }> }) => {
      for (const id of options.removeRuleIds ?? []) {
        rules.delete(id);
      }
      for (const rule of options.addRules ?? []) {
        rules.set(rule.id, true);
      }
    }),
    getSessionRules: vi.fn(async () => [...rules.keys()].map((id) => ({ id }))),
    /** 测试观测：当前存在的规则 id */
    ruleIds: (): number[] => [...rules.keys()],
  };
}

const ORIGIN = 'https://example.com';

describe('DNR 调用挂起必须被超时截断（用户实测缺陷回归）', () => {
  it('启用路径：updateSessionRules 挂起时 apply 在超时内返回降级，不永久等待', async () => {
    const dnr = createHangingDnr();
    const port = createUaOverride({ dnr });

    const start = Date.now();
    const result = await port.apply(ORIGIN, true);
    const elapsed = Date.now() - start;

    // 关键断言：必须在有限时间内返回（超时上限 3s，留出余量）
    expect(elapsed).toBeLessThan(10_000);
    // 如实降级，不谎报成功
    expect(result.applied).toBe(false);
    expect(result.mode).toBe('viewport');
    expect(result.reason).toBe('rejected');
  }, 15_000);

  it('关闭路径：updateSessionRules 挂起时同样不卡死', async () => {
    const dnr = createHangingDnr();
    const port = createUaOverride({ dnr });

    const result = await port.apply(ORIGIN, false);
    expect(result.applied).toBe(false);
    expect(result.mode).toBe('viewport');
  }, 15_000);

  it('查询路径：getSessionRules 挂起时 isApplied 不卡死，且不谎报已生效', async () => {
    const dnr = createHangingDnr();
    const port = createUaOverride({ dnr });

    const start = Date.now();
    const applied = await port.isApplied(ORIGIN);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
    // 查询失败时回落缓存；缓存为空 → false（宁可少报成功，不谎报 active）
    expect(applied).toBe(false);
  }, 15_000);

  it('清理路径：clearAll 挂起时也不卡死', async () => {
    const dnr = createHangingDnr();
    const port = createUaOverride({ dnr });

    // 先让缓存里有一条（apply 会失败，但 clearAll 仍需能返回）
    await port.apply(ORIGIN, true);

    const start = Date.now();
    await port.clearAll();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);
});

describe('正常路径不受超时保护影响', () => {
  it('DNR 正常时启用成功并登记规则', async () => {
    const dnr = createWorkingDnr();
    const port = createUaOverride({ dnr });

    const result = await port.apply(ORIGIN, true);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe('real-ua');
    expect(dnr.ruleIds().length).toBe(1);
  });

  it('DNR 正常时查询返回真实生效状态', async () => {
    const dnr = createWorkingDnr();
    const port = createUaOverride({ dnr });

    await port.apply(ORIGIN, true);
    expect(await port.isApplied(ORIGIN)).toBe(true);

    await port.apply(ORIGIN, false);
    expect(await port.isApplied(ORIGIN)).toBe(false);
  });

  it('DNR 不可用时立即返回 unsupported（不发请求、不等待超时）', async () => {
    const port = createUaOverride({ dnr: undefined });

    const start = Date.now();
    const result = await port.apply(ORIGIN, true);
    const elapsed = Date.now() - start;

    // 没有 API 时应立即返回，而不是等 3 秒超时
    expect(elapsed).toBeLessThan(500);
    expect(result.reason).toBe('unsupported');
  });
});

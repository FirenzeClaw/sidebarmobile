// sidebarmobile — 能力状态计算单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T031：先写失败测试（RED，FR-029，data-model §6）

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCapabilityState,
  mapUaCapability,
  type UaCapabilityInput,
} from '../../src/shared/capability-state.ts';

/**
 * 默认输入：已授权 + 权限复核通过 + 规则应用成功。
 * 各用例只改需要考察的那一项，让「一个原因 → 一个状态」的映射保持清晰。
 */
function input(overrides: Partial<UaCapabilityInput> = {}): UaCapabilityInput {
  return {
    grant: 'granted',
    permissionHeld: true,
    ruleApplied: true,
    ...overrides,
  };
}

beforeEach(() => {
  // 无共享状态；beforeEach 保留以便后续引入探测缓存时扩展
});

describe('UA 能力映射（spec FR-010/FR-029，data-model §6）', () => {
  it('未授权（never）映射为 unauthorized', () => {
    expect(mapUaCapability(input({ grant: 'never' }))).toBe('unauthorized');
  });

  it('已撤销（revoked）同样映射为 unauthorized', () => {
    expect(mapUaCapability(input({ grant: 'revoked' }))).toBe('unauthorized');
  });

  it('已授权但权限复核失败映射为 unauthorized（外部撤销后的回归，FR-030）', () => {
    // 授权标记还在，但浏览器里权限已被外部移除：必须按未授权显示，不能谎报可用
    expect(mapUaCapability(input({ grant: 'granted', permissionHeld: false }))).toBe('unauthorized');
  });

  it('已授权、权限在、规则应用成功映射为 active（真实 UA 生效）', () => {
    expect(mapUaCapability(input())).toBe('active');
  });

  it('已授权、权限在、但浏览器不支持该能力映射为 unsupported', () => {
    expect(mapUaCapability(input({ ruleSupported: false }))).toBe('unsupported');
  });

  it('已授权、权限在、规则注册失败映射为 degraded（不是 failed）', () => {
    // degraded = 已授权但浏览器/网站不支持落地；failed 留给加载失败等场景
    expect(mapUaCapability(input({ ruleApplied: false }))).toBe('degraded');
  });

  it('尚未探测时状态为 unknown', () => {
    expect(mapUaCapability({ grant: 'granted', permissionHeld: true, ruleApplied: null })).toBe('unknown');
  });

  it('未授权优先于不支持：不申请权限就不会去探测能力', () => {
    expect(mapUaCapability(input({ grant: 'never', ruleSupported: false, ruleApplied: false }))).toBe('unauthorized');
  });

  it('权限复核失败优先于规则结果：权限没了就谈不上规则生效', () => {
    expect(mapUaCapability(input({ permissionHeld: false, ruleApplied: true }))).toBe('unauthorized');
  });

  it('浏览器不支持优先于规则注册失败：先把不支持说清楚', () => {
    expect(mapUaCapability(input({ ruleSupported: false, ruleApplied: false }))).toBe('unsupported');
  });
});

describe('能力状态集合（data-model §6）', () => {
  it('初始状态保守：UA/Cookie 未探测、导航不确定、嵌入未知', () => {
    expect(createCapabilityState()).toEqual({
      ua: 'unauthorized',
      cookie: 'unauthorized',
      navigation: 'uncertain',
      embed: 'unknown',
    });
  });

  it('显式传入的取值覆盖默认', () => {
    const state = createCapabilityState({
      ua: input(),
      cookie: { grant: 'granted', permissionHeld: true },
      navigation: 'tracked',
      embed: 'ok',
    });

    expect(state.ua).toBe('active');
    // 已授权 + 权限在：本切片只做存在性检测，故为 available
    expect(state.cookie).toBe('available');
    expect(state.navigation).toBe('tracked');
    expect(state.embed).toBe('ok');
  });

  it('Cookie 未授权映射为 unauthorized（与 UA 独立，FR-009/FR-011）', () => {
    const state = createCapabilityState({ cookie: { grant: 'never', permissionHeld: false } });
    expect(state.cookie).toBe('unauthorized');
  });

  it('Cookie 已授权但权限复核失败映射为 unauthorized', () => {
    const state = createCapabilityState({ cookie: { grant: 'granted', permissionHeld: false } });
    expect(state.cookie).toBe('unauthorized');
  });

  it('Cookie 已授权且权限在、浏览器不支持 cookies API 时映射为 limited', () => {
    const state = createCapabilityState({ cookie: { grant: 'granted', permissionHeld: true, apiSupported: false } });
    expect(state.cookie).toBe('limited');
  });

  it('UA 与 Cookie 的状态互不影响', () => {
    const state = createCapabilityState({
      ua: input({ grant: 'never' }),
      cookie: { grant: 'granted', permissionHeld: true },
    });

    expect(state.ua).toBe('unauthorized');
    expect(state.cookie).toBe('available');
  });
});

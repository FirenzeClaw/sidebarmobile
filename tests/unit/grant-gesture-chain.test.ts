// sidebarmobile — 授权申请手势链单测（测试）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：先写失败测试（RED）——权限申请必须由侧栏在手势链内发起

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PermissionOutcome, PermissionsPort } from '../../src/adapters/permissions.ts';
import { createCapabilityState } from '../../src/shared/capability-state.ts';
import { permissionSpecFor } from '../../src/shared/permission-spec.ts';
import {
  requestGrantInGestureChain,
  type GrantApplyRequest,
  type GrantResponseShape,
} from '../../src/sidebar/state/grant-request.ts';
import { noticeForOutcome, uaToggleStateFor } from '../../src/sidebar/components/site-settings.ts';

const ORIGIN = 'https://example.com';
const ORIGIN_PATTERN = 'https://example.com/*';

/**
 * 本文件锁定一次**用户实测反馈**的缺陷（开关点不动）：
 *
 * `permissions.request()` 原先在后台（Service Worker）里调用，而 Chrome 硬性要求该 API
 * 必须在**用户手势的直接调用链**中执行。侧栏点击开关 → 消息 → 后台 → 申请，此时手势已丢，
 * Chromium 抛出「This function must be called during a user gesture」（Chromium 153 实测），
 * 该错误被适配层映射为 denied，用户看到的是"开关点不动、也不弹权限对话框"。
 *
 * 因此这里锁两件事：
 *   1. **调用位置**：`permissions.request` 只允许出现在侧栏的 `grant-request` 模块里，
 *      后台不得再持有该调用点（结构性断言 —— 加一处后台调用不会让任何既有测试失败）；
 *   2. **调用时序**：申请权限必须是点击后的第一个动作，不得被任何 `await` 推后
 *      （手势活性有时间窗，先 await 一条消息再申请就等于把缺陷原样搬回来），
 *      且必须**先**拿到浏览器结论、**再**通知后台执行副作用。
 */

/** 记录调用轨迹的替身：把"谁先谁后"变成可断言的序列 */
function createScriptedPort(outcome: PermissionOutcome, timeline: string[]): PermissionsPort {
  return {
    async request(): Promise<PermissionOutcome> {
      timeline.push('request');
      return outcome;
    },
    async contains(): Promise<boolean> {
      timeline.push('contains');
      return outcome === 'granted';
    },
    async remove() {
      timeline.push('remove');
      return 'removed';
    },
  };
}

/** 后台落地成功的响应形状（与 background 的响应信封一致） */
function grantedResponse(): GrantResponseShape {
  return { granted: true, state: createCapabilityState({ ua: { grant: 'granted', permissionHeld: true, ruleApplied: true } }) };
}

/** 后台落地的拒绝响应形状（标记已按事实修正为 revoked，能力为未授权） */
function deniedResponse(): GrantResponseShape {
  return {
    granted: false,
    reason: 'denied',
    state: createCapabilityState({ ua: { grant: 'revoked', permissionHeld: false, ruleApplied: null } }),
  };
}

let timeline: string[];
let applyRequests: GrantApplyRequest[];

beforeEach(() => {
  timeline = [];
  applyRequests = [];
});

/** 装配被测调用链：注入替身端口 + 记录型后台落地器 */
function gestureChain(outcome: PermissionOutcome, response: GrantResponseShape | null) {
  return {
    permissions: createScriptedPort(outcome, timeline),
    sendApply: async (payload: GrantApplyRequest): Promise<GrantResponseShape | null> => {
      applyRequests.push(payload);
      timeline.push('apply');
      return response;
    },
  };
}

describe('权限申请的手势链（用户实测缺陷：开关点不动）', () => {
  it('申请权限是点击后的第一个动作，不被任何 await 推后', async () => {
    const deps = gestureChain('granted', grantedResponse());

    const pending = requestGrantInGestureChain(deps, ORIGIN, 'ua');

    // 不 await：此刻权限申请必须已经发出（手势活性只在一个时间窗内有效）
    expect(timeline).toEqual(['request']);

    await pending;
  });

  it('先拿到浏览器结论，再通知后台执行副作用（顺序不可颠倒）', async () => {
    const deps = gestureChain('granted', grantedResponse());

    await requestGrantInGestureChain(deps, ORIGIN, 'ua');

    expect(timeline).toEqual(['request', 'apply']);
  });

  it('申请的是该精确来源的权限规格（与后台复核用的是同一份推导）', async () => {
    const spec = permissionSpecFor(ORIGIN, 'ua');
    const deps = gestureChain('granted', grantedResponse());
    const seen: string[][] = [];
    const spy: PermissionsPort = {
      ...deps.permissions,
      async request(requested) {
        seen.push([...requested.origins]);
        return 'granted';
      },
    };

    await requestGrantInGestureChain({ ...deps, permissions: spy }, ORIGIN, 'ua');

    expect(seen).toEqual([[ORIGIN_PATTERN]]);
    expect(spec.origins).toEqual([ORIGIN_PATTERN]);
  });

  it('把浏览器给出的真实结论原样上抛给后台（不代它下结论）', async () => {
    const deps = gestureChain('denied', deniedResponse());

    await requestGrantInGestureChain(deps, ORIGIN, 'cookie');

    expect(applyRequests).toEqual([{ originKey: ORIGIN, grant: 'cookie', outcome: 'denied' }]);
  });

  it('浏览器不支持该 API 时同样上报结论，交由后台按 unsupported 语义落地', async () => {
    const deps = gestureChain('unsupported', { granted: false, reason: 'unsupported', state: createCapabilityState() });

    const response = await requestGrantInGestureChain(deps, ORIGIN, 'ua');

    expect(applyRequests[0]?.outcome).toBe('unsupported');
    expect(response?.reason).toBe('unsupported');
  });

  it('后台不可达时返回 null，由调用方走降级路径（保持既有契约）', async () => {
    const deps = gestureChain('granted', null);

    const response = await requestGrantInGestureChain(deps, ORIGIN, 'ua');

    expect(response).toBeNull();
  });

  it('拒绝路径的用户可见语义不变：开关回弹、提示降级文案', async () => {
    const deps = gestureChain('denied', deniedResponse());

    const response = await requestGrantInGestureChain(deps, ORIGIN, 'ua');

    // 开关回弹（revoked + 非 pending → off）
    expect(uaToggleStateFor('revoked', false)).toBe('off');
    // 提示逐字为契约文案
    expect(noticeForOutcome('denied')).toBe('未授权，已使用降级模式');
    // 能力保持未授权，绝不因"点了开关"而声称可用
    expect(response?.state.ua).toBe('unauthorized');
  });
});

/**
 * 「手势缺失」与「用户拒绝」必须可区分（本次缺陷的核心区分点）。
 *
 * 缺陷版本里两者在测试中长得一模一样：都是 `request` 返回 false → 界面回弹为关。
 * 正因如此，568 项单测与全部检查点都没发现缺陷 —— 检查点当时"验证"的所谓拒绝路径，
 * 其实是浏览器在无手势时抛出的错误被适配层映射成了 denied。
 *
 * 这两者唯一可靠的区分点是**调用发生的位置与时机**：
 *   - 用户拒绝：申请在侧栏手势链内发起，浏览器真的发起了裁决并拿到用户的否定答复；
 *   - 手势缺失：申请在后台（或 await 之后）发起，浏览器根本没有发起裁决。
 *
 * 因此下面的断言不看"返回值"（两者都可能表现为 denied），而看**调用轨迹**。
 */
describe('区分「手势缺失」与「用户拒绝」（不看返回值，看调用轨迹）', () => {
  it('申请先于任何后台通信发生（手势缺失时这条断言必然不成立）', () => {
    const deps = gestureChain('denied', deniedResponse());

    const pending = requestGrantInGestureChain(deps, ORIGIN, 'ua');

    // 不 await：若申请发生在后台（或先 await 了后台），此刻轨迹会是 [] 或 ['apply']
    expect(timeline).toEqual(['request']);
    return pending;
  });

  it('侧栏原样上报浏览器结论，不用事后的权限状态覆盖它', async () => {
    /**
     * 构造"浏览器答复 denied、但 contains 事后为 true"的矛盾场景。
     *
     * 侧栏必须原样上报 denied，**不得**因为事后 contains 为 true 就自作主张改成 granted：
     * 那等于用"现在有权限"覆盖"用户当时拒绝了"，界面会在用户明确拒绝后把开关显示为开。
     * 判定权属于浏览器与后台复核，不属于侧栏的推断。
     */
    const seen: string[] = [];
    const contradictory: PermissionsPort = {
      async request() {
        seen.push('request');
        return 'denied';
      },
      async contains() {
        seen.push('contains');
        return true;
      },
      async remove() {
        seen.push('remove');
        return 'removed';
      },
    };

    await requestGrantInGestureChain(
      {
        permissions: contradictory,
        async sendApply(request: GrantApplyRequest): Promise<GrantResponseShape | null> {
          applyRequests.push(request);
          return deniedResponse();
        },
      },
      ORIGIN,
      'ua',
    );

    expect(applyRequests[0]?.outcome).toBe('denied');
    // 侧栏在申请阶段**不得**自己去 contains 复核（复核是后台的职责，见模块头注释）
    expect(seen).toEqual(['request']);
  });
});

const SRC_DIR = path.resolve(import.meta.dirname, '..', '..', 'src');

/** 递归列出 src 下的 .ts 文件（相对路径用正斜杠） */
function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(path.relative(SRC_DIR, full).replace(/\\/g, '/'));
    }
  }
  return found;
}

/** 去掉注释后再匹配，避免把"讨论 permissions.request"的说明文字当成调用 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('调用位置锁定（防止权限申请被挪回后台）', () => {
  it('全 src 只有侧栏的 grant-request 模块调用 permissions.request', () => {
    const callers = listSourceFiles(SRC_DIR).filter((relative) =>
      /permissions\.request\s*\(/.test(stripComments(readFileSync(path.join(SRC_DIR, relative), 'utf8'))),
    );

    expect(callers).toEqual(['sidebar/state/grant-request.ts']);
  });

  it('后台的任何模块都不得引用 permissions.request（手势在那里必然已丢失）', () => {
    const backgroundCallers = listSourceFiles(SRC_DIR)
      .filter((relative) => relative.startsWith('background/'))
      .filter((relative) => /permissions\.request\s*\(/.test(stripComments(readFileSync(path.join(SRC_DIR, relative), 'utf8'))));

    expect(backgroundCallers).toEqual([]);
  });
});

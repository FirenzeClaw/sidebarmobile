// sidebarmobile — 嵌入失败检测单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T049：先写失败单测（RED，FR-006，research R2/R3）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmbedDetector,
  HEARTBEAT_TIMEOUT_MS,
  type EmbedDetector,
  type EmbedSignal,
} from '../../src/sidebar/state/embed-detection.ts';

let detector: EmbedDetector;
/** 手动推进的时钟：避免测试依赖真实定时器等待 */
let clock: { advance(ms: number): void; now(): number };
let scheduled: Array<{ at: number; run: () => void }>;

function makeClock() {
  let current = 0;
  const tasks: Array<{ at: number; run: () => void }> = [];
  scheduled = tasks;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
      // 按到期顺序执行一次，模拟定时器触发
      for (const task of [...tasks].sort((a, b) => a.at - b.at)) {
        if (task.at <= current) {
          tasks.splice(tasks.indexOf(task), 1);
          task.run();
        }
      }
    },
  };
}

function makeDetector(onSignal: (signal: EmbedSignal) => void = () => undefined): EmbedDetector {
  return createEmbedDetector({
    now: () => clock.now(),
    schedule: (delayMs, run) => {
      scheduled.push({ at: clock.now() + delayMs, run });
      return () => {
        const index = scheduled.findIndex((task) => task.run === run);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      };
    },
    onSignal,
  });
}

beforeEach(() => {
  clock = makeClock();
  detector = makeDetector();
});

describe('初始态与就绪信号（research R3 Tier 1）', () => {
  it('初始状态为 unknown（未观察前不声称可嵌入）', () => {
    detector.start('tab-1', 'https://example.com/');

    expect(detector.stateOf('tab-1')).toBe('unknown');
  });

  it('iframe load 事件后进入 pending 而不是直接 ok（Chrome 对被拦截的 iframe 也发 load）', () => {
    detector.start('tab-1', 'https://example.com/');
    detector.markFrameLoaded('tab-1');

    // 关键：Tier 1 无法区分"加载成功"与"加载了错误页"，因此不能直接判 ok
    expect(detector.stateOf('tab-1')).toBe('pending');
  });

  it('显式确认失败才进入 failed（DOM error 事件在真实浏览器里不会为导航失败触发）', () => {
    detector.start('tab-1', 'https://example.com/');
    detector.markConfirmedFailure('tab-1');

    expect(detector.stateOf('tab-1')).toBe('failed');
  });

  it('未 start 的标签状态为 idle', () => {
    expect(detector.stateOf('tab-unknown')).toBe('idle');
  });
});

describe('Tier 2 心跳确认（spec FR-006/FR-020）', () => {
  it('授权站点：收到 frame.report 后判定为 ok', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');
    detector.markHeartbeat('tab-1');

    expect(detector.stateOf('tab-1')).toBe('ok');
  });

  it('授权站点：心跳超时后判定为 suspected-blocked', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');

    expect(detector.stateOf('tab-1')).toBe('pending');
    expect(signals.map((signal) => signal.kind)).toEqual(['pending']);

    clock.advance(HEARTBEAT_TIMEOUT_MS + 1);

    expect(detector.stateOf('tab-1')).toBe('suspected-blocked');
    // 最后一次信号才是降级；检查完整序列以确认没有多余的中间态
    expect(signals.map((signal) => signal.kind)).toEqual(['pending', 'suspected-blocked']);
    expect(signals[signals.length - 1]?.kind).toBe('suspected-blocked');
  });

  /**
   * 这条用例记录的是**实测事实**（T059 用真实 Chromium 逐类验证）：
   * iframe 的导航失败（DNS 不解析 / 端口关闭 / about:blank / 空 src）一律只触发 `load`，
   * 从不触发 `error` —— 浏览器在 iframe 里渲染的是它自己的错误页。
   *
   * 因此 Tier 1 **无法**检测加载失败，也就**不该**为它显示降级层；唯一诚实的表述是
   * 保持 pending（界面显示「地址可能未同步」）。若哪天有人"顺手"让 pending 也触发降级，
   * 这条用例会失败并指向这段说明。
   */
  it('Tier 1 的 pending 在任何时长后都不降级（加载失败对 Tier 1 不可观测）', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'http://nonexistent.invalid/', { expectHeartbeat: false });
    // 不可达地址在真实浏览器里也会触发 load，因此这里模拟的正是那条路径
    detector.markFrameLoaded('tab-1');
    clock.advance(HEARTBEAT_TIMEOUT_MS * 10);

    expect(detector.stateOf('tab-1')).toBe('pending');
    expect(signals.map((signal) => signal.kind)).toEqual(['pending']);
  });

  it('failed 由能给出确凿证据的上层主动标记，不靠 DOM 事件自行到达', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: false });
    detector.markFrameLoaded('tab-1');
    expect(detector.stateOf('tab-1')).toBe('pending');

    // 上层（如未来的连通性探测）给出确凿失败证据时才标记 failed
    detector.markConfirmedFailure('tab-1');

    expect(detector.stateOf('tab-1')).toBe('failed');
  });

  it('心跳在超时前到达则不触发降级信号', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');
    clock.advance(HEARTBEAT_TIMEOUT_MS - 100);
    detector.markHeartbeat('tab-1');
    clock.advance(5000);

    expect(detector.stateOf('tab-1')).toBe('ok');
    // 只应有 pending → ok；不得出现 suspected-blocked
    expect(signals.map((signal) => signal.kind)).toEqual(['pending', 'ok']);
    expect(signals.some((signal) => signal.kind === 'suspected-blocked')).toBe(false);
  });

  it('heartbeat 到达后取消挂起的超时定时器（不重复降级）', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');
    detector.markHeartbeat('tab-1');

    clock.advance(HEARTBEAT_TIMEOUT_MS * 3);

    expect(detector.stateOf('tab-1')).toBe('ok');
  });
});

describe('无授权站点（Tier 1 不猜测，spec FR-021）', () => {
  it('不期待心跳时 load 后超时不降级（无法确认不代表失败）', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: false });
    detector.markFrameLoaded('tab-1');
    clock.advance(HEARTBEAT_TIMEOUT_MS * 3);

    // 无 host 权限就无从确认；把"无法确认"说成"被拦截"是伪造状态
    expect(detector.stateOf('tab-1')).toBe('pending');
    // 只允许 pending 这一个信号，不得出现任何降级
    expect(signals.map((signal) => signal.kind)).toEqual(['pending']);
  });

  it('不期待心跳时状态不会变成 ok（不得猜测成功）', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: false });
    detector.markFrameLoaded('tab-1');
    clock.advance(1000);

    expect(detector.stateOf('tab-1')).not.toBe('ok');
  });
});

describe('重复加载与状态重置（spec FR-006 重试路径）', () => {
  it('再次 start 重置为 unknown 并取消旧超时', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });

    expect(detector.stateOf('tab-1')).toBe('unknown');

    // 旧超时已被取消，推进时钟不应把新一次加载误判为 blocked
    clock.advance(HEARTBEAT_TIMEOUT_MS + 1);
    expect(detector.stateOf('tab-1')).toBe('unknown');
  });

  it('failed 之后重新加载回到 unknown', () => {
    detector.start('tab-1', 'https://example.com/');
    detector.markConfirmedFailure('tab-1');
    expect(detector.stateOf('tab-1')).toBe('failed');

    detector.start('tab-1', 'https://example.com/');
    expect(detector.stateOf('tab-1')).toBe('unknown');
  });

  it('suspected-blocked 标记为「疑似」：不得直接说成确凿的 blocked', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');
    clock.advance(HEARTBEAT_TIMEOUT_MS + 1);

    // 心跳缺失的可能原因不止 XFO（网络慢、脚本被 CSP 挡、站点禁用第三方脚本）
    expect(detector.stateOf('tab-1')).toBe('suspected-blocked');
  });
});

describe('多标签独立（spec FR-014/FR-038）', () => {
  it('每个标签有独立的检测状态与超时', () => {
    detector.start('tab-a', 'https://a.example.com/', { expectHeartbeat: true });
    detector.start('tab-b', 'https://b.example.com/', { expectHeartbeat: false });

    detector.markFrameLoaded('tab-a');
    detector.markFrameLoaded('tab-b');
    detector.markHeartbeat('tab-a');

    expect(detector.stateOf('tab-a')).toBe('ok');
    expect(detector.stateOf('tab-b')).toBe('pending');
  });

  it('一个标签超时不改变另一个标签的状态', () => {
    detector.start('tab-a', 'https://a.example.com/', { expectHeartbeat: true });
    detector.start('tab-b', 'https://b.example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-a');
    detector.markFrameLoaded('tab-b');
    detector.markHeartbeat('tab-b');

    clock.advance(HEARTBEAT_TIMEOUT_MS + 1);

    expect(detector.stateOf('tab-a')).toBe('suspected-blocked');
    expect(detector.stateOf('tab-b')).toBe('ok');
  });

  it('dispose 清理标签的定时器与状态', () => {
    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');

    detector.dispose('tab-1');
    clock.advance(HEARTBEAT_TIMEOUT_MS * 2);

    expect(detector.stateOf('tab-1')).toBe('idle');
  });
});

describe('信号通知（供视图层驱动降级覆盖层）', () => {
  it('状态变化触发 onSignal，携带标签与加载态', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');

    expect(signals.map((signal) => signal.kind)).toEqual(['pending']);

    clock.advance(HEARTBEAT_TIMEOUT_MS + 1);
    expect(signals.map((signal) => signal.kind)).toEqual(['pending', 'suspected-blocked']);
    expect(signals[1]?.tabId).toBe('tab-1');
  });

  it('相同状态重复上报不重复发信号', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.markFrameLoaded('tab-1');
    detector.markFrameLoaded('tab-1');
    detector.markFrameLoaded('tab-1');

    expect(signals.map((signal) => signal.kind)).toEqual(['pending']);
  });

  it('dispose 后不再发信号', () => {
    const signals: EmbedSignal[] = [];
    detector = makeDetector((signal) => signals.push(signal));

    detector.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    detector.dispose('tab-1');
    detector.markFrameLoaded('tab-1');

    expect(signals).toHaveLength(0);
  });
});

describe('常量契约', () => {
  it('心跳超时窗口是合理量级（既不过短误判，也不过长让用户等）', () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
    expect(HEARTBEAT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('schedule 返回的取消函数被真正调用（避免定时器泄漏）', () => {
    const cancel = vi.fn();
    const det = createEmbedDetector({
      now: () => clock.now(),
      schedule: () => cancel,
      onSignal: () => undefined,
    });

    det.start('tab-1', 'https://example.com/', { expectHeartbeat: true });
    det.markFrameLoaded('tab-1');
    det.markHeartbeat('tab-1');

    expect(cancel).toHaveBeenCalled();
  });
});

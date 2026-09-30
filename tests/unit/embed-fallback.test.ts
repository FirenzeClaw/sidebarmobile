// sidebarmobile — 嵌入降级编排单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T052/T053：覆盖层只在确凿失败时出现，且不猜、不渲染外部 HTML

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedFallbackCoordinator, type EmbedFallbackCoordinator } from '../../src/sidebar/state/embed-fallback.ts';

/**
 * 这些用例跑在 node 环境（无 DOM），因此只验证**不依赖 DOM 的判定逻辑**：
 * 何时该显示覆盖层、原因文案是什么、状态如何随事件推进。
 * 覆盖层的实际渲染由 e2e（scripts/verify-t059.ts）在真实浏览器里验证。
 */
let coordinator: EmbedFallbackCoordinator;
let changes: Array<{ tabId: string; state: string }>;
let actionLog: string[];

beforeEach(() => {
  changes = [];
  actionLog = [];
  coordinator = createEmbedFallbackCoordinator({
    onChanged: (tabId, state) => changes.push({ tabId, state }),
    actions: {
      onRetry: () => actionLog.push('retry'),
      onOpenInCurrentTab: () => actionLog.push('current'),
      onOpenInNewTab: () => actionLog.push('new'),
      onBackHome: () => actionLog.push('home'),
    },
  });
});

describe('降级覆盖层的显示判定（spec FR-006/FR-021）', () => {
  it('初始与加载中都不显示覆盖层', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);

    expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
    expect(coordinator.stateOf('tab-1')).toBe('unknown');
  });

  it('Tier 1 加载完成后不显示覆盖层（无法确认不等于失败）', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameLoaded('tab-1');

    // 关键：Chrome 对被 XFO 拦截的 iframe 同样发 load，因此不能凭 load 判定被拦截
    expect(coordinator.stateOf('tab-1')).toBe('pending');
    expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
  });

  it('上层确认加载失败后显示覆盖层', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameConfirmedFailure('tab-1');

    expect(coordinator.stateOf('tab-1')).toBe('failed');
    expect(coordinator.shouldShowFallback('tab-1')).toBe(true);
    expect(coordinator.reasonFor('tab-1')).toContain('加载失败');
  });

  it('Tier 2 心跳确认后不显示覆盖层', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', true);
    coordinator.onFrameLoaded('tab-1');
    coordinator.onHeartbeat('tab-1');

    expect(coordinator.stateOf('tab-1')).toBe('ok');
    expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
  });

  it('心跳超时后显示覆盖层，且原因用「可能」措辞（不把疑似说成确凿）', () => {
    vi.useFakeTimers();
    try {
      coordinator.beginLoad('tab-1', 'https://example.com/', true);
      coordinator.onFrameLoaded('tab-1');
      vi.advanceTimersByTime(10_000);

      expect(coordinator.stateOf('tab-1')).toBe('suspected-blocked');
      expect(coordinator.shouldShowFallback('tab-1')).toBe(true);
      const reason = coordinator.reasonFor('tab-1');
      expect(reason).toContain('可能');
      expect(reason).toContain('嵌入');
    } finally {
      vi.useRealTimers();
    }
  });

  it('未授权来源超时不显示覆盖层（等不到心跳是必然的）', () => {
    vi.useFakeTimers();
    try {
      coordinator.beginLoad('tab-1', 'https://example.com/', false);
      coordinator.onFrameLoaded('tab-1');
      vi.advanceTimersByTime(20_000);

      expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('状态推进与通知（供视图层重绘）', () => {
  it('load 推进到 pending 并通知一次', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameLoaded('tab-1');

    expect(changes).toEqual([{ tabId: 'tab-1', state: 'pending' }]);
  });

  it('重复 load 事件不重复通知', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameLoaded('tab-1');
    coordinator.onFrameLoaded('tab-1');
    coordinator.onFrameLoaded('tab-1');

    expect(changes).toHaveLength(1);
  });

  it('心跳把状态推进到 ok 并通知', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', true);
    coordinator.onFrameLoaded('tab-1');
    coordinator.onHeartbeat('tab-1');

    expect(changes.map((entry) => entry.state)).toEqual(['pending', 'ok']);
  });

  it('多标签状态互相独立', () => {
    coordinator.beginLoad('tab-a', 'https://a.example.com/', false);
    coordinator.beginLoad('tab-b', 'https://b.example.com/', false);
    coordinator.onFrameConfirmedFailure('tab-a');

    expect(coordinator.shouldShowFallback('tab-a')).toBe(true);
    expect(coordinator.shouldShowFallback('tab-b')).toBe(false);
  });
});

describe('重试与新导航（spec FR-006 重试路径）', () => {
  it('重新 beginLoad 重置状态，覆盖层随之撤下', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameConfirmedFailure('tab-1');
    expect(coordinator.shouldShowFallback('tab-1')).toBe(true);

    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
  });

  it('dispose 清理标签，之后不再显示覆盖层', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameConfirmedFailure('tab-1');

    coordinator.dispose('tab-1');

    expect(coordinator.shouldShowFallback('tab-1')).toBe(false);
    expect(coordinator.stateOf('tab-1')).toBe('idle');
  });

  it('未 beginLoad 的标签不显示覆盖层', () => {
    expect(coordinator.shouldShowFallback('tab-unknown')).toBe(false);
  });
});

describe('原因文案（spec FR-034：只输出本地文案）', () => {
  it('文案不含任何 HTML 标记', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);
    coordinator.onFrameConfirmedFailure('tab-1');

    const reason = coordinator.reasonFor('tab-1');
    expect(reason).not.toContain('<');
    expect(reason).not.toContain('>');
    expect(reason).not.toContain('&');
  });

  it('未降级时原因为空串（调用方不必判空）', () => {
    coordinator.beginLoad('tab-1', 'https://example.com/', false);

    expect(coordinator.reasonFor('tab-1')).toBe('');
  });

  it('failed 与 suspected-blocked 的原因文案不同（用户可据此判断该做什么）', () => {
    vi.useFakeTimers();
    try {
      const failedCoordinator = createEmbedFallbackCoordinator({
        onChanged: () => undefined,
        actions: {
          onRetry: () => undefined,
          onOpenInCurrentTab: () => undefined,
          onOpenInNewTab: () => undefined,
          onBackHome: () => undefined,
        },
      });
      failedCoordinator.beginLoad('t1', 'https://example.com/', false);
      failedCoordinator.onFrameConfirmedFailure('t1');
      const failedReason = failedCoordinator.reasonFor('t1');

      coordinator.beginLoad('t2', 'https://example.com/', true);
      coordinator.onFrameLoaded('t2');
      vi.advanceTimersByTime(10_000);
      const blockedReason = coordinator.reasonFor('t2');

      expect(failedReason).not.toBe(blockedReason);
      expect(failedReason.length).toBeGreaterThan(0);
      expect(blockedReason.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

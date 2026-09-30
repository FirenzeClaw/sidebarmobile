// sidebarmobile — 不可嵌入与降级处理（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T052/T053：把嵌入检测与降级覆盖层接到浏览视图（FR-006）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：dispose 接入标签关闭路径，避免追踪资源随已关闭标签无界增长

import {
  createEmbedDetector,
  fallbackReasonFor,
  needsFallbackOverlay,
  type EmbedDetector,
} from './embed-detection.ts';
import { createFallbackOverlay, type FallbackOverlayActions } from '../views/fallback-overlay.ts';

/**
 * [DONE] iframe 边界的降级编排（研究 R2：XFO/CSP 由站点控制，扩展无法绕过）。
 *
 * 把「检测」与「呈现」合成一个可测的组件，理由与之前一致：`app.ts` 只做装配，
 * 不应承载"什么状态该显示哪个覆盖层"这类规则。
 *
 * 两条硬约束集中在这里：
 * 1. **只对 failed / suspected-blocked 显示覆盖层**。`pending` 是 Tier 1 的诚实答案
 *    （"加载已发生，结果未知"），对它显示降级层会把不确定说成失败（FR-021/FR-029）。
 * 2. **覆盖层文案全部本地生成**，绝不注入目标站点返回的 HTML（FR-034）。被拦截时本就拿不到
 *    内容；"疑似被拦截"时拿到的可能是浏览器错误页，同样不可信。
 */

export interface EmbedFallbackCoordinator {
  /** 开始跟踪某标签的加载（导航/重试时调用） */
  beginLoad(tabId: string, url: string, expectHeartbeat: boolean): void;
  /** iframe load 事件 */
  onFrameLoaded(tabId: string): void;
  /**
   * 上层确认的加载失败（不是 DOM error 事件 —— 见 embed-detection.ts 的实测结论）。
   */
  onFrameConfirmedFailure(tabId: string): void;
  /** Tier 2 心跳（frame.report 到达） */
  onHeartbeat(tabId: string): void;
  /** 关闭标签时清理 */
  dispose(tabId: string): void;
  /** 该标签当前是否需要显示降级覆盖层 */
  shouldShowFallback(tabId: string): boolean;
  /** 取该标签的降级原因文案；不需要显示时返回空串 */
  reasonFor(tabId: string): string;
  /** 该标签的当前嵌入状态（供能力徽章使用） */
  stateOf(tabId: string): ReturnType<EmbedDetector['stateOf']>;
  /**
   * 声明当前活动标签。
   *
   * 覆盖层只服务活动标签：非活动标签即便处于降级态，其 iframe 也是隐藏的，
   * 给它挂覆盖层没有意义且会串到别的标签上。切换标签时由调用方更新这里。
   */
  setActiveTab(tabId: string | null): void;
  /** 覆盖层挂载点：内容区元素（视图层装配时设置一次） */
  mountOverlay(container: HTMLElement): void;
  /** 撤下覆盖层 */
  unmountOverlay(): void;
}

export interface EmbedFallbackOptions {
  /**
   * 状态变化回调：视图层据此重绘。
   *
   * 是否等待 Tier 2 心跳由调用方在 `beginLoad` 时逐次传入（它取决于该来源当前是否已授权），
   * 因此这里不重复提供"来源是否授权"的查询 —— 同一事实两处来源会漂移。
   */
  onChanged(tabId: string, state: ReturnType<EmbedDetector['stateOf']>, url: string): void;
  /** 覆盖层四类操作 */
  actions: FallbackOverlayActions;
}

/** [DONE] 创建嵌入降级编排器 */
export function createEmbedFallbackCoordinator(options: EmbedFallbackOptions): EmbedFallbackCoordinator {
  /** url 缓存：检测器只知道状态，覆盖层与日志还需要地址 */
  const urls = new Map<string, string>();

  let overlay: ReturnType<typeof createFallbackOverlay> | null = null;
  let mountPoint: HTMLElement | null = null;
  /** 当前正在跟踪的标签：覆盖层只服务活动标签 */
  let trackedTabId: string | null = null;

  /**
   * [DONE] 按当前状态同步覆盖层的显示与内容。
   *
   * 三态收敛在一处：需要显示 → 挂上并写文案；不需要 → 撤下。这样视图层不必自己判断
   * "什么时候该显示"，避免同一规则在多处重复实现而漂移。
   */
  function syncOverlay(tabId: string): void {
    if (mountPoint === null) {
      return;
    }
    if (!needsFallbackOverlay(detector.stateOf(tabId))) {
      overlay?.element().remove();
      return;
    }
    if (overlay === null) {
      overlay = createFallbackOverlay(options.actions);
    }
    overlay.render({ reason: fallbackReasonFor(detector.stateOf(tabId)), url: urls.get(tabId) ?? '' });
    if (!mountPoint.contains(overlay.element())) {
      mountPoint.append(overlay.element());
    }
  }

  const detector = createEmbedDetector({
    now: () => Date.now(),
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    onSignal: (signal) => {
      urls.set(signal.tabId, signal.url);
      // 非活动标签的状态变化只通知视图层（切过去时再同步覆盖层）
      if (signal.tabId === trackedTabId) {
        syncOverlay(signal.tabId);
      }
      options.onChanged(signal.tabId, signal.kind, signal.url);
    },
  });

  return {
    beginLoad(tabId: string, url: string, expectHeartbeat: boolean): void {
      urls.set(tabId, url);
      detector.start(tabId, url, { expectHeartbeat });
    },

    onFrameLoaded(tabId: string): void {
      detector.markFrameLoaded(tabId);
    },

    onFrameConfirmedFailure(tabId: string): void {
      detector.markConfirmedFailure(tabId);
    },

    onHeartbeat(tabId: string): void {
      detector.markHeartbeat(tabId);
    },

    dispose(tabId: string): void {
      urls.delete(tabId);
      detector.dispose(tabId);
      if (trackedTabId === tabId) {
        trackedTabId = null;
        overlay?.element().remove();
        overlay = null;
      }
    },

    shouldShowFallback(tabId: string): boolean {
      return needsFallbackOverlay(detector.stateOf(tabId));
    },

    reasonFor(tabId: string): string {
      return fallbackReasonFor(detector.stateOf(tabId));
    },

    stateOf(tabId: string) {
      return detector.stateOf(tabId);
    },

    setActiveTab(tabId: string | null): void {
      trackedTabId = tabId;
      if (tabId === null) {
        overlay?.element().remove();
        return;
      }
      syncOverlay(tabId);
    },

    /** [DONE] 覆盖层挂载点：内容区元素（视图层装配时设置一次） */
    mountOverlay(container: HTMLElement): void {
      mountPoint = container;
    },

    unmountOverlay(): void {
      overlay?.element().remove();
      overlay = null;
    },
  };
}

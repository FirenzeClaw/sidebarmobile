// sidebarmobile — 嵌入失败检测（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T052：实现以通过 T049（FR-006，research R2/R3）

/**
 * [DONE] iframe 嵌入状态的启发式检测（research R3 的 Tier 1 / Tier 2 分工在此收口）。
 *
 * 为什么需要启发式而不是一个确定的判定：`X-Frame-Options` / CSP `frame-ancestors` 由目标站点
 * 控制，浏览器**不会**给扩展任何"这帧被拦了"的事件。更麻烦的是 Chrome 对被拦截的 iframe
 * 同样会触发 `load` 事件（加载的是浏览器的错误页），因此：
 *
 * - **Tier 1（无 host 权限）**：`load` 只能证明"发生了一次加载"，不能证明"加载成功"。
 *   因此 load 后进入 `pending` —— 后续既不升 `ok` 也不降级，界面沿用「可能未同步」的不确定态。
 *   把 pending 说成 ok 是伪造成功，说成 blocked 是伪造失败，两者都违反 spec FR-021/FR-029。
 * - **Tier 2（已授权来源）**：content script 会在真实加载成功的页面里回报心跳。
 *   收到心跳 → `ok`（确凿证据）；超时未收到 → `suspected-blocked`
 *   （用"疑似"而不用"确凿"：心跳缺失也可能是网络慢、站点禁用第三方脚本、CSP 挡了注入）。
 *
 * **关于 `error` 事件的实测结论（T059 用真实 Chromium 逐类验证）**：iframe 的导航失败
 * —— DNS 不解析、端口关闭、`about:blank`、空 `src` —— **一律只触发 `load`，从不触发 `error`**。
 * 因为浏览器在 iframe 里渲染的是它自己的错误页，对宿主而言那就是一次"加载完成"。
 * 只有"元素本身加载失败"（如非法协议）才不触发任何事件。
 *
 * 这条事实有两个直接后果，代码必须照此设计，不能凭直觉假设有 error 可用：
 *   1. **Tier 1 无法检测页面加载失败**。因此 Tier 1 下不为任何失败显示降级层，
 *      只如实标「地址可能未同步」—— 这是唯一诚实的表述（FR-021）。
 *   2. `failed` 状态因此**不是**由 DOM 事件驱动，而是留给能给出确凿失败证据的上层
 *      （例如未来拿到 host 权限后的 `webNavigation`、或显式的连通性探测）主动标记。
 *      本切片保留该状态与对应的降级呈现，但不假装 Tier 1 能自行到达它。
 */

/** 检测状态。`pending` 是 Tier 1 的诚实答案：加载已发生，结果未知 */
export type EmbedState = 'idle' | 'unknown' | 'pending' | 'ok' | 'suspected-blocked' | 'failed';

/** 状态变化信号：视图层据此决定是否显示降级覆盖层 */
export interface EmbedSignal {
  tabId: string;
  kind: EmbedState;
  url: string;
}

/**
 * 心跳等待窗口。
 *
 * 取值权衡：太短会把慢速站点误判为被拦截（用户看到无谓的降级层）；太长会让真正被拦截的站点
 * 长时间白屏。4 秒约等于"文档已就绪后的正常回报延迟"上界，且短于用户的耐心阈值。
 */
export const HEARTBEAT_TIMEOUT_MS = 4000;

export interface EmbedDetectorOptions {
  now(): number;
  /** 定时器抽象：返回取消函数 */
  schedule(delayMs: number, run: () => void): () => void;
  onSignal(signal: EmbedSignal): void;
}

export interface EmbedStartOptions {
  /**
   * 是否期待 Tier 2 心跳（该来源已授权并有 content script）。
   *
   * 这是检测里唯一由外部决定的输入：无授权就不该等心跳，也不该因等不到而降级。
   */
  expectHeartbeat: boolean;
}

export interface EmbedDetector {
  /**
   * 开始跟踪一个标签的加载（导航或重试时调用，会重置旧状态）。
   *
   * `options` 省略时按 **Tier 1** 处理（不等心跳）—— 这是安全默认：无 host 权限时不期待心跳，
   * 也就不会因为等不到心跳而误报「疑似被拦截」。
   */
  start(tabId: string, url: string, options?: EmbedStartOptions): void;
  /** iframe load 事件（注意：加载失败也会触发它，见文件头实测结论） */
  markFrameLoaded(tabId: string): void;
  /**
   * 由能给出**确凿失败证据**的上层标记失败。
   *
   * 不能叫 `markFrameError`：实测表明 iframe 的导航失败不会触发 DOM `error` 事件，
   * 这个名字会误导后来者以为存在这样一条事件通路。调用方目前是空的 ——
   * Tier 1 无法自行判定失败，留给未来具备 host 权限或连通性探测能力的路径使用。
   */
  markConfirmedFailure(tabId: string): void;
  /** Tier 2 content script 心跳（frame.report 到达时调用） */
  markHeartbeat(tabId: string): void;
  stateOf(tabId: string): EmbedState;
  /** 停止跟踪并清理定时器（关闭标签时调用） */
  dispose(tabId: string): void;
}

interface TrackedFrame {
  url: string;
  state: EmbedState;
  expectHeartbeat: boolean;
  cancelTimeout: (() => void) | null;
}

/** [DONE] 创建嵌入检测器 */
export function createEmbedDetector(options: EmbedDetectorOptions): EmbedDetector {
  const frames = new Map<string, TrackedFrame>();

  /** [DONE] 状态推进并通知；相同状态不重复通知（避免视图反复重绘） */
  function transition(tabId: string, next: EmbedState): void {
    const frame = frames.get(tabId);
    if (frame === undefined || frame.state === next) {
      return;
    }
    frame.state = next;
    options.onSignal({ tabId, kind: next, url: frame.url });
  }

  /** [DONE] 取消并清空挂起的超时，防止重复降级与定时器泄漏 */
  function clearTimeoutOf(frame: TrackedFrame): void {
    if (frame.cancelTimeout !== null) {
      frame.cancelTimeout();
      frame.cancelTimeout = null;
    }
  }

  return {
    start(tabId: string, url: string, startOptions?: EmbedStartOptions): void {
      const existing = frames.get(tabId);
      if (existing !== undefined) {
        // 重试/新导航：先撤掉旧的等待，否则旧超时会把新一次加载误判为被拦截
        clearTimeoutOf(existing);
      }

      const frame: TrackedFrame = {
        url,
        state: 'unknown',
        // 默认不等心跳：等价于"该来源未授权"，是不做任何猜测的安全姿态
        expectHeartbeat: startOptions?.expectHeartbeat === true,
        cancelTimeout: null,
      };
      frames.set(tabId, frame);
      // 首次进入 unknown 不通知：调用方刚发起加载，还没有新信息可给
    },

    markFrameLoaded(tabId: string): void {
      const frame = frames.get(tabId);
      if (frame === undefined) {
        return;
      }

      transition(tabId, 'pending');

      // 只有已授权来源才等心跳：无授权时等不到是必然的，据此降级就是伪造状态
      if (!frame.expectHeartbeat) {
        return;
      }

      clearTimeoutOf(frame);
      frame.cancelTimeout = options.schedule(HEARTBEAT_TIMEOUT_MS, () => {
        const current = frames.get(tabId);
        // 回调触发时状态可能已因心跳或重试改变，只在仍等待时降级
        if (current !== undefined && current.state === 'pending') {
          current.cancelTimeout = null;
          transition(tabId, 'suspected-blocked');
        }
      });
    },

    markConfirmedFailure(tabId: string): void {
      const frame = frames.get(tabId);
      if (frame === undefined) {
        return;
      }
      clearTimeoutOf(frame);
      transition(tabId, 'failed');
    },

    markHeartbeat(tabId: string): void {
      const frame = frames.get(tabId);
      if (frame === undefined) {
        return;
      }
      // 心跳是确凿证据：content script 只在真实加载成功的文档里运行
      clearTimeoutOf(frame);
      transition(tabId, 'ok');
    },

    stateOf(tabId: string): EmbedState {
      return frames.get(tabId)?.state ?? 'idle';
    },

    dispose(tabId: string): void {
      const frame = frames.get(tabId);
      if (frame === undefined) {
        return;
      }
      clearTimeoutOf(frame);
      frames.delete(tabId);
    },
  };
}

/** [DONE] 嵌入状态到「是否需要显示降级覆盖层」的判定（集中一处，避免各处自行解释） */
export function needsFallbackOverlay(state: EmbedState): boolean {
  return state === 'failed' || state === 'suspected-blocked';
}

/** [DONE] 降级覆盖层的原因文案（面向用户，不含技术细节与堆栈） */
export function fallbackReasonFor(state: EmbedState): string {
  if (state === 'failed') {
    return '页面加载失败，可能是网络不可达或站点拒绝了连接。';
  }
  if (state === 'suspected-blocked') {
    return '该网站可能禁止在侧栏的嵌入框架中显示，请在浏览器标签页中打开。';
  }
  return '';
}

// sidebarmobile — 降级覆盖层（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T053：不可嵌入时的侧栏内降级（FR-006/FR-034）

import { createElement, truncateForLabel } from '../components/dom.ts';
import { createIcon } from '../components/icons.ts';

/**
 * [DONE] 降级覆盖层（contracts/ui-states.md §降级覆盖层）。
 *
 * 四类操作固定为：重试 / 在当前标签页打开 / 在新标签页打开 / 返回主页。
 * 「在当前/新标签页打开」是对 XFO/CSP 拦截的唯一真正出路 —— 嵌入被站点明确禁止时，
 * 扩展无法绕过（research R2），因此降级路径必须始终可见，而不是一个"再试试"的死循环。
 *
 * 安全约束（FR-034）：覆盖层**只渲染本地文案**。目标站点返回的任何 HTML 都不进入这里 ——
 * 被拦截时我们根本拿不到它的内容，而"疑似被拦截"时拿到的也可能是错误页，两者都不该被信任。
 * URL 以纯文本形式展示（textContent），无需担心标记注入。
 */

export interface FallbackOverlayActions {
  onRetry(): void;
  onOpenInCurrentTab(): void;
  onOpenInNewTab(): void;
  onBackHome(): void;
}

export interface FallbackOverlayInput {
  /** 一句话原因（本地固定文案，来自 fallbackReasonFor） */
  reason: string;
  /** 目标 URL，纯文本展示 */
  url: string;
}

export interface FallbackOverlay {
  element(): HTMLElement;
  /** 用新的原因/地址重绘 */
  render(input: FallbackOverlayInput): void;
}

/** [DONE] 创建降级覆盖层 */
export function createFallbackOverlay(actions: FallbackOverlayActions): FallbackOverlay {
  const root = createElement('div', { class: 'fallback-cover', role: 'alert' });

  /** [DONE] 构建一个操作按钮 */
  function buildAction(label: string, styleClass: string, action: () => void): HTMLButtonElement {
    const button = createElement('button', { class: `btn ${styleClass}`, type: 'button', text: label });
    button.addEventListener('click', action);
    return button;
  }

  return {
    element(): HTMLElement {
      return root;
    },

    render(input: FallbackOverlayInput): void {
      while (root.firstChild !== null) {
        root.removeChild(root.firstChild);
      }

      root.append(
        createElement('div', { class: 'fallback-icon', 'aria-hidden': 'true' }, createIcon('warning')),
        createElement('h2', { class: 'fallback-title', text: '该网站无法在侧栏内显示' }),
        createElement('p', { class: 'fallback-desc', text: input.reason }),
        createElement('p', {
          class: 'fallback-url',
          text: truncateForLabel(input.url, 120),
          title: input.url,
        }),
        createElement(
          'div',
          { class: 'fallback-actions' },
          buildAction('重试', 'btn-primary', actions.onRetry),
          buildAction('在当前标签页打开', 'btn-tonal', actions.onOpenInCurrentTab),
          buildAction('在新标签页打开', 'btn-tonal', actions.onOpenInNewTab),
          buildAction('返回主页', 'btn-ghost', actions.onBackHome),
        ),
      );
    },
  };
}

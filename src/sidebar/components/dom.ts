// sidebarmobile — DOM 构建辅助（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T025：以 textContent 为唯一文本入口的元素工厂

/**
 * [DONE] 极简 DOM 构建辅助。
 *
 * 安全契约：本文件是全侧栏唯一的元素创建入口，`text` 属性一律走 textContent，
 * 不存在任何 innerHTML 赋值路径，因此外部文本（标题/URL/错误说明）无法变成可执行标记
 * （spec FR-034）。
 */

/** 元素属性集合：`text` 走 textContent，`class` 走 className，其余走 setAttribute */
export interface ElementAttributes {
  class?: string;
  text?: string;
  /** 事件监听：键为事件名（如 click），值为处理函数 */
  on?: Record<string, EventListener>;
  /** 其余属性；值为 null/undefined/false 时跳过，true 设为空属性 */
  [attribute: string]: string | boolean | number | null | undefined | Record<string, EventListener>;
}

/** [DONE] 创建元素并应用属性与子节点 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes?: ElementAttributes,
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (attributes !== undefined) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      if (key === 'text') {
        element.textContent = String(value);
        continue;
      }
      if (key === 'class') {
        element.className = String(value);
        continue;
      }
      if (key === 'on' && typeof value === 'object') {
        for (const [eventName, listener] of Object.entries(value)) {
          element.addEventListener(eventName, listener);
        }
        continue;
      }
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    element.append(child);
  }

  return element;
}

/** [DONE] 清空元素的全部子节点 */
export function clearElement(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

/** [DONE] 必需的静态挂载点查询：缺失即抛出（HTML 骨架被破坏属编程错误，不静默降级） */
export function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`侧栏骨架缺少必需元素：#${id}`);
  }
  return element as T;
}

/**
 * [DONE] 生成一个可安全用于 aria-label 的短文本。
 *
 * 用途：把可能极长的标题/URL 放进可访问名称时截断，避免读屏器逐字朗读整段 URL。
 */
export function truncateForLabel(text: string, limit = 60): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}

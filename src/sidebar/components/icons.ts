// sidebarmobile — 内联图标（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T025：线性图标集，用 DOM API 构建以彻底避开 innerHTML

/**
 * [DONE] 侧栏图标集（统一 24×24 线性风格，stroke=currentColor）。
 *
 * 安全取向：图标用 createElementNS + setAttribute 构建，而不是 innerHTML 注入 SVG 字符串。
 * 这样整个侧栏代码库里不存在任何 innerHTML 调用点，外部文本（标题/URL）只能走 textContent
 * （spec FR-034，宪法「输出编码防 XSS」）。
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type IconPrimitive =
  | { kind: 'path'; d: string; filled?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; filled?: boolean }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number };

/** 图标名全集；新增图标必须同时在此登记，避免拼写错误静默产出空图标 */
export type IconName =
  | 'globe'
  | 'theme'
  | 'back'
  | 'forward'
  | 'home'
  | 'menu'
  | 'close'
  | 'refresh'
  | 'copy'
  | 'external'
  | 'edit'
  | 'trash'
  | 'more'
  | 'plus'
  | 'grid'
  | 'warning'
  | 'moon'
  | 'sun'
  | 'history'
  | 'share'
  | 'bookmark'
  | 'devices'
  | 'shield';

const ICONS: Record<IconName, readonly IconPrimitive[]> = {
  globe: [
    { kind: 'circle', cx: 12, cy: 12, r: 8.5 },
    { kind: 'path', d: 'M3.5 12h17M12 3.5c2.8 2.4 4 5.3 4 8.5s-1.2 6.1-4 8.5c-2.8-2.4-4-5.3-4-8.5s1.2-6.1 4-8.5z' },
  ],
  theme: [
    { kind: 'circle', cx: 12, cy: 12, r: 9 },
    { kind: 'path', d: 'M12 3a9 9 0 0 1 0 18z', filled: true },
  ],
  back: [{ kind: 'path', d: 'M14.5 5.5 8 12l6.5 6.5' }],
  forward: [{ kind: 'path', d: 'M9.5 5.5 16 12l-6.5 6.5' }],
  home: [{ kind: 'path', d: 'M4 11.5 12 4.5l8 7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z' }],
  menu: [
    { kind: 'line', x1: 4, y1: 7, x2: 20, y2: 7 },
    { kind: 'line', x1: 4, y1: 12, x2: 20, y2: 12 },
    { kind: 'line', x1: 4, y1: 17, x2: 20, y2: 17 },
  ],
  close: [
    { kind: 'line', x1: 6, y1: 6, x2: 18, y2: 18 },
    { kind: 'line', x1: 18, y1: 6, x2: 6, y2: 18 },
  ],
  refresh: [
    { kind: 'path', d: 'M20 12a8 8 0 1 1-2.4-5.7' },
    { kind: 'path', d: 'M20 3.5v5h-5' },
  ],
  copy: [
    { kind: 'rect', x: 9, y: 9, width: 11, height: 11, rx: 2 },
    { kind: 'path', d: 'M5 15V6a2 2 0 0 1 2-2h9' },
  ],
  external: [
    { kind: 'path', d: 'M14 4h6v6' },
    { kind: 'path', d: 'M20 4 11 13' },
    { kind: 'path', d: 'M19 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V8a1.5 1.5 0 0 1 1.5-1.5H11' },
  ],
  edit: [
    { kind: 'path', d: 'M4 20h4.5L20 8.5a2.12 2.12 0 0 0-3-3L5.5 17z' },
    { kind: 'path', d: 'M14.5 7 17 9.5' },
  ],
  trash: [
    { kind: 'path', d: 'M4 7h16' },
    { kind: 'path', d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' },
    { kind: 'path', d: 'M6.5 7l1 13h9l1-13' },
    { kind: 'line', x1: 10, y1: 11, x2: 10, y2: 17 },
    { kind: 'line', x1: 14, y1: 11, x2: 14, y2: 17 },
  ],
  more: [
    { kind: 'circle', cx: 12, cy: 5.5, r: 1.4, filled: true },
    { kind: 'circle', cx: 12, cy: 12, r: 1.4, filled: true },
    { kind: 'circle', cx: 12, cy: 18.5, r: 1.4, filled: true },
  ],
  plus: [
    { kind: 'line', x1: 12, y1: 5, x2: 12, y2: 19 },
    { kind: 'line', x1: 5, y1: 12, x2: 19, y2: 12 },
  ],
  grid: [
    { kind: 'rect', x: 4.5, y: 4.5, width: 6.5, height: 6.5, rx: 1.5 },
    { kind: 'rect', x: 13, y: 4.5, width: 6.5, height: 6.5, rx: 1.5 },
    { kind: 'rect', x: 4.5, y: 13, width: 6.5, height: 6.5, rx: 1.5 },
    { kind: 'rect', x: 13, y: 13, width: 6.5, height: 6.5, rx: 1.5 },
  ],
  warning: [
    { kind: 'path', d: 'M12 4 21 19.5H3z' },
    { kind: 'line', x1: 12, y1: 10, x2: 12, y2: 14.5 },
    { kind: 'circle', cx: 12, cy: 17, r: 0.9, filled: true },
  ],
  moon: [{ kind: 'path', d: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z' }],
  history: [
    { kind: 'path', d: 'M4.5 12a7.5 7.5 0 1 1 2.2 5.3' },
    { kind: 'path', d: 'M4 12.5V17h4.5' },
    { kind: 'path', d: 'M12 8v4.5l3 1.8' },
  ],
  share: [
    { kind: 'circle', cx: 6, cy: 12, r: 2.5 },
    { kind: 'circle', cx: 17, cy: 5.5, r: 2.5 },
    { kind: 'circle', cx: 17, cy: 18.5, r: 2.5 },
    { kind: 'path', d: 'M8.3 10.8 14.8 6.7M8.3 13.2l6.5 4.1' },
  ],
  bookmark: [{ kind: 'path', d: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z' }],
  devices: [
    { kind: 'rect', x: 2.5, y: 5, width: 14, height: 10, rx: 1.5 },
    { kind: 'path', d: 'M6 19h8' },
    { kind: 'rect', x: 16.5, y: 9.5, width: 5, height: 9.5, rx: 1.2 },
  ],
  shield: [{ kind: 'path', d: 'M12 3l7.5 3v5.5c0 4.6-3 8-7.5 9.5-4.5-1.5-7.5-4.9-7.5-9.5V6z' }],
  sun: [
    { kind: 'circle', cx: 12, cy: 12, r: 4.2 },
    { kind: 'line', x1: 12, y1: 2.5, x2: 12, y2: 5 },
    { kind: 'line', x1: 12, y1: 19, x2: 12, y2: 21.5 },
    { kind: 'line', x1: 2.5, y1: 12, x2: 5, y2: 12 },
    { kind: 'line', x1: 19, y1: 12, x2: 21.5, y2: 12 },
    { kind: 'line', x1: 4.8, y1: 4.8, x2: 6.6, y2: 6.6 },
    { kind: 'line', x1: 17.4, y1: 17.4, x2: 19.2, y2: 19.2 },
    { kind: 'line', x1: 4.8, y1: 19.2, x2: 6.6, y2: 17.4 },
    { kind: 'line', x1: 17.4, y1: 6.6, x2: 19.2, y2: 4.8 },
  ],
};

/** [DONE] 构建一个图标 SVG 元素；装饰性图标默认 aria-hidden */
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const primitive of ICONS[name]) {
    const filled = primitive.kind === 'path' || primitive.kind === 'circle' ? primitive.filled === true : false;
    svg.append(buildPrimitive(primitive, filled));
  }
  return svg;
}

/** [DONE] 按图元类型构建 SVG 子节点 */
function buildPrimitive(primitive: IconPrimitive, filled: boolean): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, primitive.kind);
  element.setAttribute('fill', filled ? 'currentColor' : 'none');

  if (!filled) {
    element.setAttribute('stroke', 'currentColor');
    element.setAttribute('stroke-width', '1.8');
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
  }

  switch (primitive.kind) {
    case 'path': {
      element.setAttribute('d', primitive.d);
      break;
    }
    case 'circle': {
      element.setAttribute('cx', String(primitive.cx));
      element.setAttribute('cy', String(primitive.cy));
      element.setAttribute('r', String(primitive.r));
      break;
    }
    case 'line': {
      element.setAttribute('x1', String(primitive.x1));
      element.setAttribute('y1', String(primitive.y1));
      element.setAttribute('x2', String(primitive.x2));
      element.setAttribute('y2', String(primitive.y2));
      break;
    }
    case 'rect': {
      element.setAttribute('x', String(primitive.x));
      element.setAttribute('y', String(primitive.y));
      element.setAttribute('width', String(primitive.width));
      element.setAttribute('height', String(primitive.height));
      element.setAttribute('rx', String(primitive.rx));
      break;
    }
  }

  return element;
}

/** [DONE] 清空元素并放入一个图标（替代 innerHTML 的图标替换路径） */
export function replaceWithIcon(container: Element, name: IconName): void {
  while (container.firstChild !== null) {
    container.removeChild(container.firstChild);
  }
  container.append(createIcon(name));
}

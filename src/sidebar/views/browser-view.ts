// sidebarmobile — 网页浏览视图（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T026：每标签一个 iframe 宿主、单视图切换、内容占满（FR-006/FR-025）

import { createElement, requireElement, truncateForLabel } from '../components/dom.ts';
import type { BrowserTab, DisplayMode } from '../../shared/types.ts';

/**
 * [DONE] 视图 B：网页浏览。
 *
 * iframe 宿主策略（spec FR-025 + research R3）：
 * - **每个标签一个 iframe 实例**，按 tabId 缓存在 DOM 里，切换标签只是显隐切换，
 *   因此每个标签的页面状态（滚动位置、表单、SPA 内部状态）在标签切换间不会丢失；
 * - 宿主容器尺寸恒定，切换活动标签不触发重排（iframe 重排会引起目标站点重新布局）；
 * - 关闭标签时移除对应 iframe，避免已关闭页面的脚本继续占用资源。
 *
 * **移动视口默认（spec FR-007）**：iframe 宽度就取容器宽度（侧栏约 360px），
 * 目标站点因此按移动断点排版 —— 这是纯 CSS 层面的视口适配，**不是真实移动 UA**。
 * 界面文案必须区分两者（FR-029/SC-005），本模块只负责实现视口，不宣称 UA 能力。
 *
 * 桌面模式用"按桌面断点排版后整体缩放"实现：iframe 定宽 DESKTOP_VIEWPORT_WIDTH 再
 * `transform: scale(容器宽 / 1280)`，使站点以桌面多栏版面渲染后适配侧栏宽度。
 * 若只把 iframe 拉宽到容器宽，站点仍会按窄屏断点渲染 —— 那还是移动视口，不算桌面模式。
 *
 * Tier 1 追踪边界：侧栏页没有 host 权限，无法读取跨源 iframe 的 URL/标题，
 * 因此这里只在 load 事件上报告「加载完成」。Tier 2 的上报由 `content/frame-reporter.ts`
 * 经 runtime 消息送达侧栏（该消息会到达所有扩展上下文，后台无需转发）。
 *
 * 降级覆盖层由 `state/embed-fallback.ts` 负责（T053 拆出为独立模块）：
 * 视图只报告加载事件，不判断"该不该降级"，也不渲染覆盖层 —— 那条规则集中在协调器里，
 * 避免视图与状态层各写一份而漂移。
 */

export interface BrowserViewHandlers {
  /**
   * iframe 触发 load（Tier 1 唯一可观测的事件）。
   *
   * 注意：**加载失败也会触发它**。实测（T059）表明 DNS 失败 / 端口关闭 / about:blank /
   * 空 src 一律只发 load —— 浏览器在 iframe 内渲染自己的错误页，对宿主而言就是"加载完成"。
   * 因此不要试图在这里区分成功与失败，那需要 Tier 2 证据（见 embed-detection.ts）。
   */
  onFrameLoad(tabId: string): void;
}

/** 每次同步标签时提供的显示模式解析器 */
export type DisplayModeResolver = (tab: BrowserTab) => DisplayMode;

/**
 * 桌面模式的版面宽度（CSS px）。
 *
 * 取值理由：1280 是现代桌面站点的常见断点下限（多数站点在 ≥1200px 时切到桌面多栏版面）。
 * 宽度写死后由 `transform: scale()` 缩放到侧栏宽度，页面因此**按桌面断点排版**，
 * 而不是"被塞进窄栏后触发响应式收缩"——后者恰恰是移动视口，不能拿来当桌面模式。
 */
export const DESKTOP_VIEWPORT_WIDTH = 1280;

export interface BrowserView {
  /** 按标签集合同步 iframe 宿主：新增的创建、消失的移除、其余保留 */
  syncTabs(tabs: readonly BrowserTab[], modeOf: DisplayModeResolver): void;
  /** 只显示指定标签的宿主（null 表示无活动标签） */
  showTab(tabId: string | null): void;
  /**
   * 让某标签的 iframe 载入指定地址（扩展主动发起的导航：后退/前进/重试/模式切换）。
   */
  loadTab(tabId: string, url: string): void;
  /**
   * 承认 iframe 已经在某地址上（Tier 2 上报的 SPA 导航）。
   *
   * **必须与 loadTab 区分开**：`pushState` 型导航里页面**已经**在新地址上了，
   * 我们只需把标签状态对齐，而**绝不能**再赋一次 `src` —— 那会触发整页重新加载，
   * 把站点刚做的 SPA 状态（组件树、滚动位置、未提交的表单）全部丢掉，
   * 恰好摧毁了 pushState 存在的意义（spec FR-020 要的是追踪变化，不是重载页面）。
   */
  adoptTabUrl(tabId: string, url: string): void;
  /** 播放一次重载微光（活动标签） */
  flashReload(): void;
  /** 内容区元素：降级覆盖层的挂载点（由 app.ts 交给协调器） */
  contentElement(): HTMLElement;
}

const CONTENT_ID = 'browserContent';

/** [DONE] 创建浏览视图 */
export function createBrowserView(handlers: BrowserViewHandlers): BrowserView {
  const container = requireElement(CONTENT_ID);
  /** tabId → iframe 宿主 */
  const hosts = new Map<string, HTMLDivElement>();
  /** tabId → 最近一次写入 iframe 的地址，避免同址重复赋值触发无意义重载 */
  const loadedUrls = new Map<string, string>();
  /** tabId → 已应用的显示模式，避免同值重复设置样式引发无意义重排 */
  const appliedModes = new Map<string, DisplayMode>();

  /** [DONE] 构建一个标签的 iframe 宿主 */
  function createHost(tab: BrowserTab): HTMLDivElement {
    const host = createElement('div', { class: 'tab-host', 'data-tab-id': tab.tabId, hidden: true });

    const frame = createElement('iframe', {
      title: `网页内容：${truncateForLabel(tab.currentUrl)}`,
      loading: 'eager',
    });

    frame.addEventListener('load', () => {
      handlers.onFrameLoad(tab.tabId);
    });

    host.append(frame);
    return host;
  }

  /**
   * [DONE] 应用显示模式（spec FR-007/FR-008）。
   *
   * 移动模式：iframe 直接铺满容器，站点按窄屏断点排版（默认行为）。
   * 桌面模式：iframe 定宽 1280px，再用 `transform: scale()` 缩回容器宽度 —— 站点在
   * 1280px 下按桌面断点渲染多栏版面，然后整体缩小到侧栏宽度。
   *
   * 缩放基准用宿主的 `clientWidth`；主进程无法预知侧栏实际宽度，因此缩放比例必须由
   * 布局后的实测宽度算出，不能硬编码。
   */
  function applyDisplayMode(tabId: string, mode: DisplayMode): void {
    const host = hosts.get(tabId);
    const frame = frameOf(tabId);
    if (host === undefined || frame === null) {
      return;
    }

    if (appliedModes.get(tabId) === mode) {
      return;
    }
    appliedModes.set(tabId, mode);

    host.setAttribute('data-display-mode', mode);

    if (mode === 'mobile') {
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.transform = '';
      frame.style.transformOrigin = '';
      return;
    }

    const hostWidth = host.clientWidth;
    // 宿主尚未布局（隐藏或初次插入）时宽度为 0：跳过缩放，待可见后由 syncTabs 重算
    if (hostWidth <= 0) {
      appliedModes.delete(tabId);
      frame.style.width = `${DESKTOP_VIEWPORT_WIDTH}px`;
      frame.style.height = '100%';
      frame.style.transform = '';
      frame.style.transformOrigin = '0 0';
      return;
    }

    const scale = hostWidth / DESKTOP_VIEWPORT_WIDTH;
    frame.style.width = `${DESKTOP_VIEWPORT_WIDTH}px`;
    // 缩放后视觉高度会同比缩小，因此把高度按比例放大以铺满容器
    frame.style.height = `${100 / scale}%`;
    frame.style.transformOrigin = '0 0';
    frame.style.transform = `scale(${scale})`;
  }

  function frameOf(tabId: string): HTMLIFrameElement | null {
    const host = hosts.get(tabId);
    if (host === undefined) {
      return null;
    }
    const frame = host.querySelector('iframe');
    return frame instanceof HTMLIFrameElement ? frame : null;
  }

  /**
   * [DONE] 窗口尺寸变化时重算桌面模式的缩放比例。
   *
   * 侧栏在浏览器里可被用户拖宽，桌面模式的缩放比例必须跟着变，否则会出现内容被裁切。
   *
   * **必须先把待重算的 tabId 收集成数组再遍历**（终审 B1 修复）：`applyDisplayMode` 内部会
   * `appliedModes.set(tabId, ...)`，而 Map 的迭代器会看到迭代期间新插入的键 ——
   * 若边遍历边 `delete` + 重算，同一键被反复重新插入，迭代永不结束。
   * 触发条件就是"桌面模式下拖宽侧栏"这一主线交互，且会彻底卡死侧栏（连定时器都不再跑）。
   */
  const resizeListener = (): void => {
    const desktopTabIds: string[] = [];
    for (const [tabId, mode] of appliedModes) {
      if (mode === 'desktop') {
        desktopTabIds.push(tabId);
      }
    }

    for (const tabId of desktopTabIds) {
      // 先清掉记录再重算，否则 applyDisplayMode 的同值短路会跳过这次更新
      appliedModes.delete(tabId);
      applyDisplayMode(tabId, 'desktop');
    }
  };
  window.addEventListener('resize', resizeListener);

  return {
    syncTabs(tabs: readonly BrowserTab[], modeOf: DisplayModeResolver): void {
      const liveTabIds = new Set(tabs.map((tab) => tab.tabId));

      // 移除已关闭标签的宿主：其中的 iframe 及其脚本一并被回收
      for (const [tabId, host] of hosts) {
        if (!liveTabIds.has(tabId)) {
          host.remove();
          hosts.delete(tabId);
          loadedUrls.delete(tabId);
          appliedModes.delete(tabId);
        }
      }

      for (const tab of tabs) {
        let host = hosts.get(tab.tabId);
        if (host === undefined) {
          host = createHost(tab);
          hosts.set(tab.tabId, host);
          container.append(host);
        }

        const frame = frameOf(tab.tabId);
        if (frame === null) {
          continue;
        }

        applyDisplayMode(tab.tabId, modeOf(tab));

        // 仅地址变化时写 src：重复赋同值会强制重新加载，破坏 SPA 状态与滚动位置
        if (loadedUrls.get(tab.tabId) !== tab.currentUrl) {
          frame.src = tab.currentUrl;
          loadedUrls.set(tab.tabId, tab.currentUrl);
        }

        frame.title = `网页内容：${truncateForLabel(tab.title ?? tab.currentUrl)}`;
      }
    },

    showTab(tabId: string | null): void {
      for (const [hostTabId, host] of hosts) {
        host.hidden = hostTabId !== tabId;
      }
    },

    loadTab(tabId: string, url: string): void {
      const frame = frameOf(tabId);
      if (frame === null) {
        return;
      }
      frame.src = url;
      loadedUrls.set(tabId, url);
    },

    adoptTabUrl(tabId: string, url: string): void {
      // 只更新"最后一次已知地址"记录，不碰 src —— 页面已经在那个地址上了
      loadedUrls.set(tabId, url);
    },

    flashReload(): void {
      container.classList.remove('reloading');
      // 强制一次重排，否则浏览器可能合并样式变更、动画不会重播
      void container.offsetWidth;
      container.classList.add('reloading');
      window.setTimeout(() => {
        container.classList.remove('reloading');
      }, 560);
    },

    contentElement(): HTMLElement {
      return container;
    },
  };
}

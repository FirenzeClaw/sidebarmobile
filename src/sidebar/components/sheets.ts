// sidebarmobile — 底部弹层（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T027：标签列表与九宫格菜单的基本形态，供切标签与回主页
// 2026-09-29 | Kimi(speckit-implement) | T070/T071：标签行委托 tab-bar，并向 app 暴露菜单锚点
// 2026-09-29 | Kimi(speckit-fix) | 终审 D2：新增 onClosed 回调，供 app 在面板关闭时清空来源绑定

import { clearElement, createElement, requireElement } from './dom.ts';
import { createIcon } from './icons.ts';
import { createTabList, type TabList } from './tab-bar.ts';
import type { BrowserTab } from '../../shared/types.ts';

/**
 * [DONE] 底部弹层容器 + 两个面板（标签列表 / 九宫格菜单）。
 *
 * 交互契约（design-system/MASTER.md §2）：底部升起 + 遮罩压暗 + Esc/遮罩点击关闭 + aria-labelledby。
 * 内容一律 textContent 渲染，标签标题来自网页，属外部文本（spec FR-034）。
 */

export interface SheetHandlers {
  onActivateTab(tabId: string): void;
  onCloseTab(tabId: string): void;
  onCloseAllTabs(): void;
  onNewTab(): void;
  onShowSiteList(): void;
  /** 同顶栏翻转钮：当前家族内 day↔night 即时切换 */
  onToggleTheme(): void;
  /** 打开当前活动标签所属站点的设置面板（显示模式 / UA 授权 / 能力徽章） */
  onOpenSiteSettings(): void;
  /**
   * 弹层已关闭（终审 D2）。
   *
   * 必要性：上层把"当前打开的自定义面板"记在变量里，用来在授权/能力状态变化后**原地重绘**它。
   * 若关闭时不通知，这个变量会永远指向一个已经不在 DOM 里的面板 —— 之后任何一次异步回调
   * 都会去重绘一个不存在的面板，更糟的是它属于**旧来源**：用户切到别的站点后面板内容
   * 会被旧来源的状态改写（串源）。
   */
  onClosed(): void;
}

export interface SheetController {
  /** 打开标签列表面板，需要传入当前标签快照 */
  openTabList(tabs: readonly BrowserTab[], activeTabId: string | null): void;
  /** 用最新标签快照刷新已打开的标签列表（关闭标签后原地刷新，不重播动画） */
  refreshTabList(tabs: readonly BrowserTab[], activeTabId: string | null): void;
  /** 打开九宫格菜单 */
  openGridMenu(tabCount: number, hasActiveTab: boolean): void;
  /**
   * 打开自定义内容面板（站点设置等）。
   *
   * 原地替换面板内容且**保留打开态**：权限对话框返回后需要重绘同一面板，
   * 若走完整打开流程会重新播放升起动画并抢焦点，用户会看到面板闪一下。
   */
  openCustomPanel(content: HTMLElement, title: string): void;
  /**
   * 注册标签列表锚点订阅者（T071）。
   *
   * 传 null 可撤销：侧栏卸载或换面板时若不撤销，旧订阅者会继续收到新列表，
   * 为已经不存在的行挂菜单。
   */
  setTabListAnchorSink(sink: TabListAnchorSink | null): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * 标签列表锚点回调：每次渲染标签列表后把行与 ⋮ 触发钮交给上层。
 *
 * 为什么用回调而不是让上层每帧去查 DOM：标签列表每次刷新都会**重建**元素，
 * 上层（app.ts）需要在重建之后重新为每个 ⋮ 挂上下文菜单。回调时机是唯一可靠的信号。
 */
export type TabListAnchorSink = (list: TabList) => void;

/** [DONE] 创建弹层控制器 */
export function createSheets(handlers: SheetHandlers): SheetController {
  const overlay = requireElement('sheetOverlay');
  const sheet = requireElement('sheet');

  let openerElement: HTMLElement | null = null;

  /**
   * 最近一次渲染的标签列表与锚点订阅者。
   *
   * 二者由本模块持有而不是放在 app.ts：标签列表每次刷新都会重建元素，
   * 渲染方保存订阅者最直接，上层不必自己记"上次那份列表"。
   */
  let tabListAnchorSink: TabListAnchorSink | null = null;

  /** [DONE] 弹层内容的外壳：抓手 + 内容 */
  function mountContent(content: HTMLElement): void {
    clearElement(sheet);
    sheet.append(createElement('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), content);

    // 以面板内标题作为可访问名称（无标题时撤回，避免 aria-labelledby 指向空 id）
    const title = sheet.querySelector('.sheet-title');
    if (title !== null) {
      title.id = 'sheetTitle';
      sheet.setAttribute('aria-labelledby', 'sheetTitle');
    } else {
      sheet.removeAttribute('aria-labelledby');
    }
  }

  /** [DONE] 原地刷新标签列表并把新行交给上层接线（关闭标签后的刷新走这条路径） */
  function remountTabList(tabs: readonly BrowserTab[], activeTabId: string | null): void {
    mountContent(buildTabListContent(tabs, activeTabId));
    notifyAnchorSink();
  }

  /**
   * [DONE] 构建标签列表面板内容。
   *
   * 行渲染委托给 `tab-bar.ts`（T070）：那里负责截断、活动高亮、ARIA 与 ⋮ 触发钮，
   * 本函数只负责把它放进弹层并接上"激活后关闭弹层"这一弹层专属语义。
   */
  /** [DONE] 内容已挂载，通知上层接线（此时元素才 isConnected） */
  function notifyAnchorSink(): void {
    if (tabListAnchorSink !== null && pendingTabList !== null) {
      tabListAnchorSink(pendingTabList);
    }
  }

  /** 待通知的标签列表（内容挂载后由 notifyAnchorSink 消费） */
  let pendingTabList: TabList | null = null;

  /** [DONE] 构建标签列表面板内容（含待通知的列表引用） */
  function buildTabListContent(tabs: readonly BrowserTab[], activeTabId: string | null): HTMLElement {
    const wrap = createElement('div');
    wrap.append(createElement('h2', { class: 'sheet-title', text: '标签列表' }));

    const list = createTabList({
      onActivate: (tabId) => {
        handlers.onActivateTab(tabId);
        close();
      },
      onClose: (tabId) => {
        handlers.onCloseTab(tabId);
      },
      onNewTab: () => {
        handlers.onNewTab();
        close();
      },
    });
    list.render(tabs, activeTabId);

    /**
     * 把行与 ⋮ 触发钮交给上层（T071）：上下文菜单需要真实 DOM 元素作锚点，
     * 而菜单本身不该由标签栏组件持有 —— 菜单是全局单实例的。
     *
     * **通知时机是挂载之后**（由 `openWith`/`mountContent` 调用 `notifyAnchorSink`）：
     * 此刻 `list.element()` 还没进 DOM，接线会因 `isConnected === false` 被静默跳过 ——
     * 表现为"标签的 ⋮ 键盘按了没反应"（本项目实测踩到过）。
     */
    pendingTabList = list;
    wrap.append(list.element());
    return wrap;
  }

  /**
   * [DONE] 构建九宫格菜单面板内容（2×5 图标格 + 页点，design-system/MASTER.md §2）。
   *
   * 可用的格子按用户故事分批放开：US1 让「网站列表 / 关闭全部 / 夜间模式」可用；
   * US2 追加「站点设置」（显示模式 + UA 授权 + 能力徽章）。其余格子按基线保留形状但禁用，
   * 并在 aria-label 里说明原因 —— 能力落地属 US3/US4/US6。
   */
  function buildGridMenuContent(tabCount: number, hasActiveTab: boolean): HTMLElement {
    const wrap = createElement('div');
    const grid = createElement('div', { class: 'menu-grid' });

    interface MenuCell {
      icon: Parameters<typeof createIcon>[0];
      label: string;
      /** 可用性：可点 / 本切片未实现 / 依赖打开的标签页 */
      availability: 'ready' | 'unsupported' | 'needs-tab';
      action?: () => void;
    }

    const hasTab = tabCount > 0;
    const cells: MenuCell[] = [
      {
        icon: 'moon',
        label: '夜间模式',
        availability: 'ready',
        action: () => {
          handlers.onToggleTheme();
          close();
        },
      },
      {
        icon: 'grid',
        label: '网站列表',
        availability: 'ready',
        action: () => {
          handlers.onShowSiteList();
          close();
        },
      },
      { icon: 'history', label: '历史', availability: 'unsupported' },
      { icon: 'copy', label: '复制网址', availability: 'needs-tab' },
      { icon: 'external', label: '普通打开', availability: 'unsupported' },
      { icon: 'share', label: '分享', availability: 'unsupported' },
      { icon: 'bookmark', label: '添加书签', availability: 'unsupported' },
      { icon: 'globe', label: '电脑模式', availability: 'needs-tab' },
      {
        icon: 'menu',
        label: '站点设置',
        availability: hasActiveTab ? 'ready' : 'needs-tab',
        action: () => {
          /**
           * 不调用 close()：站点设置**替换**当前弹层内容（九宫格 → 设置面板）。
           * 若先 close() 再打开，关闭动画的 setTimeout 会在 220ms 后把刚打开的设置面板
           * 一起隐藏掉，用户看到的是面板一闪而过。
           */
          handlers.onOpenSiteSettings();
        },
      },
      {
        icon: 'close',
        label: '关闭全部',
        availability: hasTab ? 'ready' : 'needs-tab',
        action: () => {
          handlers.onCloseAllTabs();
          close();
        },
      },
    ];

    for (const cell of cells) {
      const disabled = cell.availability !== 'ready' || (cell.availability === 'ready' && cell.action === undefined);
      const disabledNote = cell.availability === 'needs-tab' ? '（无打开的标签页）' : '（暂未开放）';
      const button = createElement('button', {
        class: 'menu-cell',
        type: 'button',
        disabled,
        'aria-label': disabled ? `${cell.label}${disabledNote}` : cell.label,
      });
      button.append(
        createElement('span', { class: 'cell-icon', 'aria-hidden': 'true' }, createIcon(cell.icon)),
        createElement('span', { class: 'cell-label', text: cell.label }),
      );
      if (!disabled && cell.action !== undefined) {
        button.addEventListener('click', cell.action);
      }
      grid.append(button);
    }

    // 底部页点指示（单页，首点高亮）：基线要求，纯装饰
    const dots = createElement(
      'div',
      { class: 'menu-dots', 'aria-hidden': 'true' },
      createElement('i', { class: 'on' }),
      createElement('i', {}),
    );

    wrap.append(grid, dots);
    return wrap;
  }

  /** [DONE] 面板内容构建需要先能写入 DOM，打开时统一走 mount + 过渡 */
  function openWith(content: HTMLElement): void {
    openerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mountContent(content);
    overlay.hidden = false;
    sheet.hidden = false;
    window.requestAnimationFrame(() => {
      overlay.classList.add('open');
      sheet.classList.add('open');
    });
    // 内容已在 DOM 中：此时才能为标签行的 ⋮ 接线（接线会检查 isConnected）
    notifyAnchorSink();
    const firstFocusable = sheet.querySelector('button:not([disabled])');
    if (firstFocusable instanceof HTMLElement) {
      window.setTimeout(() => {
        firstFocusable.focus();
      }, 80);
    }
  }

  function close(): void {
    if (sheet.hidden) {
      // 已经关闭：不重复通知（调用方可能幂等地多次请求关闭）
      return;
    }
    // 列表元素即将被移除：清掉待通知引用，避免下次打开时用旧元素接线
    pendingTabList = null;
    overlay.classList.remove('open');
    sheet.classList.remove('open');
    window.setTimeout(() => {
      overlay.hidden = true;
      sheet.hidden = true;
    }, 220);
    if (openerElement !== null && document.contains(openerElement)) {
      openerElement.focus();
    }
    openerElement = null;
    // 通知上层"面板已关"：它持有当前自定义面板的引用，必须同步清掉（终审 D2 串源防护）
    handlers.onClosed();
  }

  overlay.addEventListener('click', () => {
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) {
      close();
    }
  });

  return {
    openTabList(tabs: readonly BrowserTab[], activeTabId: string | null): void {
      openWith(buildTabListContent(tabs, activeTabId));
    },

    refreshTabList(tabs: readonly BrowserTab[], activeTabId: string | null): void {
      if (sheet.hidden) {
        return;
      }
      // 原地刷新：保留打开态，不重新播放升起动画；新行同样要交给上层接线
      remountTabList(tabs, activeTabId);
    },

    openGridMenu(tabCount: number, hasActiveTab: boolean): void {
      openWith(buildGridMenuContent(tabCount, hasActiveTab));
    },

    openCustomPanel(content: HTMLElement, title: string): void {
      // 内容自带标题（面板头部已是站点名），这里补一个用于 aria-labelledby 的可访问标题
      const wrapper = createElement('div');
      wrapper.append(createElement('h2', { class: 'sheet-title visually-hidden', text: title }), content);

      if (sheet.hidden) {
        openWith(wrapper);
        return;
      }
      // 已打开：原地替换内容，保留打开态与滚动位置（权限对话框返回后的重绘走这条路径）
      mountContent(wrapper);
    },

    setTabListAnchorSink(sink: TabListAnchorSink | null): void {
      tabListAnchorSink = sink;
    },

    close,

    isOpen(): boolean {
      return !sheet.hidden;
    },
  };
}

/** [DONE] 供 app.ts 复用的提示接口 */
export function createToast(): (message: string) => void {
  const toast = requireElement('toast');
  let timer = 0;
  return (message: string): void => {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  };
}

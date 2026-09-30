// sidebarmobile — 底部弹层（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T027：标签列表与九宫格菜单的基本形态，供切标签与回主页
// 2026-09-29 | Kimi(speckit-implement) | T070/T071：标签行委托 tab-bar，并向 app 暴露菜单锚点
// 2026-09-29 | Kimi(speckit-fix) | 终审 D2：新增 onClosed 回调，供 app 在面板关闭时清空来源绑定
// 2026-09-30 | Kimi(fix) | 用户实测反馈：去掉误导性页点；接线复制网址/历史/电脑模式/普通打开四格；新增历史面板

import { clearElement, createElement, requireElement, truncateForLabel } from './dom.ts';
import { createIcon, type IconName } from './icons.ts';
import { createTabList, type TabList } from './tab-bar.ts';
import type { BrowserTab, HistoryEntry } from '../../shared/types.ts';

/**
 * [DONE] 底部弹层容器 + 三个面板（标签列表 / 九宫格菜单 / 历史）。
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
  /** 复制当前活动标签的网址到剪贴板（成败由 app 用 toast 如实反馈） */
  onCopyUrl(): void;
  /** 打开当前活动标签的 URL 历史栈面板 */
  onOpenHistory(): void;
  /**
   * 在历史栈内跳到某一项（九宫格「历史」面板里点击一条记录）。
   *
   * 传索引而不只传 URL：面板列出的就是**这条栈的位置**，按索引跳转才能保持
   * 「后退/前进仍可用」的语义（按 URL 重新导航会截断前向分支，把后面的记录丢掉）。
   * 传 URL 是给调用方兜底用的 —— 索引越界时它仍能按地址导航，不至于点了没反应。
   */
  onActivateHistoryEntry(url: string, index: number): void;
  /** 在当前标签所属来源上切换移动/桌面显示模式 */
  onToggleDesktopMode(): void;
  /** 用普通浏览器标签页打开当前地址（spec FR-006 的降级路径） */
  onOpenExternal(): void;
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
   * 打开某标签的 URL 历史栈面板（九宫格「历史」格）。
   *
   * 传整个标签而不是 `history` 数组：面板除条目外还需要 `historyIndex` 才能标出"当前在哪一条"。
   * 分开传两个参数会让调用方有机会只传其中一个（那样当前项就标不出来），
   * 而标签对象本身就是这两者的来源，直接传它不存在漏传的可能。
   */
  openHistory(tab: BrowserTab): void;
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
   * [DONE] 构建九宫格菜单面板内容（单页 2×5，design-system/MASTER.md §2）。
   *
   * **不含页点**（用户实测反馈修复）：此前的实现画了两个页点、首点高亮，视觉上承诺
   * 「可以左右翻页」，而根本没有翻页逻辑 —— 用户右滑无反应。控件暗示一个不存在的能力
   * 比不放这个控件更糟：用户会反复尝试，并开始怀疑其它控件的可靠性。菜单只有一个页面，
   * 就不该有任何"还有下一页"的视觉符号。
   *
   * 格子按**依赖关系**分三档决定可用性：
   * - 不依赖标签（夜间模式、网站列表）：始终可点；
   * - 依赖**当前活动标签**（站点设置、复制网址、历史、电脑模式、普通打开）：无活动标签时禁用；
   * - 依赖**有标签**（关闭全部）：只要有标签就可用（无活动标签也能关掉全部）；
   * - 本产品暂无对应能力（分享、添加书签）：保持禁用并说明原因。
   *
   * 用 `hasActiveTab` 而不是 `tabCount > 0` 判前两档的差异，是因为**存在"有标签但无活动标签"**
   * 的合法状态：会话恢复时若活动标签 id 失配，状态层会把 activeTabId 置空（data-model §5）。
   * 一刀切会让这些格子可点然后在 handler 里静默失败 —— 用户看到的是"按了没反应"，
   * 正是本次要修掉的那种体验。
   */
  function buildGridMenuContent(tabCount: number, hasActiveTab: boolean): HTMLElement {
    const wrap = createElement('div');
    const grid = createElement('div', { class: 'menu-grid' });

    interface MenuCell {
      icon: IconName;
      label: string;
      /** 可用性：可点 / 本产品未提供该能力 / 依赖打开的标签页 */
      availability: 'ready' | 'unsupported' | 'needs-tab';
      action?: () => void;
    }

    const hasTab = tabCount > 0;
    /** 依赖当前活动标签的格子统一用一个档位，避免各处重复写条件而漂移 */
    const forActiveTab = (action: () => void): Pick<MenuCell, 'availability' | 'action'> =>
      hasActiveTab ? { availability: 'ready', action } : { availability: 'needs-tab' };

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
      {
        icon: 'history',
        label: '历史',
        ...forActiveTab(() => {
          handlers.onOpenHistory();
        }),
      },
      {
        icon: 'copy',
        label: '复制网址',
        ...forActiveTab(() => {
          handlers.onCopyUrl();
          close();
        }),
      },
      {
        icon: 'external',
        label: '普通打开',
        ...forActiveTab(() => {
          handlers.onOpenExternal();
          close();
        }),
      },
      /**
       * 分享保持禁用：本产品没有分享目标（不发往其它 App、无社交平台集成），
       * 点击后只能弹一句"暂不支持"。给一个点了必然失败的入口，不如如实标记为未提供。
       * 添加书签同理：它与「加入网站列表」功能重叠，两者的语义边界（书签应否绑定标签、
       * 是否参与历史）尚未定，先不给出一个含义模糊的入口。
       */
      { icon: 'share', label: '分享', availability: 'unsupported' },
      { icon: 'bookmark', label: '添加书签', availability: 'unsupported' },
      {
        icon: 'globe',
        label: '电脑模式',
        ...forActiveTab(() => {
          handlers.onToggleDesktopMode();
          close();
        }),
      },
      {
        icon: 'menu',
        label: '站点设置',
        ...forActiveTab(() => {
          /**
           * 不调用 close()：站点设置**替换**当前弹层内容（九宫格 → 设置面板）。
           * 若先 close() 再打开，关闭动画的 setTimeout 会在 220ms 后把刚打开的设置面板
           * 一起隐藏掉，用户看到的是面板一闪而过。
           */
          handlers.onOpenSiteSettings();
        }),
      },
      {
        icon: 'close',
        label: '关闭全部',
        // 只依赖"有标签"：即便活动标签缺失，关掉全部仍是有效且可预期的操作
        availability: hasTab ? 'ready' : 'needs-tab',
        action: () => {
          handlers.onCloseAllTabs();
          close();
        },
      },
    ];

    for (const cell of cells) {
      const disabled = cell.availability !== 'ready' || cell.action === undefined;
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

    wrap.append(grid);
    return wrap;
  }

  /**
   * [DONE] 构建某标签的 URL 历史栈面板（九宫格「历史」格）。
   *
   * **只列当前标签自己的栈**（spec FR-018：历史是标签域的数据，不存页面内容）：
   * 每条是一个按钮，点击即让该标签回到那个历史位置 —— 兑现逻辑在 `app.ts` 的
   * `jumpToHistoryEntry`，它走状态层的"栈内移动"（而非新导航），因此前向分支得以保留。
   *
   * 反向列出（最新的在最上）：用户打开"历史"通常是为了回到刚看过的某一页。
   * 当前所在项标注「当前」而不禁用：点它等于重新加载当前页，是合理操作。
   */
  function buildHistoryContent(tab: BrowserTab): HTMLElement {
    const wrap = createElement('div');
    wrap.append(createElement('h2', { class: 'sheet-title', text: '历史' }));

    const list = createElement('div', { class: 'history-list' });
    const entries = tab.history
      .map((entry: HistoryEntry, index: number) => ({ entry, index }))
      .reverse();

    if (entries.length === 0) {
      list.append(createElement('p', { class: 'history-list-empty', text: '这个标签还没有历史记录。' }));
      wrap.append(list);
      return wrap;
    }

    for (const { entry, index } of entries) {
      const isCurrent = index === tab.historyIndex;
      // 标题为空时回落到 URL：只显示空白的行用户认不出是哪一页（与标签行同一规则）
      const titleText = entry.title !== null && entry.title.length > 0 ? entry.title : entry.url;
      const row = createElement('button', {
        class: `history-row${isCurrent ? ' current' : ''}`,
        type: 'button',
        'aria-label': `打开历史记录：${truncateForLabel(titleText, 60)}${isCurrent ? '（当前）' : ''}`,
      });
      row.append(
        createElement('span', { class: 'history-row-main' },
          createElement('span', { class: 'history-row-title', text: titleText, title: entry.url }),
          createElement('span', { class: 'history-row-url', text: entry.url, title: entry.url }),
        ),
        // 「当前」标记是给所有用户的（不只读屏器）：列表里同一地址可能出现多次
        ...(isCurrent ? [createElement('span', { class: 'history-row-flag', text: '当前' })] : []),
      );
      row.addEventListener('click', () => {
        handlers.onActivateHistoryEntry(entry.url, index);
      });
      list.append(row);
    }

    wrap.append(list);
    return wrap;
  }

  /**
   * [DONE] 打开面板：已开着就原地替换内容，否则走完整的升起流程。
   *
   * **为什么必须分两条路径**（这是踩过的坑）：从九宫格点进「站点设置」或「历史」时弹层已经
   * 开着，若一律走 `openWith`，虽然动画不会重播，但 `openerElement` 会被改写成"刚才聚焦的
   * 菜单格"——那个元素随即被 `clearElement` 删掉，关闭时便无法回焦到真正打开弹层的按钮，
   * 键盘用户的焦点落回 body、Tab 从页首重新开始（FR-028）。
   * 保留打开态还顺带避免内容闪一下。
   */
  function openOrReplace(content: HTMLElement): void {
    if (sheet.hidden) {
      openWith(content);
      return;
    }
    // 已打开：原地替换内容，保留打开态、滚动位置与打开者引用
    mountContent(content);
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

    openHistory(tab: BrowserTab): void {
      // 用 replace 路径：历史是从九宫格**点进去**的，弹层已开着，不该重新播放升起动画
      openOrReplace(buildHistoryContent(tab));
    },

    openCustomPanel(content: HTMLElement, title: string): void {
      // 内容自带标题（面板头部已是站点名），这里补一个用于 aria-labelledby 的可访问标题
      const wrapper = createElement('div');
      wrapper.append(createElement('h2', { class: 'sheet-title visually-hidden', text: title }), content);

      // 走 replace 路径：权限对话框返回后的重绘与九宫格 → 设置面板的切换都复用同一条逻辑
      openOrReplace(wrapper);
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

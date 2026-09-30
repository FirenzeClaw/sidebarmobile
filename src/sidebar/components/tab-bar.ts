// sidebarmobile — 紧凑标签栏与标签列表（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T070：标签列表（含截断标题、活动高亮、关闭、⋮ 菜单）（FR-024）

import { clearElement, createElement, truncateForLabel } from './dom.ts';
import { createIcon } from './icons.ts';
import type { BrowserTab } from '../../shared/types.ts';

/**
 * [DONE] 紧凑标签栏与溢出标签列表（spec FR-024）。
 *
 * **形态说明（重要，避免走回头路）**：本项目的标签管理入口是**底栏的标签列表弹层**，
 * 顶栏只有一个网址栏 + 深浅翻转钮（design-system/MASTER.md §2「顶栏除此两项外不放任何元素」）。
 * 因此这里不实现"顶部横排标签条"—— US1 阶段刻意没有引入它，恢复它就会违反布局锁定项。
 *
 * 契约 ui-states.md §紧凑标签栏的三条要求在此兑现：
 * - 每项：favicon + 标题（约 12 字符截断）+ 活动态高亮；关闭按钮在悬停/聚焦时显现（样式层实现）；
 * - 空间不足：全部标签都在这个列表里（它本身就是"溢出列表"），活动项高亮且始终在列表内；
 * - 20 个标签内不引入虚拟滚动（SC-003 的上限就是 20，多一层虚拟化只会增加复杂度）。
 *
 * 每行还有一个 ⋮ 触发钮，用于挂 T071 的标签页上下文菜单（刷新/复制网址/普通打开/关闭）。
 */

/** 标题截断长度：约 12 个汉字或 20+ 个拉丁字符，够区分同站多标签又不挤掉关闭钮 */
export const TAB_TITLE_MAX_CHARS = 12;

export interface TabListHandlers {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  /** 新建标签（回主页选网站） */
  onNewTab(): void;
}

/** 单个标签行的渲染输入 */
export interface TabRowViewModel {
  tabId: string;
  /** 已截断的显示标题 */
  displayTitle: string;
  /** 完整标题，用于 title 提示与 aria-label */
  fullTitle: string;
  url: string;
  isActive: boolean;
}

export interface TabList {
  /** 渲染整份标签列表 */
  render(tabs: readonly BrowserTab[], activeTabId: string | null): void;
  /** 根元素（由调用方插入弹层） */
  element(): HTMLElement;
  /** 行元素查询：供上层挂上下文菜单（T071） */
  rowElementFor(tabId: string): HTMLElement | null;
  /** ⋮ 触发钮查询：供上层作为菜单锚点 */
  moreButtonFor(tabId: string): HTMLElement | null;
}

/** [DONE] 由标签计算一行要显示的文本与状态 */
export function tabRowViewModel(tab: BrowserTab, activeTabId: string | null): TabRowViewModel {
  // 标题为空时回落到 URL：没有标题的标签若显示空白行，用户无法分辨它是什么
  const fullTitle = tab.title !== null && tab.title.length > 0 ? tab.title : tab.currentUrl;
  return {
    tabId: tab.tabId,
    displayTitle: truncateForLabel(fullTitle, TAB_TITLE_MAX_CHARS),
    fullTitle,
    url: tab.currentUrl,
    isActive: tab.tabId === activeTabId,
  };
}

/** [DONE] 创建标签列表 */
export function createTabList(handlers: TabListHandlers): TabList {
  const root = createElement('div', { class: 'tabbar' });
  /** tabId → 行元素 / ⋮ 按钮，供上层挂菜单用 */
  const rows = new Map<string, HTMLElement>();
  const moreButtons = new Map<string, HTMLElement>();

  /** [DONE] 构建一行 */
  function buildRow(view: TabRowViewModel): HTMLElement {
    const row = createElement('div', {
      class: `tablist-row${view.isActive ? ' active' : ''}`,
      role: 'button',
      tabindex: '0',
      'data-tab-id': view.tabId,
      // aria-current 让读屏器知道哪一行是"当前项"，而不是只靠颜色
      ...(view.isActive ? { 'aria-current': 'true' } : {}),
      'aria-label': `切换到标签「${truncateForLabel(view.fullTitle, 60)}」`,
    });

    const favicon = createElement('span', {
      class: 'tab-favicon',
      'aria-hidden': 'true',
      text: view.displayTitle.slice(0, 1),
    });

    const moreButton = createElement('button', {
      class: 'tablist-more',
      type: 'button',
      'aria-label': `标签「${truncateForLabel(view.fullTitle, 40)}」的更多操作`,
      // ARIA menu 模式：触发器声明弹出的是菜单并暴露展开状态（FR-028）
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    moreButton.append(createIcon('more'));

    const closeButton = createElement('button', {
      class: 'tablist-close',
      type: 'button',
      'aria-label': `关闭标签「${truncateForLabel(view.fullTitle, 40)}」`,
    });
    closeButton.append(createIcon('close'));
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(view.tabId);
    });

    row.append(
      favicon,
      createElement(
        'span',
        { class: 'tablist-main' },
        createElement('span', { class: 'tablist-title', text: view.displayTitle, title: view.fullTitle }),
        createElement('span', { class: 'tablist-url', text: view.url, title: view.url }),
      ),
      moreButton,
      closeButton,
    );

    /** 激活：点击行体（不是按钮）或键盘 Enter/Space */
    const activate = (): void => {
      handlers.onActivate(view.tabId);
    };
    row.addEventListener('click', (event) => {
      // 点在按钮上时不激活（按钮有自己的语义）
      if (event.target instanceof Element && event.target.closest('button') !== null) {
        return;
      }
      activate();
    });
    row.addEventListener('keydown', (event) => {
      // 只在行本身聚焦时响应，避免吞掉行内按钮的键盘事件
      if (event.target !== row) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    rows.set(view.tabId, row);
    moreButtons.set(view.tabId, moreButton);
    return row;
  }

  return {
    render(tabs: readonly BrowserTab[], activeTabId: string | null): void {
      clearElement(root);
      rows.clear();
      moreButtons.clear();

      if (tabs.length === 0) {
        root.append(createElement('p', { class: 'tablist-empty', text: '当前没有打开的标签页。' }));
        return;
      }

      const list = createElement('div', { class: 'tablist' });
      for (const tab of tabs) {
        list.append(buildRow(tabRowViewModel(tab, activeTabId)));
      }
      root.append(list);

      const newTabButton = createElement('button', {
        class: 'tablist-new',
        type: 'button',
        'aria-label': '新建标签（回主页选网站）',
      });
      newTabButton.append(createIcon('plus'));
      newTabButton.addEventListener('click', () => {
        handlers.onNewTab();
      });
      root.append(newTabButton);
    },

    element(): HTMLElement {
      return root;
    },

    rowElementFor(tabId: string): HTMLElement | null {
      return rows.get(tabId) ?? null;
    },

    moreButtonFor(tabId: string): HTMLElement | null {
      return moreButtons.get(tabId) ?? null;
    },
  };
}

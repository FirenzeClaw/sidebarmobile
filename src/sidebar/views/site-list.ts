// sidebarmobile — 网站列表视图（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T025：品牌区 + 大胶囊添加框 + 网站网格（FR-025/FR-034）

import { parseUrlInput } from '../../shared/url-policy.ts';
import { clearElement, createElement, requireElement, truncateForLabel } from '../components/dom.ts';
import { createIcon, replaceWithIcon } from '../components/icons.ts';
import type { SiteEntry } from '../../shared/types.ts';

/**
 * [DONE] 视图 A：网站列表主页。
 *
 * 分工：静态骨架（品牌区、添加框、网格容器）写在 index.html；本模块只做**动态渲染与交互**，
 * 因此元素查询失败会立刻抛出，而不是在 DOM 里补建第二份结构。
 *
 * 外部文本（网站名、错误说明）一律 textContent，本文件不出现 innerHTML（spec FR-034）。
 * 条目操作（打开/删除）委托给注入的回调，视图不直接改状态。
 */

export interface SiteListViewHandlers {
  /** 用户提交了合法网址（已通过 URL 策略校验） */
  onAddUrl(rawInput: string): void;
  onOpenSite(site: SiteEntry): void;
}

/**
 * 网站条目的菜单锚点（T071）。
 *
 * 暴露给 app.ts 用于挂「网站条目」上下文菜单：菜单需要真实的条目元素与 ⋮ 触发钮，
 * 而菜单本身是全局单实例、不该由视图持有。
 */
export interface SiteAnchors {
  item: HTMLElement;
  moreButton: HTMLElement;
}

export interface SiteListView {
  /** 用最新网站列表重绘网格 */
  render(sites: readonly SiteEntry[]): void;
  /** 清空并聚焦添加输入框 */
  resetAddInput(): void;
  /** 取某来源的菜单锚点；不存在返回 null */
  anchorsFor(originKey: string): SiteAnchors | null;
}

/** [DONE] 创建网站列表视图并接管其交互 */
export function createSiteListView(handlers: SiteListViewHandlers): SiteListView {
  const form = requireElement<HTMLFormElement>('addUrlForm');
  const input = requireElement<HTMLInputElement>('addUrlInput');
  const errorText = requireElement('addUrlError');
  const grid = requireElement('siteGrid');
  const emptyHint = requireElement('siteGridEmpty');

  /** originKey → 条目与 ⋮ 触发钮；每次重绘时重建（元素会被丢弃） */
  const siteAnchors = new Map<string, SiteAnchors>();

  // 静态骨架里的图标占位在此填充：HTML 中留空 span，图标一律由 icons 模块以 DOM API 构建
  replaceWithIcon(requireElement('brandLogo'), 'globe');
  replaceWithIcon(requireElement('addUrlSubmit'), 'plus');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value;
    const parsed = parseUrlInput(raw);
    if (!parsed.ok) {
      // 非法输入：显示原因、保留用户原文、不产生任何条目（spec FR-003）
      errorText.textContent = parsed.detail;
      errorText.hidden = false;
      input.focus();
      return;
    }
    handlers.onAddUrl(raw);
  });

  // 用户开始修改输入时立即撤下旧错误，避免错误文案与被编辑的内容不同步
  input.addEventListener('input', () => {
    errorText.hidden = true;
  });

  /**
   * [DONE] 构建单个网站条目（图标 + 名称 + ⋮ 菜单触发钮）。
   *
   * ⋮ 触发钮是「网站条目」上下文菜单的锚点（contracts/ui-states.md 四类菜单之一）。
   * 它与条目的主行为（打开）必须分开：点条目体是打开网站，点 ⋮ 才是菜单 ——
   * 若两者共用一个元素，触摸用户就无法既打开又调菜单。
   */
  function buildSiteItem(site: SiteEntry): HTMLElement {
    const label = site.title.length > 0 ? site.title : site.originKey;
    const item = createElement('div', {
      class: 'site-item',
      role: 'listitem',
      tabindex: '0',
      'data-origin-key': site.originKey,
      'aria-label': `${truncateForLabel(label)}，Enter 打开`,
    });

    const moreButton = createElement('button', {
      class: 'site-more',
      type: 'button',
      'aria-label': `${truncateForLabel(label, 40)} 的更多操作`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    moreButton.append(createIcon('more'));
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    item.append(
      createElement('div', { class: 'site-icon', 'aria-hidden': 'true', text: label.slice(0, 1) }),
      createElement('span', { class: 'site-name', text: label }),
      moreButton,
    );

    item.addEventListener('click', (event) => {
      // 点在 ⋮ 上时不打开网站（那是菜单触发器的职责）
      if (event.target instanceof Element && event.target.closest('.site-more') !== null) {
        return;
      }
      handlers.onOpenSite(site);
    });

    item.addEventListener('keydown', (event) => {
      if (event.target !== item) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handlers.onOpenSite(site);
      }
    });

    siteAnchors.set(site.originKey, { item, moreButton });
    return item;
  }

  return {
    render(sites: readonly SiteEntry[]): void {
      clearElement(grid);
      siteAnchors.clear();
      emptyHint.hidden = sites.length > 0;
      for (const site of sites) {
        grid.append(buildSiteItem(site));
      }
    },

    resetAddInput(): void {
      input.value = '';
      errorText.hidden = true;
      errorText.textContent = '';
      input.focus();
    },

    anchorsFor(originKey: string): SiteAnchors | null {
      return siteAnchors.get(originKey) ?? null;
    },
  };
}

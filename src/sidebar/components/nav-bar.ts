// sidebarmobile — 底部导航条（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T027：五键常驻（后退/前进/主页/标签数/菜单，FR-022）

import { createElement, requireElement } from '../components/dom.ts';
import { replaceWithIcon } from '../components/icons.ts';

/**
 * [DONE] 底部五键导航条（Via 式，design-system/MASTER.md §2）。
 *
 * 契约：
 * - **两个视图都常驻渲染**（含主页视图），主页视图下后退/前进为禁用态、主页钮 `aria-current` 高亮；
 * - 后退/前进的可用性由扩展自维护的历史栈决定（spec FR-022）：侧栏无法读取跨源 iframe 的历史，
 *   因此这里只反映标签的 historyIndex，实际跳转由 app.ts 调用 reloadTab 完成；
 * - 标签数按钮为 23×23 圆角正方形（固定 6px 圆角，样式在 app.css 中，不随主题变化）；
 * - 所有纯图标按钮都有 aria-label（spec FR-028）。
 */

export interface NavBarHandlers {
  onBack(): void;
  onForward(): void;
  onHome(): void;
  /** 打开标签列表弹层 */
  onOpenTabList(): void;
  /** 打开九宫格菜单弹层 */
  onOpenMenu(): void;
}

/** 导航条的渲染输入：只读快照，视图不持有状态 */
export interface NavBarState {
  /** 当前是否处于浏览视图（主页视图下导航键禁用） */
  inBrowserView: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  tabCount: number;
}

export interface NavBar {
  render(state: NavBarState): void;
}

/** [DONE] 创建导航条并接管其交互 */
export function createNavBar(handlers: NavBarHandlers): NavBar {
  const backButton = requireElement<HTMLButtonElement>('navBack');
  const forwardButton = requireElement<HTMLButtonElement>('navForward');
  const homeButton = requireElement<HTMLButtonElement>('navHome');
  const tabCountButton = requireElement<HTMLButtonElement>('navTabCount');
  const menuButton = requireElement<HTMLButtonElement>('navMenu');
  const tabCountBox = requireElement('navTabCountBox');

  replaceWithIcon(backButton, 'back');
  replaceWithIcon(forwardButton, 'forward');
  replaceWithIcon(homeButton, 'home');
  replaceWithIcon(menuButton, 'menu');

  backButton.addEventListener('click', () => {
    handlers.onBack();
  });
  forwardButton.addEventListener('click', () => {
    handlers.onForward();
  });
  homeButton.addEventListener('click', () => {
    handlers.onHome();
  });
  tabCountButton.addEventListener('click', () => {
    handlers.onOpenTabList();
  });
  menuButton.addEventListener('click', () => {
    handlers.onOpenMenu();
  });

  return {
    render(state: NavBarState): void {
      backButton.disabled = !state.inBrowserView || !state.canGoBack;
      forwardButton.disabled = !state.inBrowserView || !state.canGoForward;

      // 主页钮在主页视图呈当前态（aria-current 供读屏器识别，样式由 .on 提供）
      const atHome = !state.inBrowserView;
      homeButton.classList.toggle('on', atHome);
      if (atHome) {
        homeButton.setAttribute('aria-current', 'page');
      } else {
        homeButton.removeAttribute('aria-current');
      }

      tabCountBox.textContent = String(state.tabCount);
      tabCountButton.setAttribute('aria-label', `标签列表，共 ${state.tabCount} 个标签`);

      // 主页视图下禁用项对键盘不可达，需显式告知读屏器原因
      backButton.setAttribute('aria-label', backButton.disabled ? '后退（不可用）' : '后退');
      forwardButton.setAttribute('aria-label', forwardButton.disabled ? '前进（不可用）' : '前进');
    },
  };
}

/** [DONE] 顶栏网址栏的渲染输入 */
export interface TopBarState {
  /** 主页视图 = true；浏览视图 = false */
  atHome: boolean;
  /** 浏览视图下的抬头文本（标题或 URL） */
  title: string;
  /** 抬头文本的 title 提示（完整 URL） */
  titleHint: string;
  /** 是否显示「地址可能未同步」徽章（Tier 1 追踪的不确定态，spec FR-021） */
  addressMaybeStale: boolean;
}

export interface TopBarHandlers {
  /** 用户点了深浅主题翻转钮 */
  onFlipTheme(): void;
}

export interface TopBar {
  render(state: TopBarState, isNight: boolean): void;
}

/** [DONE] 创建顶栏（网址栏 + 深浅主题翻转钮） */
export function createTopBar(handlers: TopBarHandlers): TopBar {
  const urlBarIcon = requireElement('urlBarIcon');
  const urlBarText = requireElement('urlBarText');
  const urlBarBadge = requireElement('urlBarBadge');
  const urlBar = requireElement('urlBar');
  const themeFlipButton = requireElement<HTMLButtonElement>('themeFlipButton');

  themeFlipButton.addEventListener('click', () => {
    handlers.onFlipTheme();
  });

  return {
    render(state: TopBarState, isNight: boolean): void {
      // 白天示月（点击变暗），夜间示日；与 MASTER.md §4 的图标随模式互换一致
      replaceWithIcon(themeFlipButton, isNight ? 'sun' : 'moon');
      themeFlipButton.setAttribute('aria-label', isNight ? '切换到浅色主题' : '切换到深色主题');

      if (state.atHome) {
        // 主页视图：产品图标 +「主页」
        urlBarIcon.className = 'urlbar-icon urlbar-product';
        replaceWithIcon(urlBarIcon, 'globe');
        urlBarText.textContent = '主页';
        urlBarText.removeAttribute('title');
        urlBarBadge.hidden = true;
        urlBar.setAttribute('aria-label', '当前位置：主页');
        return;
      }

      urlBarIcon.className = 'urlbar-icon urlbar-fav';
      replaceWithIcon(urlBarIcon, 'globe');
      urlBarText.textContent = state.title;
      if (state.titleHint.length > 0) {
        urlBarText.setAttribute('title', state.titleHint);
      } else {
        urlBarText.removeAttribute('title');
      }
      urlBarBadge.hidden = !state.addressMaybeStale;
      urlBar.setAttribute(
        'aria-label',
        `当前页面：${state.title}${state.addressMaybeStale ? '，地址可能未同步' : ''}`,
      );
    },
  };
}

/** [DONE] 顶部警示条（存储失败提示，spec FR-032）；本切片仅提供显示/隐藏能力 */
export interface NoticeBar {
  show(message: string): void;
  hide(): void;
}

export function createNoticeBar(): NoticeBar {
  const bar = requireElement('noticeBar');
  const text = createElement('span', { class: 'notice-text' });
  bar.append(text);

  return {
    show(message: string): void {
      text.textContent = message;
      bar.hidden = false;
    },
    hide(): void {
      text.textContent = '';
      bar.hidden = true;
    },
  };
}

// sidebarmobile — 侧栏应用入口（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | 初始骨架：仅挂载点占位
// 2026-09-29 | Kimi(speckit-implement) | T026/T027/T028：装配状态层与视图层，接线会话持久化
// 2026-09-29 | Kimi(speckit-implement) | T039/T045：站点设置面板接线（模式切换、UA/Cookie 开关、能力徽章）
// 2026-09-29 | Kimi(speckit-implement) | T054/T057/T059：frame 上报归属、不确定态徽章、四类上下文菜单接线
// 2026-09-29 | Kimi(speckit-fix) | 终审 A1/A2：订阅 storage 变更镜像授权状态，避免侧栏内存态覆盖后台写入
// 2026-09-29 | Kimi(speckit-fix) | 终审 B3/C2：上报标题走上限校验；handleFrameReport 增加来源授权校验
// 2026-09-29 | Kimi(speckit-fix) | 终审 D1/D2：新窗口请求由侧栏决策；设置面板绑定来源并校验后再渲染
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：关闭标签时释放嵌入追踪资源；重绘前解绑旧菜单锚点

import { createNavBar, createNoticeBar, createTopBar, type TopBarState } from './components/nav-bar.ts';
import { createSheets, createToast } from './components/sheets.ts';
import { createThemeController } from './components/theme.ts';
import { requireElement } from './components/dom.ts';
import { createSiteSettingsPanel, noticeForOutcome, uaToggleStateFor, type SiteSettingsPanel } from './components/site-settings.ts';
import { createIconMenu, type IconMenuItem } from './components/icon-menu.ts';
import {
  NAVIGATION_MENU_ITEMS,
  SITE_ENTRY_MENU_ITEMS,
  SITE_SETTINGS_MENU_ITEMS,
  TAB_ENTRY_MENU_ITEMS,
  type ContextMenuItemSpec,
} from './components/context-menu-spec.ts';
import { createEmbedFallbackCoordinator } from './state/embed-fallback.ts';
import { createBrowserView } from './views/browser-view.ts';
import { createSiteListView } from './views/site-list.ts';
import type { TabList } from './components/tab-bar.ts';
import { createTabSession } from './state/tab-session.ts';
import { createSiteRegistry } from './state/site-registry.ts';
import { createSiteSettingsStore } from './state/site-settings.ts';
import { createSessionPersistence } from './state/session-persistence.ts';
import { decideOpenRequest, findTabForFrameUrl as findTabForFrameUrlIn } from './state/frame-attribution.ts';
import { createAppSessionStore, runtimeApi, tabsApi } from '../adapters/browser-api.ts';
import { createCapabilityState } from '../shared/capability-state.ts';
import { validateRuntimeMessage } from '../shared/messages.ts';
import { normalizeTitle } from '../shared/frame-report-spec.ts';
import { originKeyTextFromUrl } from '../shared/origin-key.ts';
import type { SaveResult } from '../shared/session-store.ts';
import type { BrowserTab, CapabilityState, DisplayMode, TabLoadState } from '../shared/types.ts';

/**
 * [DONE] 侧栏应用装配入口。
 *
 * 分层（宪法：状态层不碰 DOM、视图层不碰存储）：
 *   state/       纯状态机（tab-session / site-registry / session-persistence）
 *   views/       视图渲染，只调用注入的回调
 *   components/  跨视图复用控件（顶栏、导航条、弹层、图标、主题）
 *   adapters/    浏览器 API 唯一出口
 *
 * 本文件只做装配与事件编排：不写渲染细节，也不写业务规则。
 */

/** 当前视图：网站列表主页 / 网页浏览（单视图切换，spec FR-025） */
type ViewName = 'site-list' | 'browser';

const appRoot = requireElement('app');
const siteListSection = requireElement('viewSiteList');
const browserSection = requireElement('viewBrowser');

/**
 * [DONE] 生成侧栏内唯一的标签 ID。
 *
 * 不用 crypto.randomUUID：扩展页在部分上下文里该 API 不可用，且随机 ID 不利排障。
 * 计数器 + 时间戳在单个扩展实例内足够唯一；恢复历史标签时状态层会避开已用 ID。
 */
let tabIdCounter = 0;
function createTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabIdCounter}`;
}

const theme = createThemeController(document.documentElement);
const tabs = createTabSession({ createId: createTabId, now: () => new Date().toISOString() });
const sites = createSiteRegistry({ now: () => new Date().toISOString() });
const siteSettings = createSiteSettingsStore();
const persistence = createSessionPersistence({ store: createAppSessionStore(), tabs, sites, siteSettings });

let currentView: ViewName = 'site-list';

/** 弹层与 toast 在 render() 中按需重建，这里用 let 避免与视图模块的声明顺序耦合 */
let sheets: ReturnType<typeof createSheets>;
let showToast: ReturnType<typeof createToast>;

const noticeBar = createNoticeBar();

/**
 * 能力状态缓存：`originKey → 最近一次查询结果`。
 *
 * 为什么需要缓存：能力状态无法在侧栏本地算出 —— 它取决于 `permissions.contains` 的实时结果，
 * 只有后台持有权限 API。因此侧栏在切换标签/打开设置时向后台查询，结果缓存在这里供渲染使用。
 * 缓存键是精确来源，所以切到别的来源必然取到该来源自己的状态，不会串（FR-038）。
 *
 * 未查询过的来源使用保守默认（未授权）—— 宁可先显示未授权，也不能默认显示可用（FR-029）。
 */
const capabilityCache = new Map<string, CapabilityState>();

/**
 * 已收到过 Tier 2 上报的来源集合（`navigation = tracked` 的依据）。
 *
 * 这是**只有侧栏知道**的事实：后台无法得知某个来源是否真的有过成功上报。
 * 收到过就意味着 URL/标题是页面自报的、可核对，此时才能撤下「地址可能未同步」徽章（FR-021）。
 * 只用后即弃、不持久化 —— 每次扩展重启后追踪都要重新建立，旧结论不成立。
 */
const trackedOrigins = new Set<string>();

/** 最近一次操作提示（如「未授权，已使用降级模式」），随设置面板展示 */
let settingsNotice: string | null = null;

/** UA 授权申请进行中：禁用开关避免权限对话框叠加 */
let uaGrantPending = false;

/**
 * 当前应保留的「数据损坏」提示文案；null 表示没有这条信息要显示。
 *
 * 保存文案而不是一个布尔标记，是因为警示条被两类提示共用：写入失败后写入又成功时，
 * 需要把"数据损坏"这条**恢复显示**，而不是简单地隐藏整条警示条。
 * 数据已经丢了，不会因为后续写入成功而回来。
 */
let corruptionNoticeText: string | null = null;

/**
 * 嵌入降级编排（T052/T053）。
 *
 * 接在浏览器视图的加载事件上：`beginLoad` 记录一次新导航，`onFrameLoaded`/`onFrameFailed`
 * 与 Tier 2 心跳推进状态，状态到 `failed`/`suspected-blocked` 时由它自己把覆盖层挂上。
 */
const embedFallback = createEmbedFallbackCoordinator({
  onChanged(tabId, embedState, url): void {
    // 状态推进 → 重绘顶栏与底栏（嵌入能力会进入能力徽章）
    void url;
    if (tabId === tabs.getActiveTabId()) {
      render();
    }
  },

  actions: {
    onRetry(): void {
      const tab = tabs.getActiveTab();
      if (tab === null) {
        return;
      }
      tabs.setLoadState(tab.tabId, 'loading');
      navigateFrame(tab.tabId, tab.currentUrl);
    },

    onOpenInCurrentTab(): void {
      void openExternalFallback('current');
    },

    onOpenInNewTab(): void {
      void openExternalFallback('new');
    },

    onBackHome(): void {
      showView('site-list');
    },
  },
});

const browserView = createBrowserView({
  /**
   * [DONE] iframe 加载事件（Tier 1 可观测的唯一信号）。
   *
   * research R3：无 host 权限时读不到跨源 iframe 的 URL 与标题，因此这里只能确认
   * 「本标签完成了一次加载」；地址与标题继续沿用扩展自维护的历史值。
   * URL/标题的完整追踪依赖 Tier 2 content script（T054–T057）。
   */
  onFrameLoad(tabId: string): void {
    tabs.setLoadState(tabId, 'loaded');
    embedFallback.onFrameLoaded(tabId);
    render();
  },

  /**
   * 这里没有 error 分支，是刻意的。
   *
   * 实测（T059）：iframe 的导航失败不会触发 DOM error 事件 —— 浏览器在帧内渲染自己的错误页，
   * 宿主只看到一次 load。因此 Tier 1 无从判定失败，落到 pending（界面显示「地址可能未同步」）。
   * failed 状态留给能给出确凿证据的路径（embed-detection 的 markConfirmedFailure）。
   */
});

/** [DONE] 降级打开：在浏览器标签页中打开当前地址（spec FR-006） */
async function openExternalFallback(where: 'current' | 'new'): Promise<void> {
  const tab = tabs.getActiveTab();
  if (tab === null) {
    return;
  }
  try {
    await tabsApi.openExternal(tab.currentUrl, where);
    showToast(where === 'current' ? '已在当前标签页打开' : '已在新标签页打开');
  } catch {
    // 打开失败不改动侧栏内状态：用户仍可返回主页或复制地址
    showToast('打开失败，请在浏览器中手动打开该地址');
  }
}

const siteListView = createSiteListView({
  /** [DONE] 添加网址：先入列表，再在新标签打开（spec FR-004） */
  onAddUrl(rawInput: string): void {
    const added = sites.addFromUserInput(rawInput);
    if (added === null) {
      showToast('网址无效，未能添加');
      return;
    }
    siteListView.resetAddInput();
    const entryPoint = added.site.entryPoints[0];
    openUrlInNewTab(entryPoint === undefined ? added.site.originKey : entryPoint.url, added.site.originKey);
  },

  onOpenSite(site): void {
    const entryPoint = site.entryPoints[0];
    openUrlInNewTab(entryPoint === undefined ? site.originKey : entryPoint.url, site.originKey);
  },
});

const topBar = createTopBar({
  onFlipTheme(): void {
    theme.flipDayNight();
    render();
  },
});

const navBar = createNavBar({
  onBack(): void {
    stepHistory('back');
  },

  onForward(): void {
    stepHistory('forward');
  },

  onHome(): void {
    showView('site-list');
  },

  onOpenTabList(): void {
    sheets.openTabList(tabs.getTabs(), tabs.getActiveTabId());
  },

  onOpenMenu(): void {
    sheets.openGridMenu(tabs.getTabs().length, tabs.getActiveTab() !== null);
  },
});

sheets = createSheets({
  onActivateTab(tabId: string): void {
    tabs.activateTab(tabId);
    showView('browser');
    // 切到别的来源就要按该来源重算能力状态，否则徽章会沿用上一个站点（FR-038）
    refreshActiveCapabilities();
  },

  onCloseTab(tabId: string): void {
    closeTab(tabId);
  },

  onCloseAllTabs(): void {
    for (const tab of tabs.getTabs()) {
      closeTab(tab.tabId);
    }
  },

  onNewTab(): void {
    showView('site-list');
  },

  onShowSiteList(): void {
    showView('site-list');
  },

  onToggleTheme(): void {
    theme.flipDayNight();
    render();
  },

  onOpenSiteSettings(): void {
    openSiteSettingsPanel();
  },

  onClosed(): void {
    // 面板关闭即清空记录（终审 D2）：否则后续异步回调会去重绘一个已消失、且属于旧来源的面板
    forgetOpenSettingsPanel();
  },
});

showToast = createToast();

/**
 * [DONE] 图标子菜单控制器（全局单实例，T071）。
 *
 * 四类上下文共用它：标签页项 / 导航区 / 网站条目 / 站点设置钮。
 * 单实例是契约要求（ui-states.md「触摸环境一次只能打开一个菜单」）。
 */
const iconMenu = createIconMenu({ container: appRoot });

/**
 * [DONE] 为「标签页项」上下文菜单接线（菜单项严格按 ui-states.md 表格）。
 *
 * 标签列表每次刷新都会重建行元素，因此要重新接线；旧元素的监听器随元素一起被丢弃，
 * 但状态机里的触发器登记需要显式撤销，否则 id 表会随刷新无限增长。
 */
function wireTabRowMenus(list: TabList): void {
  for (const tab of tabs.getTabs()) {
    const moreButton = list.moreButtonFor(tab.tabId);
    const row = list.rowElementFor(tab.tabId);
    if (moreButton === null || row === null) {
      continue;
    }
    /**
     * 文案与图标取自 context-menu-spec.ts（契约的单一来源），这里只提供动作。
     * 解构顺序与 spec 一致，日后插入菜单项时不会错位。
     */
    const [refreshItem, copyItem, openExternalItem, closeItem] = TAB_ENTRY_MENU_ITEMS;
    iconMenu.attach(
      moreButton,
      () => [
        { ...asIconItem(refreshItem), onSelect: () => refreshTab(tab.tabId) },
        {
          ...asIconItem(copyItem),
          onSelect: () => {
            void copyToClipboard(tab.currentUrl);
          },
        },
        {
          ...asIconItem(openExternalItem),
          onSelect: () => {
            void tabsApi.openExternal(tab.currentUrl, 'new').then(
              () => showToast('已在普通标签页打开'),
              () => showToast('打开失败，请手动复制地址'),
            );
          },
        },
        { ...asIconItem(closeItem), onSelect: () => closeTab(tab.tabId) },
      ],
      row,
    );
  }
}

/** [DONE] 复制文本到剪贴板；失败时如实提示（不让用户以为复制成功） */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制网址');
  } catch {
    // 剪贴板权限被拒或非安全上下文：如实说明并把内容展示出来供手工复制
    showToast(`复制失败：${text}`);
  }
}

/** [DONE] 刷新某标签：重新载入当前地址并重置嵌入检测 */
function refreshTab(tabId: string): void {
  const tab = tabs.getTab(tabId);
  if (tab === null) {
    return;
  }
  tabs.setLoadState(tabId, 'loading');
  navigateFrame(tabId, tab.currentUrl);
  browserView.flashReload();
}

/**
 * [DONE] 为「导航区」上下文菜单接线（ui-states.md：前进、后退、刷新、复制当前网址）。
 *
 * 挂在底栏的前进/后退键上：这两个键本身是主操作（前进/后退），
 * 因此菜单锚点用**所在容器**（底栏）而不是按钮元素 —— 与标签项的 ⋮ 不同，
 * 底栏按钮没有多余的 ⋮ 可用，触屏长按/悬停整条底栏即出菜单。
 */
function wireNavigationMenu(): void {
  for (const [buttonId, itemsBuilder] of [
    ['navForward', (): IconMenuItem[] => navItems()],
    ['navBack', (): IconMenuItem[] => navItems()],
  ] as const) {
    const button = document.getElementById(buttonId);
    if (button === null) {
      continue;
    }
    iconMenu.attach(button, itemsBuilder, button);
  }
}

/**
 * [DONE] 把契约条目转成可接线的菜单项（补上动作）。
 *
 * 用展开而不是逐个手写 icon/label：文案一旦改动只需改 spec，
 * 这里不会出现第二份副本随时间漂移。
 */
function asIconItem(spec: ContextMenuItemSpec | undefined): Omit<IconMenuItem, 'onSelect'> {
  if (spec === undefined) {
    // 类型上不会发生；运行时兜底，避免单个菜单项缺失导致整份菜单崩掉
    return { icon: 'more', label: '未知操作' };
  }
  return {
    icon: spec.icon,
    label: spec.label,
    ...(spec.danger === true ? { danger: true } : {}),
  };
}

/** [DONE] 导航区菜单项（顺序与文案取自 context-menu-spec，即 ui-states.md 表格） */
function navItems(): IconMenuItem[] {
  const tab = tabs.getActiveTab();
  const [forwardItem, backItem, refreshItem, copyItem] = NAVIGATION_MENU_ITEMS;
  return [
    {
      ...asIconItem(forwardItem),
      onSelect: () => {
        stepHistory('forward');
      },
    },
    {
      ...asIconItem(backItem),
      onSelect: () => {
        stepHistory('back');
      },
    },
    {
      ...asIconItem(refreshItem),
      onSelect: () => {
        if (tab !== null) {
          refreshTab(tab.tabId);
        }
      },
    },
    {
      ...asIconItem(copyItem),
      onSelect: () => {
        if (tab !== null) {
          void copyToClipboard(tab.currentUrl);
        }
      },
    },
  ];
}

/**
 * [DONE] 为「网站条目」上下文菜单接线（ui-states.md：打开、编辑名称、删除、切换移动/桌面、授权设置）。
 */
function wireSiteItemMenus(): void {
  for (const site of sites.getSites()) {
    const anchors = siteListView.anchorsFor(site.originKey);
    if (anchors === null) {
      continue;
    }
    const [openItem, renameItem, deleteItem, toggleModeItem, grantItem] = SITE_ENTRY_MENU_ITEMS;
    iconMenu.attach(
      anchors.moreButton,
      () => [
        {
          ...asIconItem(openItem),
          onSelect: () => {
            const entryPoint = site.entryPoints[0];
            openUrlInNewTab(entryPoint === undefined ? site.originKey : entryPoint.url, site.originKey);
          },
        },
        {
          ...asIconItem(renameItem),
          onSelect: () => {
            startRenameSite(site.originKey);
          },
        },
        {
          ...asIconItem(deleteItem),
          onSelect: () => {
            if (sites.removeSite(site.originKey)) {
              showToast('已删除该网站');
              render();
            }
          },
        },
        {
          ...asIconItem(toggleModeItem),
          onSelect: () => {
            const next = siteSettings.getDisplayMode(site.originKey) === 'mobile' ? 'desktop' : 'mobile';
            setDisplayModeFor(site.originKey, next);
          },
        },
        {
          ...asIconItem(grantItem),
          onSelect: () => {
            openSettingsFor(site.originKey);
          },
        },
      ],
      anchors.item,
    );
  }
}

/**
 * [DONE] 网站名称的原地编辑（「编辑名称」菜单项）。
 *
 * 用浏览器的原生 prompt 而不是自绘输入框：本切片的职责是菜单接线，
 * 重命名 UI 的完整形态（内联输入 + 校验 + Esc 取消）属后续打磨，
 * 而 prompt 已能满足"改个名字"的实际需求且不引入新的可访问性面。
 */
function startRenameSite(originKey: string): void {
  const site = sites.getSite(originKey);
  if (site === null) {
    return;
  }
  const next = window.prompt('编辑网站名称', site.title);
  if (next === null) {
    return;
  }
  // 空名称由状态层拒绝（返回 false），这里不重复校验规则
  if (sites.renameSite(originKey, next)) {
    showToast('已重命名');
    render();
  }
}

/** [DONE] 为指定来源打开站点设置面板（供网站条目菜单与底栏菜单复用） */
function openSettingsFor(originKey: string): void {
  openSiteSettingsPanel(originKey);
}

/**
 * [DONE] 为「站点设置钮」接线（ui-states.md：移动/桌面切换、真实移动 UA 开关、登录复用开关、能力状态说明）。
 *
 * 这四项与设置面板里的控件是同一批能力，因此菜单项直接复用面板的操作函数 ——
 * 两处各写一份开关逻辑必然漂移（例如一处记得回弹、另一处忘了）。
 */
/**
 * [DONE] 为「站点设置钮」接线（ui-states.md：移动/桌面切换、真实移动 UA 开关、登录复用开关、能力状态说明）。
 *
 * **触发方式的设计取舍**：顶栏按 MASTER.md §2 只放网址栏 + 翻转钮，没有第三个图标位可用，
 * 因此"站点设置钮"复用网址栏本身作为触发器：**点击网址栏**即弹出站点设置菜单
 * （其主行为"显示当前地址"已由文本呈现，不存在语义冲突）。
 *
 * 之前把它挂在翻转钮上但锚点是网址栏 —— 那是个真实缺陷：悬停网址栏能出菜单（锚点生效），
 * 但点击网址栏不会触发翻转钮的 click（触发器是另一个元素），于是**触摸通道完全不可用**
 * （触摸设备没有 hover，唯一的入口就断了）。现在两者统一为网址栏。
 */
function wireSiteSettingsMenu(): void {
  const urlBar = document.getElementById('urlBar');
  if (urlBar === null) {
    return;
  }
  iconMenu.attach(
    urlBar,
    () => {
      const originKey = activeOriginKey();
      const [modeItem, uaItem, cookieItem, capabilityItem] = SITE_SETTINGS_MENU_ITEMS;
      return [
        {
          ...asIconItem(modeItem),
          onSelect: () => {
            if (originKey !== null) {
              const next = siteSettings.getDisplayMode(originKey) === 'mobile' ? 'desktop' : 'mobile';
              setDisplayModeFor(originKey, next);
            }
          },
        },
        {
          ...asIconItem(uaItem),
          onSelect: () => {
            if (originKey !== null) {
              openSiteSettingsPanel(originKey);
            }
          },
        },
        {
          ...asIconItem(cookieItem),
          onSelect: () => {
            if (originKey !== null) {
              openSiteSettingsPanel(originKey);
            }
          },
        },
        {
          ...asIconItem(capabilityItem),
          onSelect: () => {
            if (originKey !== null) {
              openSiteSettingsPanel(originKey);
            }
          },
        },
      ];
    },
    urlBar,
  );
}

/**
 * [DONE] 向后台查询某来源的能力状态并写入缓存。
 *
 * 为什么必须问后台：能力状态取决于 `permissions.contains` 的实时结果，而权限 API 只在后台
 * 可用。侧栏不能自己推断 —— 若在本地臆测，就会出现「权限已被外部撤销但界面仍显示可用」
 * 这种 FR-030 明确禁止的情况。
 *
 * 查询失败按「未授权」处理：宁可显示降级，也不能显示一个可能不成立的成功态（FR-029）。
 */
async function refreshCapabilities(originKey: string): Promise<CapabilityState> {
  const message = { type: 'capabilities.query', payload: { originKey } };
  const validation = validateRuntimeMessage(message);
  if (!validation.ok) {
    // 形状错误属编程缺陷；退回保守默认而不是抛出（侧栏不能因一处失败而不可用）
    return createCapabilityState();
  }

  try {
    const response = await runtimeApi.sendMessage(message);
    const parsed = parseCapabilityResponse(response);
    if (parsed !== null) {
      capabilityCache.set(originKey, parsed);
      return parsed;
    }
  } catch {
    // 后台不可达（SW 正在启动、扩展重载中）：保留上一次已知状态，没有则用保守默认
  }

  return capabilityCache.get(originKey) ?? createCapabilityState();
}

/**
 * [DONE] 解析后台的能力状态响应。
 *
 * 不信任发送方（宪法：消息两端必须校验形状），字段非预期时返回 null 由调用方回落。
 */
function parseCapabilityResponse(response: unknown): CapabilityState | null {
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const envelope = response as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) {
    return null;
  }
  const data = envelope.data as Partial<CapabilityState>;
  const uaValues = ['unknown', 'unauthorized', 'active', 'degraded', 'failed', 'unsupported'];
  const cookieValues = ['unknown', 'unauthorized', 'available', 'absent', 'limited', 'failed'];
  const navValues = ['tracked', 'partial', 'uncertain'];
  const embedValues = ['ok', 'suspected-blocked', 'failed', 'unknown'];
  if (
    typeof data.ua !== 'string' ||
    !uaValues.includes(data.ua) ||
    typeof data.cookie !== 'string' ||
    !cookieValues.includes(data.cookie) ||
    typeof data.navigation !== 'string' ||
    !navValues.includes(data.navigation) ||
    typeof data.embed !== 'string' ||
    !embedValues.includes(data.embed)
  ) {
    return null;
  }
  return {
    ua: data.ua as CapabilityState['ua'],
    cookie: data.cookie as CapabilityState['cookie'],
    navigation: data.navigation as CapabilityState['navigation'],
    embed: data.embed as CapabilityState['embed'],
  };
}

/** [DONE] 当前活动标签的来源键；无标签或来源未知时返回 null */
function activeOriginKey(): string | null {
  const tab = tabs.getActiveTab();
  return tab === null ? null : tab.originKey;
}

/** [DONE] 该来源的显示模式（默认移动，spec FR-007/FR-008） */
function displayModeOf(originKey: string | null): DisplayMode {
  if (originKey === null) {
    return 'mobile';
  }
  return siteSettings.getDisplayMode(originKey);
}

/**
 * 当前打开的设置面板（终审 D2：必须连同**所属来源**一起记）。
 *
 * 原先只记面板实例，于是"这个面板是哪个来源的"无从判断，异步回调（能力刷新、授权返回）
 * 重绘时用的是回调自带的 originKey —— 若用户已经切到别的站点并打开新面板，旧回调就把
 * 新面板的内容改写成旧来源的状态（串源）。因此这里把两者绑成一个记录，重绘前必须比对。
 */
let openSettingsPanel: { panel: SiteSettingsPanel; originKey: string; displayName: string } | null = null;

/** [DONE] 关闭当前设置面板的记录（弹层关闭时调用，终审 D2） */
function forgetOpenSettingsPanel(): void {
  openSettingsPanel = null;
  panelsRenderers.clear();
}

/** [DONE] 当前面板是否属于该来源（不是则不得重绘，避免串源） */
function panelBelongsTo(originKey: string): boolean {
  return openSettingsPanel !== null && openSettingsPanel.originKey === originKey;
}

/**
 * [DONE] 把本地可知的追踪/嵌入状态叠加到后台返回的能力状态上。
 *
 * 分工：后台掌握**权限层面**的事实（UA/Cookie），侧栏掌握**追踪层面**的事实（是否真的收到过
 * Tier 2 上报、iframe 是否疑似被拦截）。两者只有合起来才是完整的能力状态，因此在这里合并。
 *
 * 关键：侧栏的本地观测是**更强的证据**，优先于后台的保守默认值 —— 后台无从知道某个具体标签
 * 是否收到过上报，只能给 `uncertain`；而侧栏确实收到了就应该升级为 `tracked`（T059/FR-021）。
 */
function withLocalTrackingState(state: CapabilityState, tracked: boolean, embedState: CapabilityState['embed']): CapabilityState {
  return {
    ...state,
    // 收到过该来源的 Tier 2 上报 → 导航是可追踪的；否则如实保持不确定
    navigation: tracked ? 'tracked' : state.navigation,
    // 嵌入状态以本地检测器为准（它观察的是真实 iframe 事件）
    embed: embedState !== 'unknown' ? embedState : state.embed,
  };
}

/** [DONE] 嵌入检测状态到能力状态的映射（本地观测语义 → data-model §6 取值） */
function embedCapabilityFrom(localState: ReturnType<typeof embedFallback.stateOf>): CapabilityState['embed'] {
  switch (localState) {
    case 'ok': {
      return 'ok';
    }
    case 'failed': {
      return 'failed';
    }
    case 'suspected-blocked': {
      return 'suspected-blocked';
    }
    case 'pending':
    case 'unknown':
    case 'idle':
    default: {
      // Tier 1 的诚实答案：加载已发生但结果不可确认，不据此声称任何结论
      return 'unknown';
    }
  }
}

/** [DONE] 组装设置面板的渲染输入 */
function buildSettingsPanelState(originKey: string, displayName: string) {
  const tracked = trackedOrigins.has(originKey);
  const activeTab = tabs.getActiveTab();
  const embedState = activeTab !== null && activeTab.originKey === originKey
    ? embedCapabilityFrom(embedFallback.stateOf(activeTab.tabId))
    : ('unknown' as const);

  const base = capabilityCache.get(originKey) ?? createCapabilityState();

  return {
    originKey,
    displayName,
    displayMode: siteSettings.getDisplayMode(originKey),
    uaGrant: siteSettings.getGrant(originKey, 'ua'),
    cookieGrant: siteSettings.getGrant(originKey, 'cookie'),
    capabilities: withLocalTrackingState(base, tracked, embedState),
    uaToggle: uaToggleStateFor(siteSettings.getGrant(originKey, 'ua'), uaGrantPending),
    notice: settingsNotice,
  };
}

/**
 * [DONE] 打开当前活动标签所属站点的设置面板。
 *
 * 打开前先向后台查询能力状态 —— 面板必须显示**当前真实**的授权与能力情况，
 * 用缓存里的旧状态会让用户在权限被撤销后仍看到「可用」（FR-030）。
 */
function openSiteSettingsPanel(explicitOriginKey?: string): void {
  const originKey = explicitOriginKey ?? activeOriginKey();
  if (originKey === null || originKey === undefined) {
    return;
  }

  const site = sites.getSite(originKey);
  const displayName = site === null ? originKey : site.title;
  const panel = createSiteSettingsPanel(buildSettingsPanelState(originKey, displayName), {
    onSetDisplayMode(mode: DisplayMode): void {
      setDisplayModeFor(originKey, mode);
    },

    onEnableUaGrant(): void {
      void requestUaGrant(originKey);
    },

    onDisableUaGrant(): void {
      void revokeGrant(originKey, 'ua');
    },

    onEnableCookieGrant(): void {
      void requestGrantAndReport(originKey, 'cookie');
    },

    onDisableCookieGrant(): void {
      void revokeGrant(originKey, 'cookie');
    },
  });

  openSettingsPanel = { panel, originKey, displayName };
  registerPanelRenderer(originKey, displayName);
  sheets.openCustomPanel(panel.element(), `${displayName} 的站点设置`);

  void refreshCapabilities(originKey).then(() => {
    redrawSettingsPanel(originKey, displayName);
  });
}

/**
 * [DONE] 原地重绘已打开的设置面板（权限对话框返回、能力状态刷新后）。
 *
 * **必须先确认面板属于该来源**（终审 D2）：面板是用户的界面，来源是数据的归属。
 * 不比对就会串源 —— 用户切到 B 站点后，A 站点的异步回调把 B 的面板改写成 A 的状态，
 * 界面显示的东西与它标着的那一行不对应，用户据此点开关就会改错站点。
 */
function redrawSettingsPanel(originKey: string, displayName: string): void {
  if (!panelBelongsTo(originKey) || openSettingsPanel === null) {
    return;
  }
  openSettingsPanel.panel.render(buildSettingsPanelState(originKey, displayName));
}

/**
 * 面板重绘器的登记表：让异步回调能在面板仍打开时刷新它。
 *
 * 只登记**当前打开的那个来源**（终审 D2）：原先按来源键登记多个且从不清理，
 * 关闭面板后那些回调仍会触发 —— 它们指向已不在 DOM 里的面板，还会与当前面板争抢重绘。
 */
const panelsRenderers = new Map<string, () => void>();

/** [DONE] 为当前打开的面板登记重绘器（只保留这一个来源，关闭时清空） */
function registerPanelRenderer(originKey: string, displayName: string): void {
  panelsRenderers.clear();
  panelsRenderers.set(originKey, () => {
    redrawSettingsPanel(originKey, displayName);
  });
}

/**
 * [DONE] 若该来源的设置面板正开着，就地刷新它（终审 D2 的统一入口）。
 *
 * 所有异步回调都必须走这里，而不是直接 `panelsRenderers.get(...)`：登记表里只剩当前
 * 打开的那个来源，但**调用方仍可能拿着旧来源键**（例如一次授权请求返回时用户已经切走）。
 * 由这个函数统一比对，调用点就不必各自记得防串源。
 */
function refreshOpenSettingsPanel(originKey: string): void {
  if (!panelBelongsTo(originKey)) {
    return;
  }
  panelsRenderers.get(originKey)?.();
}

/**
 * [DONE] 切换某来源的显示模式并立即重载受影响的活动标签。
 *
 * 只改这一条来源的设置（FR-038），但当前标签的版面必须立刻体现，否则用户会以为没生效。
 */
function setDisplayModeFor(originKey: string, mode: DisplayMode): void {
  if (!siteSettings.setDisplayMode(originKey, mode)) {
    return;
  }

  const activeTab = tabs.getActiveTab();
  if (activeTab !== null && activeTab.originKey === originKey) {
    // 重绘会经 syncTabs → applyDisplayMode 应用新模式；再加载一次让站点按新断点重排
    render();
    navigateFrame(activeTab.tabId, activeTab.currentUrl);
    browserView.flashReload();
  } else {
    render();
  }

  const site = sites.getSite(originKey);
  refreshOpenSettingsPanel(originKey);
  showToast(mode === 'desktop' ? '已切换为桌面版面' : '已切换为移动视口');
  void site;
}

/**
 * [DONE] 申请某项授权（UA 或 Cookie），并在面板上如实呈现结果。
 *
 * 申请前把开关置为 pending 并重绘：权限对话框可能被用户放一会儿，期间界面要禁用交互，
 * 否则连点会叠加多个申请。
 */
async function requestGrantAndReport(originKey: string, kind: 'ua' | 'cookie'): Promise<void> {
  if (kind === 'ua') {
    uaGrantPending = true;
    refreshOpenSettingsPanel(originKey);
  }

  const currentSettings = siteSettings.getSettings(originKey);
  const response = await sendGrantMessage('permissions.request-grant', {
    originKey,
    grant: kind,
    settings: currentSettings,
  });

  if (kind === 'ua') {
    uaGrantPending = false;
  }

  if (response === null) {
    settingsNotice = '权限申请未能完成，已使用降级模式';
    await afterGrantChange(originKey, kind);
    return;
  }

  // 后台已把最新标记写回存储；这里同步到侧栏的设置状态，保持两侧一致
  applySettingsFromResponse(originKey, response);

  settingsNotice = noticeForOutcome(response.granted ? 'granted' : (response.reason ?? 'denied'));
  if (response.granted) {
    showToast(kind === 'ua' ? '已开启真实移动 UA' : '已开启登录状态复用');
  } else if (settingsNotice !== null) {
    showToast(settingsNotice);
  }

  await afterGrantChange(originKey, kind);
}

/** [DONE] 撤销某项授权的入口（含 UI 提示） */
async function revokeGrant(originKey: string, kind: 'ua' | 'cookie'): Promise<void> {
  const response = await sendGrantMessage('permissions.revoke-grant', {
    originKey,
    grant: kind,
  });

  if (response !== null) {
    applySettingsFromResponse(originKey, response);
  }

  settingsNotice = null;
  showToast(kind === 'ua' ? '已关闭真实移动 UA' : '已关闭登录状态复用');
  await afterGrantChange(originKey, kind);
}

/**
 * [DONE] 授权变化后的统一收尾：刷新能力状态 + 重绘面板 + 按新状态重载活动标签。
 *
 * **两项授权都要重载当前页**（FR-013 的"即时生效"语义）：
 * - UA 变更后不重载，页面仍是按旧 UA 渲染的那一份，用户会以为没生效；
 * - Cookie 授权变更后同理 —— 撤销后需要让页面回到"没有该来源凭据"的状态，
 *   否则界面上徽章已显示未授权、页面却仍带着登录态，两者自相矛盾。
 */
async function afterGrantChange(originKey: string, kind: 'ua' | 'cookie'): Promise<void> {
  await refreshCapabilities(originKey);
  refreshOpenSettingsPanel(originKey);

  const activeTab = tabs.getActiveTab();
  if (activeTab !== null && activeTab.originKey === originKey) {
    navigateFrame(activeTab.tabId, activeTab.currentUrl);
    browserView.flashReload();
  }
  void kind;
}

/** 后台授权响应的形状（只取我们确实需要的字段） */
interface GrantResponseShape {
  granted: boolean;
  reason?: 'denied' | 'unsupported';
  state: CapabilityState;
}

/**
 * [DONE] 发送授权类消息并解析响应。
 *
 * 响应必须校验形状（不信任发送方）；失败返回 null，由调用方按降级路径处理。
 */
async function sendGrantMessage(
  type: 'permissions.request-grant' | 'permissions.revoke-grant',
  payload: Record<string, unknown>,
): Promise<GrantResponseShape | null> {
  const message = { type, payload };
  if (!validateRuntimeMessage(message).ok) {
    return null;
  }

  try {
    const response = await runtimeApi.sendMessage(message);
    if (typeof response !== 'object' || response === null) {
      return null;
    }
    const envelope = response as { ok?: unknown; data?: unknown };
    if (envelope.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) {
      return null;
    }
    const data = envelope.data as { granted?: unknown; reason?: unknown; state?: unknown };
    const state = parseCapabilityResponse({ ok: true, data: data.state });
    if (state === null) {
      return null;
    }
    return {
      granted: data.granted === true,
      ...(data.reason === 'denied' || data.reason === 'unsupported' ? { reason: data.reason } : {}),
      state,
    };
  } catch {
    return null;
  }
}

/** [DONE] 把后台返回的能力状态与授权标记同步回侧栏状态 */
function applySettingsFromResponse(originKey: string, response: GrantResponseShape): void {
  capabilityCache.set(originKey, response.state);
  // 后台已按复核结果修正了标记，以它为准（含外部撤销后回归 revoked 的情况，FR-030）
  syncGrantFromState(originKey, response.state);
}

/**
 * [DONE] 依据能力状态反推授权标记。
 *
 * `unauthorized` 说明权限已不成立，此时标记应为未授权 —— 无论此前用户开过什么。
 * 这条规则保证侧栏显示的开关状态与真实权限始终一致（FR-030）。
 */
function syncGrantFromState(originKey: string, state: CapabilityState): void {
  if (state.ua === 'unauthorized' && siteSettings.getGrant(originKey, 'ua') === 'granted') {
    siteSettings.setGrant(originKey, 'ua', 'revoked');
  }
  if (state.cookie === 'unauthorized' && siteSettings.getGrant(originKey, 'cookie') === 'granted') {
    siteSettings.setGrant(originKey, 'cookie', 'revoked');
  }
}

/** [DONE] 请求开启 UA 授权（带 pending 状态的薄封装） */
async function requestUaGrant(originKey: string): Promise<void> {
  settingsNotice = null;
  await requestGrantAndReport(originKey, 'ua');
}

/**
 * [DONE] 沿扩展历史栈前进/后退，并用重新加载兑现导航（spec FR-022）。
 *
 * 为什么是重新加载而不是操作 iframe 的 history：侧栏读不到跨源 iframe 的历史，
 * 无法知道它当前停在哪一条，因此以扩展自维护的历史位置为唯一真相，加载对应 URL。
 */
function stepHistory(direction: 'back' | 'forward'): void {
  const tab = tabs.getActiveTab();
  if (tab === null) {
    return;
  }
  const moved = direction === 'back' ? tabs.goBack(tab.tabId) : tabs.goForward(tab.tabId);
  if (moved === null) {
    return;
  }
  navigateFrame(moved.tabId, moved.currentUrl);
  browserView.flashReload();
  // 历史位置变化会改变后退/前进的可用性，必须重绘底栏，否则按钮状态停留在切换前
  render();
}

/**
 * [DONE] 让某标签的 iframe 载入地址，并同步开始一次嵌入检测。
 *
 * **所有导航都必须经此函数**（而非直接调 `browserView.loadTab`）：嵌入检测需要知道
 * "这是一次新的加载"，否则旧一轮的挂起超时会把新一轮误判为被拦截。
 * 收敛到一处也避免将来新增导航入口时漏掉检测重置。
 */
function navigateFrame(tabId: string, url: string): void {
  const tab = tabs.getTab(tabId);
  embedFallback.beginLoad(tabId, url, isOriginTracked(tab?.originKey ?? null));
  browserView.loadTab(tabId, url);
}

/**
 * [DONE] 关闭标签：状态层移除后**立即落盘**。
 *
 * 立即落盘的理由（spec FR-016）：若只在防抖窗口内排队，用户关掉标签马上关闭浏览器时，
 * 已关闭的标签会在下次启动被恢复回来，直接违反「关闭不随重启恢复」。
 */
function closeTab(tabId: string): void {
  const outcome = tabs.closeTab(tabId);
  if (!outcome.closed) {
    return;
  }

  /**
   * 释放该标签在嵌入检测器里的残留（终审 [建议修改]）。
   *
   * 不调用就会按"曾经打开过的标签数"无界增长：检测器的每标签状态与**挂起的定时器**
   * 都留在原处。定时器尤其要紧 —— 它持有回调并可能在标签早已关闭后触发。
   *
   * 注：后台 `frame-report.ts` 的 `forgetTab` 无法在这里接线。后台的归属键是**来源键**
   * （后台不持有标签表，见 background/index.ts 的说明），从侧栏按 tabId 调用既拿不到实例，
   * 也会串到同来源的其它标签；那条记录的上界是"曾上报过的来源数"，随网站列表而非标签数增长。
   */
  embedFallback.dispose(tabId);

  void persistence.persistImmediately().then(reportPersistence);

  if (outcome.remaining === 0) {
    // 最后一个标签关闭后弹层里的列表已经失效，先收起再回主页
    sheets.close();
    showView('site-list');
    return;
  }

  render();
  sheets.refreshTabList(tabs.getTabs(), tabs.getActiveTabId());
}

/** [DONE] 打开网址：记录访问 + 新建标签 + 切到浏览视图（spec FR-004） */
function openUrlInNewTab(url: string, originKey: string): void {
  const opened = tabs.openTab(url);
  if (opened === null) {
    showToast('这个地址无法在侧栏中打开');
    return;
  }
  sites.markVisited(originKey);
  // 新标签的 iframe 由 render → syncTabs 创建并载入；这里先登记一次加载，
  // 使嵌入检测从第一帧起就生效（否则首次加载不会被跟踪）
  embedFallback.beginLoad(opened.tabId, opened.currentUrl, isOriginTracked(opened.originKey));
  showView('browser');
  // 新来源可能带来不同的授权与能力情况，按该来源现算一次（FR-038）
  refreshActiveCapabilities();
}

/** [DONE] 视图切换：同一时刻只显示一个视图（spec FR-025） */
function showView(name: ViewName): void {
  // 浏览视图但无标签时无可显示内容，回落到主页（ui-states.md §空态）
  currentView = name === 'browser' && tabs.getActiveTab() === null ? 'site-list' : name;
  render();
}

/** [DONE] 全量重绘当前视图的可见部分；状态变更后统一调用 */
function render(): void {
  const activeTab = tabs.getActiveTab();
  // 浏览视图必须有活动标签：无标签时回落主页，避免出现空白内容区
  const atHome = currentView === 'site-list' || activeTab === null;

  if (atHome) {
    siteListSection.hidden = false;
    browserSection.hidden = true;
    siteListView.render(sites.getSites());
    // 上一次渲染的行元素已被替换，其接线必须释放（否则表随重绘轮数无界增长）
    iconMenu.pruneDetached();
    // 网站条目刚重建，重新为每个 ⋮ 挂上下文菜单（菜单需要真实元素作锚点）
    wireSiteItemMenus();
    // 离开浏览视图时撤下覆盖层：它挂在内容区，留着会随视图隐现而错位
    embedFallback.setActiveTab(null);
    // 视图切换时关掉可能开着的菜单：锚点元素已隐藏，菜单留着会浮在空处
    iconMenu.close();
  } else {
    siteListSection.hidden = true;
    browserSection.hidden = false;
    // 显示模式按标签各自的来源解析：同一侧栏里不同来源可以有不同模式（FR-038）
    browserView.syncTabs(tabs.getTabs(), (tab) => displayModeOf(tab.originKey));
    browserView.showTab(activeTab.tabId);
    // 覆盖层只服务活动标签，由协调器按该标签的嵌入状态自行决定显示与否
    embedFallback.setActiveTab(activeTab.tabId);
  }
  appRoot.setAttribute('data-view', atHome ? 'site-list' : 'browser');

  topBar.render(buildTopBarState(atHome, activeTab), theme.isNight());

  navBar.render({
    inBrowserView: !atHome,
    canGoBack: activeTab === null ? false : tabs.canGoBack(activeTab.tabId),
    canGoForward: activeTab === null ? false : tabs.canGoForward(activeTab.tabId),
    tabCount: tabs.getTabs().length,
  });
}

/**
 * [DONE] 该来源是否处于 Tier 2 追踪（已授权且有 content script）。
 *
 * 用途：决定嵌入检测是否等待心跳。无授权时等不到心跳是必然的，
 * 据此判定「疑似被拦截」就是把不确定说成失败（FR-021/FR-029）。
 */
function isOriginTracked(originKey: string | null): boolean {
  if (originKey === null) {
    return false;
  }
  const settings = siteSettings.getSettings(originKey);
  // UA 或 Cookie 任一授权即持有该来源的 host 权限，Tier 2 才有注入前提
  return settings.uaGrant === 'granted' || settings.cookieGrant === 'granted';
}

/**
 * [DONE] 活动标签变化时刷新该来源的能力状态。
 *
 * 在切换标签/导航后调用：能力状态是**按来源现算**的运行时值，切到新来源就必须重新查询，
 * 否则会沿用上一个来源的徽章（FR-038 禁止跨来源串用设置与状态）。
 */
function refreshActiveCapabilities(): void {
  const originKey = activeOriginKey();
  if (originKey === null) {
    return;
  }
  void refreshCapabilities(originKey).then(() => {
    refreshOpenSettingsPanel(originKey);
    render();
  });
}

/**
 * [DONE] 顶栏的「地址可能未同步」判定（T059，spec FR-021）。
 *
 * 何时为真：处于浏览视图、**该来源未被 Tier 2 追踪**（因而地址栏显示的是扩展自维护的历史值，
 * 与页面实际内容可能已经不一致），且已有过至少一次加载。
 *
 * "被追踪"的判据是两个条件的**并集**：
 * - 该来源已授权（有 host 权限，content script 有注入前提）；
 * - 或侧栏确实收到过该来源的上报（更直接的证据）。
 *
 * 第二个条件单独成立即可撤下徽章：收到上报就说明追踪真的在跑，比"应该能跑"可信。
 */
function isAddressUncertain(activeTab: BrowserTab, tracked: boolean): boolean {
  if (tracked) {
    return false;
  }
  // 尚未开始加载时没什么可"不确定"的
  return activeTab.loadState !== 'idle';
}

/** [DONE] 该来源是否处于 Tier 2 追踪（授权或因收到过上报） */
function isOriginTier2(originKey: string | null): boolean {
  if (originKey === null) {
    return false;
  }
  return trackedOrigins.has(originKey) || isOriginTracked(originKey);
}

/** [DONE] 组装顶栏渲染输入 */
function buildTopBarState(atHome: boolean, activeTab: BrowserTab | null): TopBarState {
  if (atHome || activeTab === null) {
    return { atHome: true, title: '', titleHint: '', addressMaybeStale: false };
  }
  const tracked = isOriginTier2(activeTab.originKey);
  return {
    atHome: false,
    title: activeTab.title ?? activeTab.currentUrl,
    titleHint: activeTab.currentUrl,
    addressMaybeStale: isAddressUncertain(activeTab, tracked),
  };
}

/** [DONE] 存储失败时提示会话可能无法完整恢复（spec FR-032）；成功则撤下提示 */
/**
 * [DONE] 写入结果 → 顶部警示条（spec FR-032）。
 *
 * 两类提示共用这条警示条，因此必须记住"当前应该显示哪一条"，而不是简单地隐藏/显示：
 * - 写入失败 → 「会话可能无法完整恢复：存储写入失败」；
 * - 写入恢复成功 → 撤下写入类提示，但若仍有"数据损坏"，要**恢复显示那一条**。
 *
 * 之前的实现只在 `corruptionNoticeShown` 为假时才 hide()，结果成功写入后
 * 「写入失败」的文案会一直留在屏幕上 —— 明明已经写成功了却还在说失败，同样是不实陈述。
 */
function reportPersistence(result: SaveResult | null): void {
  if (result === null) {
    return;
  }
  if (result.persisted) {
    if (corruptionNoticeText !== null) {
      noticeBar.show(corruptionNoticeText);
    } else {
      noticeBar.hide();
    }
    return;
  }
  noticeBar.show('会话可能无法完整恢复：存储写入失败');
}

/** [DONE] 启动流程：恢复会话 → 订阅变更 → 首次渲染 */
async function start(): Promise<void> {
  // 降级覆盖层的挂载点：内容区（每标签的 iframe 宿主也在其中，覆盖层后挂即在上层）
  embedFallback.mountOverlay(browserView.contentElement());

  /**
   * 订阅写入结果（FR-032）。
   *
   * 必须在恢复**之前**订阅：恢复失败与后续任何一次写入失败都要能拉起警示条，
   * 而自动保存一旦启动就可能立刻触发防抖写入。
   * 成功结果同样送达 —— `reportPersistence` 用它撤下警示条。
   */
  persistence.onWriteResult((result) => {
    reportPersistence(result);
  });

  /**
   * 订阅后台与 content script 的消息（Tier 2 追踪，T054/T057）。
   *
   * **必须把返回值传回去**：`frame.open-request` 靠这个返回值告诉 content script
   * 「侧栏已经接手了，不用再退回落普通标签页」。返回 undefined 会被理解成"没人处理"，
   * 于是同一次点击开两个标签页（终审 D1）。
   */
  runtimeApi.onMessage((message: unknown) => handleRuntimeMessage(message));

  /**
   * 接线四类上下文菜单（T071）。
   *
   * 标签列表每次渲染都会重建行元素，因此它的菜单在**锚点回调**里逐次重挂；
   * 导航区与站点设置钮的元素是静态的，装一次即可。
   */
  sheets.setTabListAnchorSink((list) => {
    // 标签列表每次刷新都会重建行元素：先释放上一批已脱离文档的接线，再为新行接线
    iconMenu.pruneDetached();
    wireTabRowMenus(list);
  });
  wireNavigationMenu();
  wireSiteSettingsMenu();

  const summary = await persistence.restore();
  persistence.startAutoSave();

  /**
   * 坏记录如实告知（FR-031/FR-032）。
   *
   * 粒度丢弃是静默的，但用户有权知道"有东西没能恢复"。这里只在确实丢了记录时提示，
   * 避免正常情况下的噪声。提示与"存储写入失败"用不同文案：一个是读坏了，一个是写不进。
   */
  if (summary.corruptedRecords > 0) {
    corruptionNoticeText = `有 ${summary.corruptedRecords} 条会话数据损坏，已跳过`;
    noticeBar.show(corruptionNoticeText);
  }

  // 全关后回主页（FR-016）：是否进浏览视图由恢复摘要决定，不在调用方重复判定
  showView(summary.shouldOpenBrowserView ? 'browser' : 'site-list');
}

/**
 * [DONE] 处理后台推送（Tier 2 上报转译后的结果）。
 *
 * 形状必须校验（宪法：消息两端都不信任发送方）；未知类型静默忽略。
 * 后台已做过一轮归属校验，这里再校验一次是纵深防御 —— 侧栏是最终消费这些字段的地方，
 * 一旦有字段形状不对（例如 URL 不是字符串），直接写进标签状态会污染存储。
 *
 * 返回非 undefined 表示"本条消息由侧栏处理"：`frame.open-request` 靠这个返回值告诉
 * content script「不用再走普通标签页降级」（见 `handleOpenRequest`）。
 */
function handleRuntimeMessage(message: unknown): unknown {
  const validation = validateRuntimeMessage(message);
  if (!validation.ok) {
    return undefined;
  }
  const { type, payload } = validation.message;

  if (type === 'frame.report') {
    handleFrameReport(payload);
    return undefined;
  }

  if (type === 'frame.open-request') {
    return handleOpenRequest(payload);
  }

  if (type === 'capabilities.changed') {
    handleCapabilitiesChanged(payload);
  }
  return undefined;
}

/**
 * [DONE] 把页内新窗口请求转成扩展内标签页（spec FR-023 主路径）。
 *
 * 为什么主路径在侧栏而不是后台：只有侧栏持有标签表，能新建**扩展内**标签。后台开的是
 * 普通浏览器标签页，用户就离开了侧栏的多标签环境（这正是 FR-023 要避免的）。
 *
 * 返回 `{ handled: true/false }` 而不是"什么都不返回"：content script 必须知道有没有人接手，
 * 才能决定要不要退回普通标签页（FR-040：不得静默阻止导航）。**没有这个返回值，
 * 两边都会开一次，一次点击就多出两个标签页** —— 这正是终审 D1 记录的缺陷。
 *
 * 归属校验与 frame.report 同样严格：只接受已授权（Tier 2 追踪中）来源的请求。
 */
function handleOpenRequest(payload: Record<string, unknown>): { handled: boolean } {
  const decision = decideOpenRequest(payload['url'], payload['sourceUrl'], isOriginTier2);
  if (!decision.handled) {
    return { handled: false };
  }

  openUrlInNewTab(decision.url, decision.originKey);
  return { handled: true };
}

/**
 * [DONE] 应用一次 frame 上报（Tier 2）：更新标签的 URL/标题，并据此入列新来源。
 *
 * 两个要点：
 * 1. **心跳语义**：上报到达本身就是"该帧真的加载成功"的证据（脚本只在真实文档里运行），
 *    因此先把它喂给嵌入检测器 —— 这会把 pending 推进到 ok，撤下可能的降级层。
 * 2. **不覆盖用户入口**（FR-019）：新来源按 `addedBy: navigation` 加入，
 *    已存在条目的标题与用户入口顺序保持不变。
 */
function handleFrameReport(payload: Record<string, unknown>): void {
  const url = payload['url'];
  const title = payload['title'];
  const navKind = payload['navKind'];
  if (typeof url !== 'string' || url.length === 0) {
    return;
  }

  /**
   * 来源归属校验（终审 C2）。
   *
   * 后台已校验过一次，但侧栏是**最终把这些字段写进状态与存储的地方**：不校验就等于把
   * "后台一定拦住了"当作安全前提，而那条前提会随任何一次路由改动失效。
   * 判据与 frame.open-request 一致：只有已授权（Tier 2 追踪中）来源才可能真的注入过脚本。
   *
   * 必须放在改动状态**之前** —— 放在后面只能阻止 render，状态已经被污染了。
   */
  const reportOriginKey = originKeyOf(url);
  if (reportOriginKey === null || !isOriginTier2(reportOriginKey)) {
    return;
  }

  // 找到承载该 URL 的标签：iframe 的 URL 与标签当前 URL 同源即认为属于它
  const tab = findTabForFrameUrl(url);
  if (tab === null) {
    // 找不到归属标签：不猜，直接丢弃
    return;
  }

  embedFallback.onHeartbeat(tab.tabId);

  /**
   * 标题上限（终审 B3）：与后台共用 `shared/frame-report-spec.ts` 的归一化。
   *
   * 标题来自第三方页面，是**不可信输入**。后台那份清洗只保护后台自己的路径，
   * 侧栏若不清洗就会把超长标题写进状态与存储（spec FR-031 的坏数据防护被绕开）。
   */
  const normalizedTitle = normalizeTitle(title);
  const nextTitle = normalizedTitle.length > 0 ? normalizedTitle : tab.title;
  if (navKind === 'load' || navKind === 'history') {
    // load / history：URL 真的变了，推进标签的当前地址与历史栈
    if (tab.currentUrl !== url) {
      tabs.navigate(tab.tabId, url);
      /**
       * 承认页面已经在新地址上。
       *
       * SPA 的 pushState 是**页面自己**完成的导航，我们不能也不该再去载一次 ——
       * 重载会丢掉站点刚建立的组件树与滚动位置。这里只把视图层的"已知地址"对齐，
       * 使紧随其后的 render() 不因地址差异而触发 iframe 重载。
       */
      browserView.adoptTabUrl(tab.tabId, url);
    }
  }
  if (nextTitle !== null && nextTitle !== tab.title) {
    tabs.setTitle(tab.tabId, nextTitle);
  }

  // 导航到的新来源自动入列（不覆盖既有用户入口，FR-019）
  const originKey = originKeyOf(url);
  if (originKey !== null && sites.getSite(originKey) === null) {
    sites.addFromNavigation(url);
    showToast('已把新来源加入网站列表');
  }

  /**
   * 记下"该来源确实有过成功上报" —— 这是撤下「地址可能未同步」徽章的唯一依据（T059）。
   * 注意只在 URL 归属校验通过后才记录，不能仅凭"收到了消息"就升级状态。
   */
  if (originKey !== null) {
    trackedOrigins.add(originKey);
  }

  render();
}

/** [DONE] 处理能力状态推送（后台在权限被外部撤销或规则变化时发出，FR-030） */
function handleCapabilitiesChanged(payload: Record<string, unknown>): void {
  const originKey = payload['originKey'];
  if (typeof originKey !== 'string') {
    return;
  }
  const state = parseCapabilityResponse({ ok: true, data: payload['state'] });
  if (state === null) {
    return;
  }
  capabilityCache.set(originKey, state);
  // 标记与事实对齐（外部撤销后回归未授权）
  syncGrantFromState(originKey, state);
  refreshOpenSettingsPanel(originKey);
  render();
}

/**
 * [DONE] 由上报的 iframe URL 找到归属标签（终审 B4）。
 *
 * 判定逻辑在 `state/frame-attribution.ts`：那里可以对各种歧义场景做穷尽单测，
 * 而本文件只负责把标签表喂进去。歧义时它返回 null，调用方据此拒绝 —— 详情见该模块。
 */
function findTabForFrameUrl(url: string): BrowserTab | null {
  return findTabForFrameUrlIn(tabs.getTabs(), url);
}

/**
 * [DONE] 取 URL 的精确来源键（复用 `shared/origin-key.ts`，终审 [建议修改] DRY）。
 *
 * 这里曾是全项目第五份手写的同型实现。端口归一化 / 大小写 / 协议白名单这类规则一旦
 * 多份实现就会漂移 —— 漂移的后果是同一个站点在不同路径下被判成不同来源（授权莫名失效）。
 */
const originKeyOf = originKeyTextFromUrl;

void start().catch(() => {
  // 恢复失败不让侧栏白屏：退化为空会话并停在主页，用户仍可添加网址
  persistence.startAutoSave();
  showView('site-list');
  noticeBar.show('会话恢复失败，已从空列表开始');
});

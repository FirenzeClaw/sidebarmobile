// sidebarmobile — 会话持久化接线（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T028：变更防抖保存、启动恢复、关闭标签立即落盘（FR-016/FR-017）

import type { SaveResult, SessionStore } from '../../shared/session-store.ts';
import type { SiteSettings } from '../../shared/types.ts';
import type { SiteRegistry } from './site-registry.ts';
import type { SiteSettingsStore } from './site-settings.ts';
import type { TabSession } from './tab-session.ts';

/**
 * [DONE] 把标签会话与网站注册表的变更接到存储层。
 *
 * 三条路径的语义不同，必须分开：
 * - **防抖保存**：导航、切换等高频变更合并写入（spec FR-017）；
 * - **立即保存**：关闭标签必须即时落盘，否则「关闭后重启又回来」会违反 spec FR-016；
 * - **启动恢复**：从存储读回快照并逐条校验，坏记录在状态层被粒化丢弃（spec FR-031）。
 *
 * 写入失败不抛异常：结果经 lastResult() 暴露，由视图层提示「会话可能无法完整恢复」（spec FR-032）。
 */

/** 启动恢复的结果摘要：视图层据此决定进主页还是恢复浏览视图 */
export interface RestoreSummary {
  tabs: number;
  sites: number;
  activeTabId: string | null;
  /**
   * 是否应直接进入浏览视图。
   *
   * 由这里给出而不是让调用方自己判 `tabs > 0`：恢复语义属于本模块的职责，
   * 把判定散到调用方会让"全关后回主页"（FR-016）这条规则在多处重复。
   */
  shouldOpenBrowserView: boolean;
  /** 读取过程中被丢弃的坏记录条数；0 表示数据完好 */
  corruptedRecords: number;
}

export interface SessionPersistence {
  /** 启动时读回会话与网站列表；返回恢复摘要 */
  restore(): Promise<RestoreSummary>;
  /** 订阅状态变更并开始防抖自动保存；重复调用只生效一次 */
  startAutoSave(): void;
  /** 退订并停止自动保存（侧栏卸载时调用） */
  stopAutoSave(): void;
  /** 立即落盘（关闭标签等需要即时语义的场景） */
  persistImmediately(): Promise<SaveResult | null>;
  /** 最近一次写入结果；从未写入时为 null */
  lastResult(): SaveResult | null;
  /**
   * 订阅写入结果（成功与失败都通知）。
   *
   * **必须通知成功**：只通知失败会让警示条一旦出现就永远撤不下来 ——
   * 用户修好存储问题后仍看到「会话可能无法完整恢复」，与实际状态不符（同样是谎报，只是方向相反）。
   * 因此这里转发每一次写入结果，由调用方按 result.persisted 决定显示还是撤下。
   *
   * 返回退订函数。
   */
  onWriteResult(listener: (result: SaveResult) => void): () => void;
  /**
   * 订阅外部对站点设置的改动（终审 A1）。
   *
   * 授权标记的唯一写入者是后台。侧栏订阅这条通道后，"点允许 → 开关打开"才能成立；
   * 恢复时也会先读一次存储，因此重启后的授权同样如实反映。
   * 返回退订函数。
   */
  onSiteSettingsChanged(listener: (settings: Record<string, SiteSettings>) => void): () => void;
}

export interface SessionPersistenceOptions {
  store: SessionStore;
  tabs: TabSession;
  sites: SiteRegistry;
  /**
   * 站点设置的状态层（可选）。
   *
   * 传了才接线：站点设置属 US2，而 US1 的会话持久化不需要它。这样 US1 的既有测试与调用方
   * 不受影响，US2 只需要多传一个依赖。传了这个依赖后，设置的读写随会话恢复与变更一起自动进行。
   */
  siteSettings?: SiteSettingsStore;
  /** 防抖窗口（毫秒）；测试用极小值缩短等待 */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;

/** [DONE] 创建持久化接线 */
export function createSessionPersistence(options: SessionPersistenceOptions): SessionPersistence {
  const { store, tabs, sites, siteSettings } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let unsubscribeTabs: (() => void) | null = null;
  let unsubscribeSites: (() => void) | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let lastWriteResult: SaveResult | null = null;

  /** [DONE] 把当前状态提交为一次防抖写入 */
  function scheduleSessionWrite(): void {
    void store.saveSessionDebounced({ tabs: tabs.snapshot().tabs, activeTabId: tabs.getActiveTabId() }, debounceMs);
  }

  function scheduleSitesWrite(): void {
    // 站点列表变更频率低（增删改），直接写；写入失败的结果由 persistImmediately 路径暴露
    void store.saveSites(sites.snapshot()).then((result) => {
      lastWriteResult = result;
    });
  }

  /** [DONE] 站点设置变更（显示模式/授权标记）也即时写：这些是低频但用户可感知的显式操作 */
  function scheduleSettingsWrite(): void {
    if (siteSettings === undefined) {
      return;
    }
    void store.saveSiteSettings(siteSettings.snapshot()).then((result) => {
      lastWriteResult = result;
    });
  }

  /** [DONE] 立即落盘当前状态；先冲刷待写快照，保证「关闭即删」不会被旧快照覆盖 */
  async function persistNow(): Promise<SaveResult | null> {
    const sessionResult = await store.saveSession({
      tabs: tabs.snapshot().tabs,
      activeTabId: tabs.getActiveTabId(),
    });
    const sitesResult = await store.saveSites(sites.snapshot());
    // 设置写失败同样要能被调用方看见（FR-032），因此并入结果汇总
    const settingsResult = siteSettings === undefined ? sitesResult : await store.saveSiteSettings(siteSettings.snapshot());
    if (!sessionResult.persisted) {
      lastWriteResult = sessionResult;
    } else if (!sitesResult.persisted) {
      lastWriteResult = sitesResult;
    } else {
      lastWriteResult = settingsResult;
    }
    return lastWriteResult;
  }

  /**
   * [DONE] 外部写入 → 镜像到侧栏内存态（终审 A1 的核心）。
   *
   * **按字段划分归属**，与 A2 的写入侧对称：
   * - 授权标记（uaGrant/cookieGrant）以**存储为准** —— 唯一写入者是后台，侧栏只旁观；
   * - 显示模式以**本地内存为准** —— 侧栏是自己这个值的写入者，"后台授予"这种无关事件
   *   不该把用户刚切换的模式弹回去（整体覆盖就会造成这个后果）。
   *
   * 只存在于本地、存储里还没有的来源原样保留，避免镜像变成一次"回滚未落盘的改动"。
   *
   * 回路安全：镜像会触发一次设置写入，写入又产生存储变更事件。`restore` 内部做了内容比对，
   * 第二圈发现内容一致即返回，回路终止（见 site-settings.ts 的说明）。
   */
  function mirrorExternalSettings(settings: Record<string, SiteSettings>): void {
    if (siteSettings === undefined) {
      return;
    }
    const local = siteSettings.snapshot();
    const merged: Record<string, SiteSettings> = { ...local };
    for (const [originKey, value] of Object.entries(settings)) {
      merged[originKey] = {
        displayMode: local[originKey]?.displayMode ?? value.displayMode,
        uaGrant: value.uaGrant,
        cookieGrant: value.cookieGrant,
      };
    }
    siteSettings.restore(merged);
  }

  const externalSettingsListeners = new Set<(settings: Record<string, SiteSettings>) => void>();

  /**
   * [DONE] 建立镜像订阅（构造时即建立，不依赖界面是否订阅）。
   *
   * 镜像本身是状态层的一致性需求：由"界面是否恰好订阅过"决定要不要镜像，等于把
   * 「用户点了允许、界面开关仍关」这条缺陷留在原地。
   */
  let unsubscribeExternalSettings: (() => void) | null = null;
  if (siteSettings !== undefined) {
    unsubscribeExternalSettings = store.onSiteSettingsChanged((settings) => {
      mirrorExternalSettings(settings);
      for (const listener of externalSettingsListeners) {
        listener(settings);
      }
    });
  }

  return {
    async restore(): Promise<RestoreSummary> {
      /**
       * 读取失败不能让侧栏起不来。
       *
       * 存储读取会因配额清理、扩展权限被改、provider 瞬时故障等原因失败。此时**必须**降级为
       * "从空会话开始"而不是把异常抛给调用方 —— 否则用户打开侧栏看到的是一片空白，
       * 比"网站列表没了"更糟（后者至少还能重新添加）。spec FR-032 要求保留当前会话的可用操作。
       */
      let session: Awaited<ReturnType<SessionStore['loadSession']>>;
      let storedSites: Awaited<ReturnType<SessionStore['loadSites']>>;
      let storedSettings: Awaited<ReturnType<SessionStore['loadSiteSettings']>>;
      let corruptedRecords = 0;

      try {
        const [sessionLoad, sitesLoad, settingsLoad] = await Promise.all([
          store.loadSessionWithDiagnostics(),
          store.loadSitesWithDiagnostics(),
          siteSettings === undefined ? Promise.resolve({}) : store.loadSiteSettings(),
        ]);
        session = sessionLoad.session;
        storedSites = sitesLoad.sites;
        storedSettings = settingsLoad;
        /**
         * 坏记录计数：读取侧按粒度丢弃是**静默**的（FR-031 只要求"不影响其余数据"），
         * 但用户有权知道"有东西没恢复"。这里把两份诊断相加，让界面能如实提示，
         * 而不是让几个标签无声消失。
         */
        corruptedRecords = sessionLoad.diagnostics.discardedCount + sitesLoad.diagnostics.discardedCount;
      } catch {
        // 读取失败不能让侧栏起不来：降级为从空会话开始（FR-032 保留可用操作）
        session = { version: 1, tabs: [], activeTabId: null, savedAt: new Date(0).toISOString() };
        storedSites = [];
        storedSettings = {};
        corruptedRecords = 0;
      }

      tabs.restore({ tabs: session.tabs, activeTabId: session.activeTabId });
      sites.restore(storedSites);
      // 站点设置跨重启恢复（spec FR-039）；未接线时跳过
      siteSettings?.restore(storedSettings);

      return {
        tabs: session.tabs.length,
        sites: storedSites.length,
        activeTabId: session.activeTabId,
        // 全关后回主页（FR-016）：没有恢复出标签就不进浏览视图
        shouldOpenBrowserView: session.tabs.length > 0,
        corruptedRecords,
      };
    },

    startAutoSave(): void {
      if (unsubscribeTabs !== null || unsubscribeSites !== null) {
        return;
      }

      let knownTabIds = new Set(tabs.getTabs().map((tab) => tab.tabId));

      unsubscribeTabs = tabs.onChange(() => {
        const currentTabIds = new Set(tabs.getTabs().map((tab) => tab.tabId));
        // 标签被移除时立即落盘：防抖窗口内重启会把「已关闭的标签」恢复回来，违反 spec FR-016；
        // 其余高频变更（导航、切换）仍走防抖合并写入。
        const removedTab = [...knownTabIds].some((tabId) => !currentTabIds.has(tabId));
        knownTabIds = currentTabIds;

        if (removedTab) {
          void persistNow();
          return;
        }
        scheduleSessionWrite();
      });

      unsubscribeSites = sites.onChange(() => {
        scheduleSitesWrite();
      });

      if (siteSettings !== undefined) {
        unsubscribeSettings = siteSettings.onChange(() => {
          scheduleSettingsWrite();
        });
      }
    },

    stopAutoSave(): void {
      if (unsubscribeTabs !== null) {
        unsubscribeTabs();
        unsubscribeTabs = null;
      }
      if (unsubscribeSites !== null) {
        unsubscribeSites();
        unsubscribeSites = null;
      }
      if (unsubscribeSettings !== null) {
        unsubscribeSettings();
        unsubscribeSettings = null;
      }
    },

    persistImmediately(): Promise<SaveResult | null> {
      // 冲刷掉尚未触发的防抖快照，再写入当前状态：两者顺序颠倒会让旧快照覆盖新状态
      return store.flushPendingWrites().then(() => persistNow());
    },

    lastResult(): SaveResult | null {
      return lastWriteResult;
    },

    onWriteResult(listener: (result: SaveResult) => void): () => void {
      return store.onWriteResult((result) => {
        lastWriteResult = result;
        // 成功与失败都转发：调用方需要"成功"来撤下警示条
        listener(result);
      });
    },

    onSiteSettingsChanged(listener: (settings: Record<string, SiteSettings>) => void): () => void {
      // 镜像已经由构造时的订阅完成，这里只登记"还有谁想知道"（见 mirrorExternalSettings）
      externalSettingsListeners.add(listener);
      return () => {
        externalSettingsListeners.delete(listener);
      };
    },
  };
}

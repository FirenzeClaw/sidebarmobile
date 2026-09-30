// sidebarmobile — 站点设置状态（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T033：实现以通过 T030（FR-008/FR-038/FR-039）

import { originKeyFromUrl } from '../../shared/origin-key.ts';
import {
  createDefaultSiteSettings,
  type DisplayMode,
  type GrantState,
  type SiteSettings,
} from '../../shared/types.ts';

/**
 * [DONE] 站点设置的纯状态机（不接触 DOM 与浏览器 API）。
 *
 * 键是**精确来源**（协议 + 域名 + 端口），因此同一来源下的不同路径共享一份设置，
 * 而不同端口/协议/子域名各有一份（spec FR-038：切换只影响当前精确来源）。
 *
 * 与 `site-registry` 的分工：注册表管「网站条目」（标题、入口、图标），本模块管「站点设置」
 * （显示模式、两项授权标记）。两者都按 originKey 索引，但生命周期独立 —— 设置可以存在于
 * 尚未加入网站列表的来源上（例如从网页导航抵达、用户在弹层里直接改了模式）。
 *
 * 注意：这里持久化的 `GrantState` 是**用户意愿**，不代表能力可用；能力是否真的生效必须每次用
 * `permissions.contains` 复核后由 capability-state 现算（spec FR-030/FR-039）。
 */

/** 授权类型：UA 与 Cookie 严格分离（spec FR-009/FR-011） */
export type GrantKind = 'ua' | 'cookie';

export interface SiteSettingsStore {
  /** 取单条来源的完整设置；未设置过时返回默认值 */
  getSettings(originKey: string): SiteSettings;
  getDisplayMode(originKey: string): DisplayMode;
  getGrant(originKey: string, kind: GrantKind): GrantState;
  /** 设置显示模式；来源非法或值未变返回 false */
  setDisplayMode(originKey: string, mode: DisplayMode): boolean;
  /** 设置授权标记；来源非法或值未变返回 false */
  setGrant(originKey: string, kind: GrantKind, state: GrantState): boolean;
  /** 清理授权标记（回到 never）；外部撤销或用户关闭开关时调用 */
  clearGrant(originKey: string, kind: GrantKind): boolean;
  /** 快照：只含被显式改动过的来源 */
  snapshot(): Record<string, SiteSettings>;
  /** 从快照恢复；非法来源键丢弃，非法字段回落默认值（spec FR-031 粒度丢弃） */
  restore(raw: Record<string, unknown>): void;
  /** 订阅变更（用于持久化）；返回退订函数 */
  onChange(listener: () => void): () => void;
}

const DISPLAY_MODES: readonly DisplayMode[] = ['mobile', 'desktop'];
const GRANT_STATES: readonly GrantState[] = ['never', 'granted', 'revoked'];

function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value);
}

function isGrantState(value: unknown): value is GrantState {
  return typeof value === 'string' && (GRANT_STATES as readonly string[]).includes(value);
}

/** [DONE] 来源键必须是可解析的 http(s) 精确来源 */
function isUsableOriginKey(originKey: string): boolean {
  return originKeyFromUrl(originKey) !== null;
}

/** [DONE] 逐字段校验并回落默认值：单字段损坏不应丢掉整条设置（spec FR-031） */
function normalizeSettings(value: unknown): SiteSettings {
  if (typeof value !== 'object' || value === null) {
    return createDefaultSiteSettings();
  }
  const candidate = value as Partial<SiteSettings>;
  return {
    displayMode: isDisplayMode(candidate.displayMode) ? candidate.displayMode : 'mobile',
    uaGrant: isGrantState(candidate.uaGrant) ? candidate.uaGrant : 'never',
    cookieGrant: isGrantState(candidate.cookieGrant) ? candidate.cookieGrant : 'never',
  };
}

/**
 * [DONE] 两份设置映射是否完全一致（终审 A1）。
 *
 * 用于 `restore` 的变更检测：外部写入会镜像回内存，镜像又触发持久化，
 * 缺少这个判据就会形成"镜像→写→事件→镜像"的无限回路。
 */
function settingsEqual(
  left: Record<string, SiteSettings>,
  right: Record<string, SiteSettings>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every((originKey) => {
    const other = right[originKey];
    if (other === undefined) {
      return false;
    }
    const mine = left[originKey];
    return (
      mine !== undefined &&
      mine.displayMode === other.displayMode &&
      mine.uaGrant === other.uaGrant &&
      mine.cookieGrant === other.cookieGrant
    );
  });
}

/** [DONE] 创建站点设置存储 */
export function createSiteSettingsStore(): SiteSettingsStore {
  /** 只记录被显式改动过的来源；未出现即用默认值，避免为每个访问过的站点写一份无差别记录 */
  let settingsByOrigin: Record<string, SiteSettings> = {};
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  /** [DONE] 写入单条来源的某个字段；值未变或来源非法时返回 false 且不通知 */
  function update(originKey: string, mutate: (current: SiteSettings) => SiteSettings): boolean {
    if (!isUsableOriginKey(originKey)) {
      return false;
    }

    const current = settingsByOrigin[originKey] ?? createDefaultSiteSettings();
    const next = mutate(current);
    const unchanged =
      next.displayMode === current.displayMode &&
      next.uaGrant === current.uaGrant &&
      next.cookieGrant === current.cookieGrant;
    if (unchanged) {
      return false;
    }

    settingsByOrigin = { ...settingsByOrigin, [originKey]: next };
    notify();
    return true;
  }

  return {
    getSettings(originKey: string): SiteSettings {
      return settingsByOrigin[originKey] ?? createDefaultSiteSettings();
    },

    getDisplayMode(originKey: string): DisplayMode {
      return this.getSettings(originKey).displayMode;
    },

    getGrant(originKey: string, kind: GrantKind): GrantState {
      const settings = this.getSettings(originKey);
      return kind === 'ua' ? settings.uaGrant : settings.cookieGrant;
    },

    setDisplayMode(originKey: string, mode: DisplayMode): boolean {
      return update(originKey, (current) => ({ ...current, displayMode: mode }));
    },

    setGrant(originKey: string, kind: GrantKind, state: GrantState): boolean {
      return update(originKey, (current) =>
        kind === 'ua' ? { ...current, uaGrant: state } : { ...current, cookieGrant: state },
      );
    },

    clearGrant(originKey: string, kind: GrantKind): boolean {
      // 清理语义等同回到 never（data-model §4：标记非成功态，清掉即未授权）
      return this.setGrant(originKey, kind, 'never');
    },

    snapshot(): Record<string, SiteSettings> {
      return { ...settingsByOrigin };
    },

    restore(raw: Record<string, unknown>): void {
      const restored: Record<string, SiteSettings> = {};
      for (const [originKey, value] of Object.entries(raw)) {
        if (!isUsableOriginKey(originKey)) {
          continue;
        }
        restored[originKey] = normalizeSettings(value);
      }
      /**
       * 内容未变则不通知（终审 A1）。
       *
       * 外部写入会先镜像回内存再触发一次持久化，而持久化又产生一次存储变更事件 ——
       * 若在这里无条件通知，这条回路永不停歇（每次镜像都写回存储、再触发下一次镜像）。
       * 比对后提前返回：回路的第二圈就发现内容一致，自然终止。
       */
      if (settingsEqual(settingsByOrigin, restored)) {
        return;
      }
      settingsByOrigin = restored;
      notify();
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

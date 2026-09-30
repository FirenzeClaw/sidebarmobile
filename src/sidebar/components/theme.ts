// sidebarmobile — 主题控制（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T025：六主题家族内的深浅即时翻转（MASTER.md §2/§4）

/**
 * [DONE] 深浅主题翻转。
 *
 * 行为契约（design-system/MASTER.md §2/§4）：
 * - 顶栏翻转钮只在**当前家族内** day↔night 切换（chrome / edge / firefox）；
 * - 切换为即时生效，无过渡动画，图标随模式在日/月之间互换；
 * - 主题选择不持久化：本切片只需保持会话内一致，完整六主题选择属后续弹层任务。
 */

const DEFAULT_THEME = 'chrome-day';

export type ThemeFamily = 'chrome' | 'edge' | 'firefox';
export type ThemeMode = 'day' | 'night';
export type ThemeId = `${ThemeFamily}-${ThemeMode}`;

/** [DONE] 拆解主题 ID；非法 ID 回落到默认主题 */
export function parseThemeId(themeId: string): { family: ThemeFamily; mode: ThemeMode } {
  const separatorIndex = themeId.lastIndexOf('-');
  const family = themeId.slice(0, separatorIndex);
  const mode = themeId.slice(separatorIndex + 1);
  if ((family === 'chrome' || family === 'edge' || family === 'firefox') && (mode === 'day' || mode === 'night')) {
    return { family, mode };
  }
  return { family: 'chrome', mode: 'day' };
}

/** [DONE] 同家族内的对偶主题 */
export function flipTheme(themeId: string): ThemeId {
  const { family, mode } = parseThemeId(themeId);
  return `${family}-${mode === 'day' ? 'night' : 'day'}`;
}

export interface ThemeController {
  current(): ThemeId;
  /** 切换到同家族的另一模式；返回切换后的主题 ID */
  flipDayNight(): ThemeId;
  setTheme(themeId: ThemeId): void;
  /** 当前是否为夜间模式（用于翻转钮的图标与 aria-label） */
  isNight(): boolean;
}

/** [DONE] 创建主题控制器；应用方式是在 html 上设置 data-theme */
export function createThemeController(root: HTMLElement, initialTheme: ThemeId = DEFAULT_THEME): ThemeController {
  let current: ThemeId = initialTheme;

  function apply(themeId: ThemeId): void {
    root.setAttribute('data-theme', themeId);
  }

  apply(current);

  return {
    current(): ThemeId {
      return current;
    },

    flipDayNight(): ThemeId {
      current = flipTheme(current);
      apply(current);
      return current;
    },

    setTheme(themeId: ThemeId): void {
      current = themeId;
      apply(current);
    },

    isNight(): boolean {
      return parseThemeId(current).mode === 'night';
    },
  };
}

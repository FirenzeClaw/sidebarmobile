// sidebarmobile — 站点设置面板（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T039：移动/桌面切换、UA 开关、能力状态徽章（FR-008/FR-029/FR-038）

import { clearElement, createElement, truncateForLabel } from './dom.ts';
import {
  capabilityBadges,
  DENIED_NOTICE,
  displayModeHint,
  UNSUPPORTED_NOTICE,
  type BadgeTone,
} from './status-badge.ts';
import type { CapabilityState, DisplayMode } from '../../shared/types.ts';

/**
 * [DONE] 站点设置面板（ui-states.md「站点设置钮」菜单项）。
 *
 * 三项控制，语义各不相同，界面必须让用户分得清：
 * - **移动/桌面**：改的是版面宽度（视口适配），**不等于**真实 UA；
 * - **真实移动 UA**：需要权限，未授权时开关保持关闭并显示「未授权，已使用降级模式」；
 * - **登录状态复用**：与 UA 严格独立，本切片只保留开关位（能力实现属 US3）。
 *
 * 关键约束（spec FR-029/SC-005）：**任何状态都不允许把移动视口显示成真实 UA**。
 * 因此开关的选中态只由 `grant === 'granted'` 决定，而徽章区独立展示真实的能力状态 ——
 * 即使开关开着，只要规则没落地，徽章就会说「已降级为移动视口」。
 */

/** 开关状态：三态。`pending` 表示正在等用户处理权限对话框，界面需禁用交互避免重复申请 */
export type ToggleState = 'off' | 'on' | 'pending';

export interface SiteSettingsPanelHandlers {
  /** 切换显示模式；返回后由调用方用最新设置重绘 */
  onSetDisplayMode(mode: DisplayMode): void;
  /** 开启真实移动 UA（会触发权限申请） */
  onEnableUaGrant(): void;
  /** 关闭真实移动 UA */
  onDisableUaGrant(): void;
  /** 开启登录状态复用 */
  onEnableCookieGrant(): void;
  /** 关闭登录状态复用 */
  onDisableCookieGrant(): void;
}

/** 面板渲染输入：只读快照 */
export interface SiteSettingsPanelState {
  originKey: string;
  /** 站点显示名（网站条目标题或主机名） */
  displayName: string;
  displayMode: DisplayMode;
  uaGrant: 'never' | 'granted' | 'revoked';
  cookieGrant: 'never' | 'granted' | 'revoked';
  capabilities: CapabilityState;
  /** UA 开关的交互态 */
  uaToggle: ToggleState;
  /** 最近一次操作的提示（如「未授权，已使用降级模式」）；无提示时为 null */
  notice: string | null;
}

export interface SiteSettingsPanel {
  /** 面板根元素 */
  element(): HTMLElement;
  /** 用最新状态重绘（权限对话框返回后调用） */
  render(state: SiteSettingsPanelState): void;
  /** 外部（Esc）关闭前的清理钩子 */
  dispose(): void;
}

/** [DONE] 创建站点设置面板 */
export function createSiteSettingsPanel(
  initialState: SiteSettingsPanelState,
  handlers: SiteSettingsPanelHandlers,
): SiteSettingsPanel {
  const root = createElement('div', { class: 'settings-panel' });
  let currentState = initialState;

  /** [DONE] 构建一行开关 */
  function buildSwitchRow(input: {
    label: string;
    hint: string;
    checked: boolean;
    /** 等权限对话框时禁用，避免重复申请 */
    disabled: boolean;
    onToggle: (next: boolean) => void;
  }): HTMLElement {
    const row = createElement('div', { class: 'settings-row' });
    const button = createElement('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': input.checked ? 'true' : 'false',
      'aria-label': input.label,
      disabled: input.disabled,
    });
    button.addEventListener('click', () => {
      input.onToggle(!input.checked);
    });

    row.append(
      createElement(
        'div',
        { class: 'settings-row-main' },
        createElement('span', { class: 'settings-row-label', text: input.label }),
        createElement('span', { class: 'settings-row-sub', text: input.hint }),
      ),
      button,
    );
    return row;
  }

  /** [DONE] 构建一枚能力徽章 */
  function buildBadge(label: string, tone: BadgeTone): HTMLElement {
    return createElement('span', { class: `badge ${tone}`, text: label });
  }

  function renderCurrent(): void {
    clearElement(root);

    const state = currentState;

    // 头部：站点名 + 精确来源（用户需要看到设置的粒度就是这一串）
    const header = createElement('div', { class: 'settings-head' });
    header.append(
      createElement('span', { class: 'tab-favicon large', 'aria-hidden': 'true', text: state.displayName.slice(0, 1) }),
      createElement(
        'div',
        {},
        createElement('div', { class: 'settings-site', text: state.displayName }),
        createElement('div', {
          class: 'settings-host',
          text: truncateForLabel(state.originKey, 44),
        }),
      ),
    );

    // 显示模式：两态分段控件（比开关更能表达"二选一"，且能直接看到当前模式）
    const modeRow = createElement('div', { class: 'settings-row' });
    const mobileActive = state.displayMode === 'mobile';
    const modeGroup = createElement('div', { class: 'mode-group', role: 'group', 'aria-label': '显示模式' });
    const mobileButton = createElement('button', {
      class: `mode-btn${mobileActive ? ' on' : ''}`,
      type: 'button',
      'aria-pressed': mobileActive ? 'true' : 'false',
      text: '移动',
    });
    const desktopButton = createElement('button', {
      class: `mode-btn${mobileActive ? '' : ' on'}`,
      type: 'button',
      'aria-pressed': mobileActive ? 'false' : 'true',
      text: '桌面',
    });
    mobileButton.addEventListener('click', () => {
      handlers.onSetDisplayMode('mobile');
    });
    desktopButton.addEventListener('click', () => {
      handlers.onSetDisplayMode('desktop');
    });
    modeGroup.append(mobileButton, desktopButton);
    modeRow.append(
      createElement(
        'div',
        { class: 'settings-row-main' },
        createElement('span', { class: 'settings-row-label', text: '显示模式' }),
        createElement('span', { class: 'settings-row-sub', text: displayModeHint(state.displayMode) }),
      ),
      modeGroup,
    );

    // 提示条：最近一次操作的如实反馈
    const notice = createElement('p', {
      class: 'settings-notice',
      role: 'status',
      hidden: state.notice === null,
      text: state.notice ?? '',
    });

    const rows = createElement('div', { class: 'settings-rows' });
    rows.append(
      modeRow,
      buildSwitchRow({
        label: '真实移动 UA',
        hint: '改写发往该站点的 User-Agent 请求头',
        checked: state.uaGrant === 'granted',
        disabled: state.uaToggle === 'pending',
        onToggle: (next) => {
          if (next) {
            handlers.onEnableUaGrant();
          } else {
            handlers.onDisableUaGrant();
          }
        },
      }),
      buildSwitchRow({
        label: '登录状态复用',
        hint: '检测该站点是否已存在登录会话',
        checked: state.cookieGrant === 'granted',
        disabled: false,
        onToggle: (next) => {
          if (next) {
            handlers.onEnableCookieGrant();
          } else {
            handlers.onDisableCookieGrant();
          }
        },
      }),
    );

    /**
     * 分隔线：让用户看清「开关意愿」与「实际能力」是两件事。
     *
     * 开关表示"我授权了"，徽章表示"现在实际是什么状态" —— 两者可以不一致
     * （授权了但浏览器不支持 → 开关开、徽章说已降级），界面必须允许这种组合可见。
     */
    const badges = createElement('div', { class: 'settings-badges' });
    badges.append(createElement('p', { class: 'settings-badges-title', text: '能力状态（实际生效情况）' }));
    const badgeRow = createElement('div', { class: 'badge-row' });
    for (const badge of capabilityBadges(state.capabilities)) {
      badgeRow.append(buildBadge(badge.label, badge.tone));
    }
    badges.append(badgeRow);

    root.append(header, notice, rows, badges);
  }

  renderCurrent();

  return {
    element(): HTMLElement {
      return root;
    },

    render(state: SiteSettingsPanelState): void {
      currentState = state;
      renderCurrent();
    },

    dispose(): void {
      // 目前无外部监听需要解绑；保留钩子供后续接入悬停子菜单时使用
    },
  };
}

/** [DONE] 由状态推导 UA 开关的交互态（pending 时禁用，避免权限对话框叠加） */
export function uaToggleStateFor(grant: 'never' | 'granted' | 'revoked', pending: boolean): ToggleState {
  if (pending) {
    return 'pending';
  }
  return grant === 'granted' ? 'on' : 'off';
}

/**
 * [DONE] 由授权结果推导提示文案。
 *
 * `denied` 与 `unsupported` 都要如实说，且都不能把降级说成成功（spec FR-029）。
 */
export function noticeForOutcome(outcome: 'granted' | 'denied' | 'unsupported'): string | null {
  if (outcome === 'granted') {
    return null;
  }
  return outcome === 'unsupported' ? UNSUPPORTED_NOTICE : DENIED_NOTICE;
}

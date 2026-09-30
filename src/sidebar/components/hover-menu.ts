// sidebarmobile — 悬停菜单状态机（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T069：实现以通过 T067（FR-027/FR-028，ARIA menu 模式）

/**
 * [DONE] 悬停图标子菜单的**状态机**（不碰 DOM，可单测）。
 *
 * 分离状态机的理由：交互有三条打开通道与四条关闭通道，组合起来是一张不小的状态图。
 * 若把它写进事件监听器里，"键盘能不能打开"这类问题就只能靠手工点一遍来回答。
 * 独立成纯函数后，每条通道都有独立用例（`tests/unit/hover-menu.test.ts` 31 项）。
 *
 * 三条打开通道（契约 ui-states.md §悬停图标子菜单）：
 * - **鼠标悬停**：延迟 `HOVER_OPEN_DELAY_MS` 后打开。延迟的意义是"防抖" ——
 *   鼠标扫过一排按钮时不该连开一串菜单。
 * - **触摸点击**：立即切换。触摸端没有 hover 语义，任何延迟都会让用户以为点空了。
 * - **键盘 Enter/Space**：立即打开，且**必须把焦点移入菜单** ——
 *   否则键盘用户打开了菜单却到不了菜单项，等于没有这个功能（FR-028）。
 *
 * 四条关闭通道：Esc、外部点击、选中菜单项、切换到另一个触发器。
 * 前两者需要**回焦触发器**；后两者不需要（选中项后触发器可能已不存在，切换时焦点已在新触发器上）。
 */

/**
 * 悬停打开延迟。
 *
 * 取值权衡：小于 ~100ms 会被鼠标移动路径上的抖动误触发；大于 ~250ms 会让用户觉得"没反应"。
 * 契约给的是 ~150ms，取其中间。
 */
export const HOVER_OPEN_DELAY_MS = 150;

/**
 * 悬停移开后的关闭延迟。
 *
 * 比打开延迟长：从触发器移到菜单通常需要 200–400ms，太短会让菜单在鼠标途中消失。
 * 用户明确操作（Esc / 点击外部）时不受此延迟影响，那是立即关闭。
 */
export const HOVER_CLOSE_DELAY_MS = 220;

/** 开启通道：界面可据此决定是否把焦点移入菜单 */
export type MenuOpenReason = 'hover' | 'touch' | 'keyboard';

/** 关闭通道：界面可据此决定是否需要回焦 */
export type MenuCloseReason = 'escape' | 'outside-click' | 'item-activated' | 'switch' | 'dispose';

export interface HoverMenuOptions {
  now(): number;
  /** 定时器抽象：返回取消函数 */
  schedule(delayMs: number, run: () => void): () => void;
  onOpen?(triggerId: string, reason: MenuOpenReason): void;
  onClose?(triggerId: string | null, reason: MenuCloseReason): void;
}

export interface HoverMenu {
  isOpen(): boolean;
  openTriggerId(): string | null;
  openReason(): MenuOpenReason | null;
  /** 打开后界面是否应把焦点移入菜单（只有键盘通道为真） */
  shouldFocusMenu(): boolean;
  /** 关闭后应回焦的触发器 id；无需回焦时为 null */
  focusReturnTarget(): string | null;

  /** 鼠标进入触发器 */
  hoverStart(triggerId: string): void;
  /** 鼠标离开触发器或菜单 */
  hoverEnd(): void;
  /** 触摸点击触发器（切换语义） */
  touchToggle(triggerId: string): void;
  /** 键盘 Enter / Space 激活触发器（切换语义，且请求焦点进入菜单） */
  keyboardOpen(triggerId: string): void;

  /** Esc 关闭；返回 true 表示本次按键被消费 */
  escape(): boolean;
  /** 菜单外点击关闭；返回 true 表示本次点击被消费 */
  outsideClick(): boolean;
  /** 某菜单项被激活后关闭 */
  itemActivated(): void;
  /** 清理（组件卸载）：取消待处理定时器并重置状态 */
  dispose(): void;
}

/** [DONE] 创建悬停菜单状态机 */
export function createHoverMenu(options: HoverMenuOptions): HoverMenu {
  let open = false;
  let triggerId: string | null = null;
  let reason: MenuOpenReason | null = null;
  /** 关闭后需要回焦的触发器；由 escape/outsideClick 设置，切换与选中项时清空 */
  let focusTarget: string | null = null;
  /** 待执行的悬停打开定时器 */
  let cancelOpenTimer: (() => void) | null = null;
  /** 待执行的悬停关闭定时器 */
  let cancelCloseTimer: (() => void) | null = null;

  /** [DONE] 取消待处理的打开定时器 */
  function clearOpenTimer(): void {
    if (cancelOpenTimer !== null) {
      cancelOpenTimer();
      cancelOpenTimer = null;
    }
  }

  /** [DONE] 取消待处理的关闭定时器 */
  function clearCloseTimer(): void {
    if (cancelCloseTimer !== null) {
      cancelCloseTimer();
      cancelCloseTimer = null;
    }
  }

  /**
   * [DONE] 关闭菜单并通知。
   *
   * `returnFocus` 由通道决定而不是在这里猜：
   * - Esc 与外部点击 → true（键盘用户必须能回到触发器继续 Tab）；
   * - 选中菜单项 → false（操作可能删掉了触发器，回焦会指向不存在的元素）；
   * - 切换到别的触发器 → false（焦点已随新触发器走，再回焦会把焦点拽回去）。
   */
  function close(closeReason: MenuCloseReason, returnFocus: boolean): void {
    clearOpenTimer();
    clearCloseTimer();
    if (!open) {
      return;
    }
    const previousTrigger = triggerId;
    open = false;
    triggerId = null;
    reason = null;
    focusTarget = returnFocus ? previousTrigger : null;
    options.onClose?.(previousTrigger, closeReason);
  }

  /** [DONE] 打开菜单（若已有打开者，先以 'switch' 关闭它） */
  function openWith(nextTriggerId: string, openReason: MenuOpenReason, focusMenu: boolean): void {
    clearOpenTimer();
    clearCloseTimer();

    if (open && triggerId !== nextTriggerId) {
      // 单实例约束：一次只开一个（触摸环境尤其重要）
      options.onClose?.(triggerId, 'switch');
    }

    open = true;
    triggerId = nextTriggerId;
    reason = openReason;
    // 只有键盘通道需要把焦点移进菜单；鼠标/触摸强跳焦点会打断正在别处的键盘用户
    focusTarget = null;
    pendingFocusMenu = focusMenu;
    options.onOpen?.(nextTriggerId, openReason);
  }

  /** 打开后是否请求焦点进入菜单；关闭时复位 */
  let pendingFocusMenu = false;

  return {
    isOpen: () => open,
    openTriggerId: () => triggerId,
    openReason: () => reason,
    shouldFocusMenu: () => open && pendingFocusMenu,
    focusReturnTarget: () => focusTarget,

    hoverStart(nextTriggerId: string): void {
      clearCloseTimer();
      clearOpenTimer();

      // 已由该触发器打开着就不重复触发（鼠标在触发器上微小移动会反复触发 mouseenter）
      if (open && triggerId === nextTriggerId) {
        return;
      }

      cancelOpenTimer = options.schedule(HOVER_OPEN_DELAY_MS, () => {
        cancelOpenTimer = null;
        openWith(nextTriggerId, 'hover', false);
      });
    },

    hoverEnd(): void {
      clearOpenTimer();
      if (!open) {
        return;
      }
      /**
       * **触摸/键盘打开后忽略紧随其后的悬停移开**。
       *
       * 这是本项目实测到的一个真实缺陷：触摸 tap 在 Chromium 里会合成
       * `mouseenter` → `click` → `mouseleave` 序列。`click` 打开菜单后，
       * 合成的 `mouseleave` 会安排一次延迟关闭，把用户刚点开的菜单关掉 ——
       * 表现为"点 ⋮ 没反应"，且**只在触摸通道暴露**（鼠标用户不会走到这条路径）。
       *
       * 判据是"当前这次打开不是悬停触发的"：既然不是悬停开的，悬停移开就不该关它。
       * 悬停开的菜单仍然照常按延迟关闭。
       */
      if (reason !== 'hover') {
        return;
      }
      clearCloseTimer();
      /**
       * 延迟关闭而不是立即关闭：给用户从触发器移动到菜单的余裕。
       * 若立即关，鼠标一走开菜单就消失，根本点不到菜单项。
       */
      cancelCloseTimer = options.schedule(HOVER_CLOSE_DELAY_MS, () => {
        cancelCloseTimer = null;
        close('outside-click', false);
      });
    },

    touchToggle(nextTriggerId: string): void {
      if (open && triggerId === nextTriggerId) {
        close('item-activated', false);
        return;
      }
      openWith(nextTriggerId, 'touch', false);
    },

    keyboardOpen(nextTriggerId: string): void {
      if (open && triggerId === nextTriggerId) {
        // 键盘再按一次是"收起"，且必须回焦以便继续 Tab
        close('escape', true);
        return;
      }
      openWith(nextTriggerId, 'keyboard', true);
    },

    escape(): boolean {
      if (!open) {
        return false;
      }
      close('escape', true);
      return true;
    },

    outsideClick(): boolean {
      if (!open) {
        return false;
      }
      close('outside-click', true);
      return true;
    },

    itemActivated(): void {
      if (!open) {
        return;
      }
      close('item-activated', false);
    },

    dispose(): void {
      clearOpenTimer();
      clearCloseTimer();
      if (open) {
        options.onClose?.(triggerId, 'dispose');
      }
      open = false;
      triggerId = null;
      reason = null;
      focusTarget = null;
      pendingFocusMenu = false;
    },
  };
}

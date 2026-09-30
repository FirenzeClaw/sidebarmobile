// sidebarmobile — 图标子菜单渲染（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T071：把状态机接到 DOM（ARIA menu + 定位 + 三通道）

import { clearElement, createElement, requireElement } from './dom.ts';
import { createIcon, type IconName } from './icons.ts';
import { createHoverMenu, type HoverMenu, type MenuOpenReason } from './hover-menu.ts';

/**
 * [DONE] 图标子菜单的 DOM 层（`hover-menu.ts` 提供状态机，这里负责画与定位）。
 *
 * ARIA menu 模式（契约 ui-states.md §悬停图标子菜单）：
 * - 触发器：`aria-haspopup="menu"` + `aria-expanded`；
 * - 菜单：`role="menu"`；项：`role="menuitem"`；
 * - 键盘打开后焦点移入第一项；方向键在项间循环；Esc 关闭并**回焦触发器**。
 *
 * 三条打开通道都由本模块接到真实事件上（悬停/触摸/键盘），因此"能不能用键盘开"这件事
 * 在实现层就无法被漏掉 —— 状态机与 DOM 是分开测的，但接线只有这一处。
 *
 * 定位采用"放在锚点下方，空间不够就上翻"（MASTER.md §2「近底部自动上翻」）。
 * 菜单是**全局单实例**：所有上下文共用一个 `#iconMenu` 元素，避免多个菜单同时可见。
 */

/** 一个菜单项 */
export interface IconMenuItem {
  icon: IconName;
  label: string;
  /** 危险操作（如删除/关闭）用错误色 */
  danger?: boolean;
  onSelect(): void;
}

export interface IconMenuOptions {
  /** 定位用的侧栏容器 */
  container: HTMLElement;
}

export interface IconMenuController {
  /**
   * 为一个触发器挂菜单。
   *
   * 同一个触发器重复调用时先撤销旧的接线，避免刷新后累积多份监听器
   * （标签列表每次刷新都会重建行，旧元素被丢弃但监听器若挂在容器上会累积）。
   * 传 null 或未挂载的元素会被静默跳过 —— 接线点有多处，逐个判空容易漏。
   */
  attach(trigger: HTMLElement | null, items: () => IconMenuItem[], anchor?: HTMLElement | null): void;
  /** 撤销某触发器的接线 */
  detach(trigger: HTMLElement): void;
  /**
   * 撤销所有**已脱离文档**的触发器的接线（终审 [建议修改]）。
   *
   * 必要性：视图重绘会重建行元素，旧元素被丢弃 —— 但它是本表（及它所持有的监听器）的**键**，
   * 不释放就永远留在表里。实测 200 轮重绘会累积约 5000 个失效接线。
   * 每次重建行之后调用本方法，表的规模就与"当前在 DOM 中的触发器数"一致。
   *
   * 为什么不在 `attach` 里顺手清理：`attach` 是逐触发器调用的，在那里做全表扫描会把
   * 接线变成 O(n²)。清理时机应该是"一批元素刚被重建"之后。
   */
  pruneDetached(): void;
  /** 立刻关闭（切换面板、视图切换时调用） */
  close(): void;
  isOpen(): boolean;
}

/** [DONE] 创建图标菜单控制器 */
export function createIconMenu(options: IconMenuOptions): IconMenuController {
  const menuElement = requireElement('iconMenu');

  /** trigger → 接线信息；用于撤销与"当前打开者"判定 */
  const attachments = new Map<
    HTMLElement,
    {
      anchor: HTMLElement;
      items: () => IconMenuItem[];
      dispose: () => void;
    }
  >();

  /** 待移入焦点的菜单项（键盘打开时为 true） */
  let focusFirstItem = false;

  const menu: HoverMenu = createHoverMenu({
    now: () => Date.now(),
    schedule: (delayMs, run) => {
      const timer = window.setTimeout(run, delayMs);
      return () => {
        window.clearTimeout(timer);
      };
    },
    onOpen: (triggerId) => {
      const trigger = triggerById(triggerId);
      if (trigger === null) {
        return;
      }
      renderItems(trigger);
      showMenu(trigger);
      markExpanded(trigger, true);
      markHostOpen(trigger, true);
    },
    onClose: (triggerId) => {
      hideMenu();
      if (triggerId !== null) {
        const trigger = triggerById(triggerId);
        if (trigger !== null) {
          markExpanded(trigger, false);
          markHostOpen(trigger, false);
          // 只有需要回焦的通道（Esc / 外部点击 / 键盘收起）才会拿到非 null 目标
          const target = menu.focusReturnTarget();
          if (target !== null) {
            trigger.focus();
          }
        }
      }
      focusFirstItem = false;
    },
  });

  /**
   * 触发器标识：用 `data-menu-id` 而不是元素引用做状态机入参。
   *
   * 状态机是纯逻辑（不持有 DOM），且元素会被重建；每次分配一个稳定 id 让"同一个触发器"
   * 的判定不依赖对象身份 —— 刷新后的新元素拿到同样的 id 也能正确关闭旧状态。
   */
  let nextMenuId = 0;
  const idByTrigger = new WeakMap<HTMLElement, string>();
  const triggerByIdMap = new Map<string, HTMLElement>();

  function idFor(trigger: HTMLElement): string {
    const existing = idByTrigger.get(trigger);
    if (existing !== undefined) {
      return existing;
    }
    nextMenuId += 1;
    const id = `menu-trigger-${nextMenuId}`;
    idByTrigger.set(trigger, id);
    triggerByIdMap.set(id, trigger);
    return id;
  }

  function triggerById(id: string | null): HTMLElement | null {
    if (id === null) {
      return null;
    }
    const trigger = triggerByIdMap.get(id);
    // 元素已从文档移除（刷新后丢弃的旧行）时视为不存在，避免对孤儿节点操作
    if (trigger === undefined || !trigger.isConnected) {
      return null;
    }
    return trigger;
  }

  /** [DONE] 同步 aria-expanded，让读屏器知道菜单开合（FR-028） */
  function markExpanded(trigger: HTMLElement, expanded: boolean): void {
    trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  /**
   * [DONE] 给触发器所在的条目行加/去 `menu-open`。
   *
   * 契约要求"关闭按钮在悬停/聚焦时显现"（ui-states.md §紧凑标签栏），而菜单打开时鼠标可能
   * 已不在行上（例如键盘打开、或指针停在菜单上）—— 此时必须靠这个类把 ⋮ 与关闭钮保持可见，
   * 否则用户看不到"菜单是从哪一行开出来的"，也不知道它的状态。
   * 样式选择器（`.site-item.menu-open` / `.tablist-row.menu-open`）已在 app.css 中定义。
   */
  function markHostOpen(trigger: HTMLElement, open: boolean): void {
    const host = trigger.closest('.site-item, .tablist-row');
    if (host === null) {
      return;
    }
    host.classList.toggle('menu-open', open);
  }

  /** [DONE] 渲染菜单项 */
  function renderItems(trigger: HTMLElement): void {
    const attachment = attachments.get(trigger);
    if (attachment === undefined) {
      return;
    }
    clearElement(menuElement);

    for (const item of attachment.items()) {
      const button = createElement('button', {
        class: `menu-btn${item.danger === true ? ' danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        'aria-label': item.label,
        title: item.label,
        tabindex: '-1',
      });
      button.append(createIcon(item.icon));

      button.addEventListener('click', (event) => {
        event.stopPropagation();
        // 先关菜单再执行动作：动作可能删除触发器本身（如关闭标签）
        menu.itemActivated();
        item.onSelect();
      });

      button.addEventListener('keydown', (event) => {
        const items = [...menuElement.querySelectorAll('.menu-btn')].filter(
          (element): element is HTMLElement => element instanceof HTMLElement,
        );
        const index = items.indexOf(event.currentTarget as HTMLElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          event.preventDefault();
          items[(index + 1) % items.length]?.focus();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault();
          items[(index - 1 + items.length) % items.length]?.focus();
        } else if (event.key === 'Home') {
          event.preventDefault();
          items[0]?.focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          items[items.length - 1]?.focus();
        }
      });

      menuElement.append(button);
    }
  }

  /** [DONE] 显示并定位菜单（空间不够时上翻） */
  function showMenu(trigger: HTMLElement): void {
    const attachment = attachments.get(trigger);
    const anchor = attachment?.anchor ?? trigger;

    menuElement.hidden = false;
    // 先隐藏可见性以测量尺寸，否则第一帧会以 0 尺寸计算导致错位
    menuElement.style.visibility = 'hidden';
    menuElement.style.left = '0px';
    menuElement.style.top = '0px';

    const bounds = options.container.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const menuWidth = menuElement.offsetWidth;
    const menuHeight = menuElement.offsetHeight;

    let left = anchorRect.left - bounds.left + anchorRect.width / 2 - menuWidth / 2;
    left = Math.max(6, Math.min(left, bounds.width - menuWidth - 6));

    let top = anchorRect.bottom - bounds.top + 6;
    // 近底部自动上翻：否则菜单会被底栏裁掉或超出可视区
    if (top + menuHeight > bounds.height - 6) {
      top = anchorRect.top - bounds.top - menuHeight - 6;
    }
    top = Math.max(6, top);

    menuElement.style.left = `${left}px`;
    menuElement.style.top = `${top}px`;
    menuElement.style.visibility = '';

    if (focusFirstItem) {
      const first = menuElement.querySelector('.menu-btn');
      if (first instanceof HTMLElement) {
        first.focus();
      }
    }
  }

  function hideMenu(): void {
    menuElement.hidden = true;
    clearElement(menuElement);
  }

  /**
   * 全局关闭：Esc 与外部点击。
   *
   * 挂在 document 上而不是每个触发器上：菜单是单实例，只要有一处外部交互就该关闭，
   * 逐触发器挂监听会漏掉"菜单开着但焦点/点击落在别处"的情形。
   */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (!menu.isOpen()) {
      // 菜单没开就不消费：让上层处理（例如关闭弹层）
      return;
    }
    event.stopPropagation();
    menu.escape();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.isOpen()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (menuElement.contains(target)) {
      return;
    }
    const openTrigger = triggerById(menu.openTriggerId());
    if (openTrigger !== null && openTrigger.contains(target)) {
      // 点在触发器上交给触发器自己的点击处理（切换语义），这里不关
      return;
    }
    menu.outsideClick();
  }, true);

  return {
    attach(trigger: HTMLElement | null, items: () => IconMenuItem[], anchor?: HTMLElement | null): void {
      /**
       * 接受 null 并静默跳过。
       *
       * 为什么不让调用方保证非空：接线点在多处（标签行、网站条目、底栏、顶栏），
       * 而元素在视图切换/重绘后可能已不存在。逐个调用方加判空容易漏，
       * 漏掉就是一次运行时崩溃（本项目真实发生过：`Cannot read properties of null`）。
       * 在这里统一挡住，接线方就不必重复防御。
       */
      if (trigger === null || !trigger.isConnected) {
        return;
      }
      this.detach(trigger);

      const triggerId = idFor(trigger);
      const resolvedAnchor = anchor ?? trigger;

      // ARIA：声明弹出的是菜单（FR-028）
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');

      const onHoverStart = (): void => {
        menu.hoverStart(triggerId);
      };
      const onHoverEnd = (): void => {
        menu.hoverEnd();
      };
      const onClick = (event: Event): void => {
        event.stopPropagation();
        menu.touchToggle(triggerId);
      };
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        focusFirstItem = !(menu.isOpen() && menu.openTriggerId() === triggerId);
        menu.keyboardOpen(triggerId);
      };
      /**
       * 焦点离开触发器所在条目时关闭。
       *
       * **只在确实移到别处时才关**：`relatedTarget` 为 null 是"焦点丢失"而非"移到外部"
       * （触摸点击、点空白、窗口失焦都会如此）。若对它也关闭，
       * 触摸点击刚刚打开的菜单会被紧随其后的 focusout 立刻关掉 —— 表现为"点 ⋮ 没反应"
       * （本项目真实出现过该缺陷，且只在触摸通道暴露）。
       */
      const onFocusOut = (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (next === null) {
          return;
        }
        if (!(next instanceof Node)) {
          return;
        }
        if (menuElement.contains(next) || resolvedAnchor.contains(next)) {
          return;
        }
        if (menu.isOpen() && menu.openTriggerId() === triggerId) {
          menu.outsideClick();
        }
      };

      resolvedAnchor.addEventListener('mouseenter', onHoverStart);
      resolvedAnchor.addEventListener('mouseleave', onHoverEnd);
      trigger.addEventListener('click', onClick);
      trigger.addEventListener('keydown', onKeydown);
      resolvedAnchor.addEventListener('focusout', onFocusOut);
      // 触发器的 Enter/Space 与行本身的主行为（激活标签）要区分开：
      // 只在触发器上监听，行上的 Enter 仍由行自己处理。

      attachments.set(trigger, {
        anchor: resolvedAnchor,
        items,
        dispose: () => {
          resolvedAnchor.removeEventListener('mouseenter', onHoverStart);
          resolvedAnchor.removeEventListener('mouseleave', onHoverEnd);
          trigger.removeEventListener('click', onClick);
          trigger.removeEventListener('keydown', onKeydown);
          resolvedAnchor.removeEventListener('focusout', onFocusOut);
          triggerByIdMap.delete(triggerId);
        },
      });
    },

    detach(trigger: HTMLElement): void {
      const attachment = attachments.get(trigger);
      if (attachment === undefined) {
        return;
      }
      attachment.dispose();
      attachments.delete(trigger);
      if (menu.openTriggerId() !== null && triggerById(menu.openTriggerId()) === trigger) {
        menu.dispose();
      }
    },

    pruneDetached(): void {
      /**
       * 先收集再删除：`detach` 会改动 `attachments`，在遍历中删除会让迭代器行为不可预期
       * （本项目在 browser-view 的 resize 路径上正是这样死循环过一次）。
       */
      const detached: HTMLElement[] = [];
      for (const trigger of attachments.keys()) {
        if (!trigger.isConnected) {
          detached.push(trigger);
        }
      }
      for (const trigger of detached) {
        this.detach(trigger);
      }
    },

    close(): void {
      /**
       * 关闭菜单但**不产生回焦副作用**。
       *
       * 这里用 `dispose()` 而不是 `outsideClick()`：后者会把触发器记进 `focusReturnTarget`，
       * 而本方法是"视图切换时顺手收起菜单"，此时焦点应由视图切换决定，
       * 不该留下一个指向旧触发器的回焦目标 —— 那会让下一次交互出现意外的焦点跳转。
       */
      if (menu.isOpen()) {
        menu.dispose();
      }
      hideMenu();
    },

    isOpen(): boolean {
      return menu.isOpen();
    },
  };
}

/** [DONE] 供接线方复用的开启原因类型出口 */
export type { MenuOpenReason };

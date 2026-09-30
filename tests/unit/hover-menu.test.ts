// sidebarmobile — 悬停菜单状态机单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T067：先写失败测试（RED，FR-027/FR-028）

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHoverMenu,
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  type HoverMenu,
  type MenuCloseReason,
} from '../../src/sidebar/components/hover-menu.ts';

/**
 * 这些用例测**状态机**（无 DOM），因此"键盘路径"与"鼠标路径"是被同等对待的一等公民：
 * 三条打开通道各有独立用例，关闭路径（Esc / 外部点击 / 选中项）也各有独立用例。
 *
 * 只测鼠标的交互代码在键盘用户那里等于不存在（FR-028），因此这不是可选项。
 */

let menu: HoverMenu;
let clock: { advance(ms: number): void; now(): number };
let scheduled: Array<{ at: number; run: () => void }>;

function makeClock() {
  let current = 0;
  const tasks: Array<{ at: number; run: () => void }> = [];
  scheduled = tasks;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
      for (const task of [...tasks].sort((a, b) => a.at - b.at)) {
        if (task.at <= current) {
          tasks.splice(tasks.indexOf(task), 1);
          task.run();
        }
      }
    },
  };
}

/**
 * 会真正执行取消的定时器替身。
 *
 * 必须支持取消（而不是返回一个空函数）：悬停防抖的全部意义就在"取消"上 ——
 * 用一个不取消的替身，测出来的行为与真实浏览器不同，等于没测。
 */
function makeScheduler(): (delayMs: number, run: () => void) => () => void {
  return (delayMs, run) => {
    scheduled.push({ at: clock.now() + delayMs, run });
    return () => {
      const index = scheduled.findIndex((task) => task.run === run);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    };
  };
}

beforeEach(() => {
  clock = makeClock();
  menu = createHoverMenu({
    now: () => clock.now(),
    schedule: makeScheduler(),
  });
});

describe('初始态', () => {
  it('初始为关闭且无打开者', () => {
    expect(menu.isOpen()).toBe(false);
    expect(menu.openTriggerId()).toBeNull();
    expect(menu.openReason()).toBeNull();
  });
});

describe('通道一：鼠标悬停（延迟 ~150ms 防抖）', () => {
  it('悬停后延迟开启，未到时间仍是关闭', () => {
    menu.hoverStart('btn-1');

    expect(menu.isOpen()).toBe(false);

    clock.advance(HOVER_OPEN_DELAY_MS + 1);

    expect(menu.isOpen()).toBe(true);
    expect(menu.openTriggerId()).toBe('btn-1');
    expect(menu.openReason()).toBe('hover');
  });

  it('快速划过（未到延迟就移开）不打开菜单', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS - 40);
    menu.hoverEnd();

    clock.advance(HOVER_OPEN_DELAY_MS * 3);

    // 这是 150ms 防抖的全部意义：鼠标扫过一整排按钮时不该连开一串菜单
    expect(menu.isOpen()).toBe(false);
  });

  it('悬停移开后延迟关闭（给用户移到菜单上的时间）', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);
    expect(menu.isOpen()).toBe(true);

    menu.hoverEnd();
    // 立即仍开着：否则鼠标从触发器移到菜单的途中菜单就消失了
    expect(menu.isOpen()).toBe(true);

    clock.advance(500);
    expect(menu.isOpen()).toBe(false);
  });

  it('鼠标又移回来会取消待关闭', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);
    menu.hoverEnd();
    menu.hoverStart('btn-1');

    clock.advance(500);

    expect(menu.isOpen()).toBe(true);
  });

  it('悬停打开不请求焦点进入菜单（避免抢走键盘焦点）', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);

    // 鼠标用户不需要焦点跳进菜单；强行跳会让正在别处打字的用户丢失焦点
    expect(menu.shouldFocusMenu()).toBe(false);
  });
});

describe('通道二：触摸点击（立即切换）', () => {
  it('触摸点击立即开启（不走延迟）', () => {
    menu.touchToggle('btn-1');

    expect(menu.isOpen()).toBe(true);
    expect(menu.openTriggerId()).toBe('btn-1');
    expect(menu.openReason()).toBe('touch');
  });

  it('再次触摸同一触发器关闭（切换语义）', () => {
    menu.touchToggle('btn-1');
    menu.touchToggle('btn-1');

    expect(menu.isOpen()).toBe(false);
  });

  /**
   * 这条用例锁定的是一次**真实缺陷**：触摸 tap 在 Chromium 里会合成
   * `mouseenter` → `click` → `mouseleave`；若 `mouseleave` 照常安排延迟关闭，
   * 用户刚点开的菜单会被立刻关掉，表现为"点 ⋮ 没反应"。
   *
   * 修法是：非悬停通道打开的菜单，不受悬停移开影响。
   */
  it('触摸打开后紧随的悬停移开不会关闭菜单', () => {
    menu.touchToggle('btn-1');
    expect(menu.isOpen()).toBe(true);

    // 模拟触摸合成出来的 mouseleave
    menu.hoverEnd();
    clock.advance(HOVER_CLOSE_DELAY_MS * 3);

    expect(menu.isOpen()).toBe(true);
    expect(menu.openTriggerId()).toBe('btn-1');
  });

  it('键盘打开后紧随的悬停移开不会关闭菜单', () => {
    menu.keyboardOpen('btn-1');

    menu.hoverEnd();
    clock.advance(HOVER_CLOSE_DELAY_MS * 3);

    expect(menu.isOpen()).toBe(true);
  });

  it('悬停打开的菜单仍会因悬停移开而关闭（修复没有伤及原行为）', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);
    expect(menu.isOpen()).toBe(true);

    menu.hoverEnd();
    clock.advance(HOVER_CLOSE_DELAY_MS + 1);

    expect(menu.isOpen()).toBe(false);
  });

  it('触摸另一个触发器时切换过去（一次只开一个）', () => {
    menu.touchToggle('btn-1');
    menu.touchToggle('btn-2');

    expect(menu.isOpen()).toBe(true);
    expect(menu.openTriggerId()).toBe('btn-2');
  });

  it('触摸打开不请求焦点进入菜单（触摸端无键盘焦点概念）', () => {
    menu.touchToggle('btn-1');

    expect(menu.shouldFocusMenu()).toBe(false);
  });
});

describe('通道三：键盘（Enter / Space）', () => {
  it('键盘激活立即开启（不走延迟）', () => {
    menu.keyboardOpen('btn-1');

    expect(menu.isOpen()).toBe(true);
    expect(menu.openTriggerId()).toBe('btn-1');
    expect(menu.openReason()).toBe('keyboard');
  });

  it('键盘打开必须把焦点移入菜单第一项（否则键盘用户无法到达菜单项）', () => {
    menu.keyboardOpen('btn-1');

    expect(menu.shouldFocusMenu()).toBe(true);
  });

  it('键盘再次激活同一触发器关闭', () => {
    menu.keyboardOpen('btn-1');
    menu.keyboardOpen('btn-1');

    expect(menu.isOpen()).toBe(false);
  });

  it('键盘激活另一个触发器时切换过去', () => {
    menu.keyboardOpen('btn-1');
    menu.keyboardOpen('btn-2');

    expect(menu.openTriggerId()).toBe('btn-2');
  });

  it('键盘打开不受悬停延迟影响（立即可用）', () => {
    menu.keyboardOpen('btn-1');

    // 不推进时钟就应为开；若实现依赖定时器，键盘用户会感到"按了没反应"
    expect(menu.isOpen()).toBe(true);
  });
});

describe('关闭：Esc 与回焦（FR-027/FR-028）', () => {
  it('Esc 关闭已打开的菜单', () => {
    menu.keyboardOpen('btn-1');

    const closed = menu.escape();

    expect(closed).toBe(true);
    expect(menu.isOpen()).toBe(false);
  });

  it('Esc 返回需要回焦的触发器 id（键盘用户不能丢焦点）', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);

    const closed = menu.escape();

    expect(closed).toBe(true);
    // 关闭后焦点必须回到触发器，否则焦点会落在 body 上、Tab 从页首重新开始
    expect(menu.focusReturnTarget()).toBe('btn-1');
  });

  it('菜单未打开时 Esc 不消费事件（让上层处理）', () => {
    menu.escape();

    expect(menu.isOpen()).toBe(false);
    expect(menu.focusReturnTarget()).toBeNull();
  });

  it('Esc 后待关闭定时器被取消（不残留定时器）', () => {
    menu.hoverStart('btn-1');
    clock.advance(HOVER_OPEN_DELAY_MS + 1);
    menu.hoverEnd();
    menu.escape();

    clock.advance(1000);

    expect(menu.isOpen()).toBe(false);
  });
});

describe('关闭：外部点击', () => {
  it('外部点击关闭菜单', () => {
    menu.keyboardOpen('btn-1');

    const closed = menu.outsideClick();

    expect(closed).toBe(true);
    expect(menu.isOpen()).toBe(false);
  });

  it('外部点击也回焦触发器', () => {
    menu.touchToggle('btn-1');
    menu.outsideClick();

    expect(menu.focusReturnTarget()).toBe('btn-1');
  });

  it('菜单未打开时外部点击不消费事件', () => {
    menu.outsideClick();

    expect(menu.isOpen()).toBe(false);
    expect(menu.focusReturnTarget()).toBeNull();
  });
});

describe('关闭：选中菜单项后', () => {
  it('触发菜单项后关闭', () => {
    menu.keyboardOpen('btn-1');

    menu.itemActivated();

    expect(menu.isOpen()).toBe(false);
  });

  it('触发菜单项后不回焦触发器（焦点应随操作结果走）', () => {
    menu.keyboardOpen('btn-1');
    menu.itemActivated();

    // 例如"删除网站"之后那个触发器已经不存在了，回焦会指向不存在的元素
    expect(menu.focusReturnTarget()).toBeNull();
  });
});

describe('单实例（ui-states.md：触摸环境一次只能打开一个菜单）', () => {
  it('打开新菜单时自动关闭旧的', () => {
    const changes: Array<{ triggerId: string | null; reason: MenuCloseReason | null }> = [];
    menu = createHoverMenu({
      now: () => clock.now(),
      schedule: makeScheduler(),
      onClose: (triggerId, reason) => changes.push({ triggerId, reason }),
    });

    menu.keyboardOpen('btn-1');
    menu.keyboardOpen('btn-2');

    expect(changes).toEqual([{ triggerId: 'btn-1', reason: 'switch' }]);
    expect(menu.openTriggerId()).toBe('btn-2');
  });

  it('同一时刻只记录一个打开者', () => {
    menu.keyboardOpen('btn-1');
    menu.touchToggle('btn-2');
    menu.keyboardOpen('btn-3');

    expect(menu.openTriggerId()).toBe('btn-3');
    expect(menu.isOpen()).toBe(true);
  });
});

describe('关闭通知（供视图层同步 ARIA 与类名）', () => {
  it('关闭时通知触发 id 与原因', () => {
    const closes: Array<{ triggerId: string | null; reason: MenuCloseReason | null }> = [];
    menu = createHoverMenu({
      now: () => clock.now(),
      schedule: makeScheduler(),
      onClose: (triggerId, reason) => closes.push({ triggerId, reason }),
    });

    menu.keyboardOpen('btn-1');
    menu.escape();

    expect(closes).toEqual([{ triggerId: 'btn-1', reason: 'escape' }]);
  });

  it('打开时通知，供视图层挂 aria-expanded=true', () => {
    const opens: string[] = [];
    menu = createHoverMenu({
      now: () => clock.now(),
      schedule: makeScheduler(),
      onOpen: (triggerId) => opens.push(triggerId),
    });

    menu.keyboardOpen('btn-1');

    expect(opens).toEqual(['btn-1']);
  });

  it('hover 延迟未到就被取消时不发打开通知', () => {
    const opens: string[] = [];
    menu = createHoverMenu({
      now: () => clock.now(),
      schedule: makeScheduler(),
      onOpen: (triggerId) => opens.push(triggerId),
    });

    menu.hoverStart('btn-1');
    menu.hoverEnd();
    clock.advance(HOVER_OPEN_DELAY_MS * 2);

    expect(opens).toEqual([]);
  });
});

describe('状态查询与清理', () => {
  it('dispose 取消所有待处理定时器且不残留状态', () => {
    menu.hoverStart('btn-1');
    menu.dispose();

    clock.advance(HOVER_OPEN_DELAY_MS * 3);

    expect(menu.isOpen()).toBe(false);
    expect(menu.openTriggerId()).toBeNull();
  });

  it('openReason 在关闭后清空', () => {
    menu.keyboardOpen('btn-1');
    menu.escape();

    expect(menu.openReason()).toBeNull();
  });

  it('延迟常量在合理区间（太短会误触发，太长会显得没反应）', () => {
    expect(HOVER_OPEN_DELAY_MS).toBeGreaterThanOrEqual(100);
    expect(HOVER_OPEN_DELAY_MS).toBeLessThanOrEqual(250);
  });
});

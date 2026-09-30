// sidebarmobile — 历史栈内跳转单测（测试）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：先写失败测试（RED）—— 九宫格「历史」面板需要按索引跳转

import { beforeEach, describe, expect, it } from 'vitest';
import { createTabSession, type TabSession } from '../../src/sidebar/state/tab-session.ts';

/**
 * 九宫格「历史」面板列出的是**这条标签自己的历史栈**，点击其中一条要回到那个位置。
 *
 * 为什么需要状态层新增一个入口，而不是在 app.ts 里调 `navigate(tabId, url)`：
 * `navigate` 是**新导航**语义 —— 它会截断当前项之后的前向分支再追加。而"回到历史中的某一项"
 * 是**移动**语义，栈本身必须原样保留（这正是浏览器历史列表的行为：从列表点回上一页，
 * 你仍然能再前进回刚才那页）。用 `navigate` 兑现会让用户点一下历史就把后面几条记录
 * 悄悄删掉，且后退/前进按钮跟着失效。
 */

let session: TabSession;
let idCounter: number;
let clockTick: number;

function tickingClock(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 8, 30, 10, 0, clockTick)).toISOString();
}

beforeEach(() => {
  idCounter = 0;
  clockTick = 0;
  session = createTabSession({
    createId: () => `tab-${++idCounter}`,
    now: tickingClock,
  });
});

/** 造一条带历史的三站标签：/a → /b → /c，当前位置在最末 */
function makeThreeStepTab(): string {
  const tab = session.openTab('https://example.com/a');
  const tabId = tab!.tabId;
  session.navigate(tabId, 'https://example.com/b');
  session.navigate(tabId, 'https://example.com/c');
  return tabId;
}

describe('按索引跳转（九宫格历史面板）', () => {
  it('跳到更早的历史项并更新当前地址', () => {
    const tabId = makeThreeStepTab();

    const moved = session.goToIndex(tabId, 0);

    expect(moved).not.toBeNull();
    expect(moved!.currentUrl).toBe('https://example.com/a');
    expect(moved!.historyIndex).toBe(0);
  });

  it('保留前向分支（回到第一项后仍能前进到第三项）', () => {
    const tabId = makeThreeStepTab();

    session.goToIndex(tabId, 0);

    expect(session.getTab(tabId)?.history).toHaveLength(3);
    expect(session.canGoForward(tabId)).toBe(true);
    const forward = session.goForward(tabId);
    expect(forward?.currentUrl).toBe('https://example.com/b');
  });

  it('跳转后来源键随目标地址更新（跨来源历史不得沿用旧来源）', () => {
    const tab = session.openTab('https://example.com/a');
    const tabId = tab!.tabId;
    session.navigate(tabId, 'https://other.example.org/x');

    const moved = session.goToIndex(tabId, 0);

    expect(moved!.originKey).toBe('https://example.com');
  });

  it('跳转置为 loading（导航即将发生，界面需如实呈现）', () => {
    const tabId = makeThreeStepTab();

    expect(session.goToIndex(tabId, 1)?.loadState).toBe('loading');
  });

  it('跳到当前项是空操作（不重复通知、不改变状态）', () => {
    const tabId = makeThreeStepTab();
    let notifications = 0;
    session.onChange(() => {
      notifications += 1;
    });

    const moved = session.goToIndex(tabId, 2);

    expect(moved).toBeNull();
    expect(notifications).toBe(0);
  });

  it('越界索引被拒绝且不改变状态', () => {
    const tabId = makeThreeStepTab();
    const before = session.getTab(tabId)?.currentUrl;

    expect(session.goToIndex(tabId, 99)).toBeNull();
    expect(session.goToIndex(tabId, -1)).toBeNull();
    expect(session.getTab(tabId)?.currentUrl).toBe(before);
  });

  it('非整数索引被拒绝（防止浮点索引取到 undefined 项）', () => {
    const tabId = makeThreeStepTab();

    expect(session.goToIndex(tabId, 1.5)).toBeNull();
  });

  it('不存在的标签返回 null', () => {
    expect(session.goToIndex('tab-missing', 0)).toBeNull();
  });

  it('跳转后标题取自该历史项（不是沿用当前页标题）', () => {
    const tab = session.openTab('https://example.com/a');
    const tabId = tab!.tabId;
    session.navigate(tabId, 'https://example.com/b');
    session.setTitle(tabId, '第二页');
    session.navigate(tabId, 'https://example.com/c');

    const moved = session.goToIndex(tabId, 1);

    expect(moved!.title).toBe('第二页');
  });
});

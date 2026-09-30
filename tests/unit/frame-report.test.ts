// sidebarmobile — frame 上报消息处理单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T050：先写失败单测（RED，FR-020/FR-021/FR-023）

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFrameReportHandler,
  type FrameReportOutcome,
  type FrameReporterDeps,
} from '../../src/background/frame-report.ts';

const OWNED = 'https://example.com';
const OWNED_PAGE = 'https://example.com/page';

let reported: Array<{ tabId: string; url: string; title: string; navKind: string }>;
let openRequests: Array<{ url: string; sourceUrl: string }>;
let deps: FrameReporterDeps;

beforeEach(() => {
  reported = [];
  openRequests = [];
  deps = {
    /** 已注册 content script 的来源集合（模拟授权状态） */
    hasScriptForOrigin: (originKey: string) => originKey === OWNED,
    /** 按 URL 反查它属于哪个已注册标签 */
    findTabByFrameUrl: (url: string) => (url.startsWith(OWNED) ? 'tab-1' : null),
    onFrameNavigated: (update) => reported.push(update),
    onOpenRequest: (request) => openRequests.push(request),
  };
});

describe('frame.report 归属校验（contracts/runtime-messages.md）', () => {
  it('已注册来源的上报被接受并转为标签更新', () => {
    const handler = createFrameReportHandler(deps);

    const outcome = handler.handleReport({
      url: `${OWNED}/next`,
      title: '下一页',
      navKind: 'load',
    });

    expect(outcome).toBe('accepted');
    expect(reported).toEqual([{ tabId: 'tab-1', url: `${OWNED}/next`, title: '下一页', navKind: 'load' }]);
  });

  it('未注册来源的上报被丢弃（不信任发送方）', () => {
    const handler = createFrameReportHandler(deps);

    const outcome = handler.handleReport({
      url: 'https://evil.example.org/x',
      title: '伪造标题',
      navKind: 'load',
    });

    expect(outcome).toBe('dropped-origin');
    expect(reported).toHaveLength(0);
  });

  it('归属来源已注册但找不到对应标签时丢弃（避免串到别的标签）', () => {
    const handler = createFrameReportHandler({ ...deps, findTabByFrameUrl: () => null });

    const outcome = handler.handleReport({ url: OWNED_PAGE, title: 'x', navKind: 'load' });

    expect(outcome).toBe('dropped-no-tab');
    expect(reported).toHaveLength(0);
  });

  it('非 http(s) 的上报被丢弃（URL 策略兜底）', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleReport({ url: 'javascript:alert(1)', title: 'x', navKind: 'load' })).toBe('dropped-invalid');
    expect(handler.handleReport({ url: 'file:///etc/passwd', title: 'x', navKind: 'load' })).toBe('dropped-invalid');
    expect(reported).toHaveLength(0);
  });

  it('title 非字符串时回落到空标题而不是原样透传', () => {
    const handler = createFrameReportHandler(deps);

    handler.handleReport({ url: OWNED_PAGE, title: undefined as unknown as string, navKind: 'load' });

    expect(reported[0]?.title).toBe('');
  });

  it('title 超长时截断（避免恶意站点用超长标题撑爆存储与界面）', () => {
    const handler = createFrameReportHandler(deps);
    const huge = 'A'.repeat(5000);

    handler.handleReport({ url: OWNED_PAGE, title: huge, navKind: 'load' });

    expect((reported[0]?.title.length ?? 0)).toBeLessThanOrEqual(512);
  });
});

describe('SPA 导航类型（research R3 Tier 2）', () => {
  it('load 类型上报被接受', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleReport({ url: OWNED_PAGE, title: 'a', navKind: 'load' })).toBe('accepted');
    expect(reported[0]?.navKind).toBe('load');
  });

  it('history 类型上报被接受（pushState 导航）', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleReport({ url: `${OWNED}/detail`, title: 'b', navKind: 'history' })).toBe('accepted');
    expect(reported[0]?.navKind).toBe('history');
  });

  it('hash 类型上报被接受（锚点导航）', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleReport({ url: `${OWNED}/#sec`, title: 'c', navKind: 'hash' })).toBe('accepted');
    expect(reported[0]?.navKind).toBe('hash');
  });

  it('未知 navKind 被丢弃（不猜测导航性质）', () => {
    const handler = createFrameReportHandler(deps);

    const outcome = handler.handleReport({ url: OWNED_PAGE, title: 'x', navKind: 'reload' as unknown as 'load' });

    expect(outcome).toBe('dropped-invalid');
    expect(reported).toHaveLength(0);
  });
});

describe('同一标签的连续上报（历史与标题合并）', () => {
  it('同一标签的连续上报都转成更新，保持顺序', () => {
    const handler = createFrameReportHandler(deps);

    handler.handleReport({ url: `${OWNED}/a`, title: 'A', navKind: 'load' });
    handler.handleReport({ url: `${OWNED}/b`, title: 'B', navKind: 'history' });
    handler.handleReport({ url: `${OWNED}/c`, title: 'C', navKind: 'history' });

    expect(reported.map((update) => update.url)).toEqual([`${OWNED}/a`, `${OWNED}/b`, `${OWNED}/c`]);
  });

  it('URL 相同但标题变化时仍上报（标题是独立信息）', () => {
    const handler = createFrameReportHandler(deps);

    handler.handleReport({ url: OWNED_PAGE, title: '初始', navKind: 'load' });
    handler.handleReport({ url: OWNED_PAGE, title: '改后', navKind: 'history' });

    expect(reported).toHaveLength(2);
    expect(reported[1]?.title).toBe('改后');
  });

  it('相同 URL 与标题的重复上报被抑制（避免噪声写存储）', () => {
    const handler = createFrameReportHandler(deps);

    handler.handleReport({ url: OWNED_PAGE, title: 'same', navKind: 'load' });
    const duplicate = handler.handleReport({ url: OWNED_PAGE, title: 'same', navKind: 'load' });

    expect(duplicate).toBe('suppressed-duplicate');
    expect(reported).toHaveLength(1);
  });

  it('不同标签的相同上报互不抑制', () => {
    let nextTabId = 0;
    const handler = createFrameReportHandler({
      ...deps,
      findTabByFrameUrl: () => {
        nextTabId += 1;
        return `tab-${nextTabId}`;
      },
    });

    expect(handler.handleReport({ url: OWNED_PAGE, title: 'same', navKind: 'load' })).toBe('accepted');
    expect(handler.handleReport({ url: OWNED_PAGE, title: 'same', navKind: 'load' })).toBe('accepted');
    expect(reported).toHaveLength(2);
  });
});

describe('frame.open-request 处理（spec FR-023/FR-040）', () => {
  it('归属来源的新窗口请求被接受', () => {
    const handler = createFrameReportHandler(deps);

    const outcome = handler.handleOpenRequest({ url: 'https://other.example.org/target', sourceUrl: OWNED_PAGE });

    expect(outcome).toBe('accepted');
    expect(openRequests).toEqual([{ url: 'https://other.example.org/target', sourceUrl: OWNED_PAGE }]);
  });

  it('sourceUrl 不属已注册来源时丢弃（不信任发送方）', () => {
    const handler = createFrameReportHandler(deps);

    const outcome = handler.handleOpenRequest({
      url: 'https://other.example.org/target',
      sourceUrl: 'https://evil.example.org/page',
    });

    expect(outcome).toBe('dropped-origin');
    expect(openRequests).toHaveLength(0);
  });

  it('目标 URL 非法时丢弃（不把 javascript: 之类交给打开流程）', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleOpenRequest({ url: 'javascript:alert(1)', sourceUrl: OWNED_PAGE })).toBe('dropped-invalid');
    expect(openRequests).toHaveLength(0);
  });

  it('目标为同来源时也被接受（站内新窗口同样要转扩展标签）', () => {
    const handler = createFrameReportHandler(deps);

    expect(handler.handleOpenRequest({ url: `${OWNED}/other`, sourceUrl: OWNED_PAGE })).toBe('accepted');
  });
});

describe('安全边界（spec FR-033/FR-034）', () => {
  it('上报结构里不接收额外字段（只取 url/title/navKind）', () => {
    const handler = createFrameReportHandler(deps);

    handler.handleReport({
      url: OWNED_PAGE,
      title: 'ok',
      navKind: 'load',
      // 恶意/异常脚本可能夹带任意字段，必须被忽略
      cookie: 'secret=1',
      cookieValue: 'secret',
      documentHTML: '<script>alert(1)</script>',
    } as unknown as Parameters<typeof handler.handleReport>[0]);

    const serialized = JSON.stringify(reported);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('<script');
    expect(Object.keys(reported[0] ?? {}).sort()).toEqual(['navKind', 'tabId', 'title', 'url']);
  });

  it('返回值里不含外部文本（只有分类结果）', () => {
    const handler = createFrameReportHandler(deps);

    const outcome: FrameReportOutcome = handler.handleReport({ url: OWNED_PAGE, title: 'x', navKind: 'load' });

    expect(typeof outcome).toBe('string');
    expect(outcome).not.toContain('<');
  });
});

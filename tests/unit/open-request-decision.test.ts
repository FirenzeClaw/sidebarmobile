// sidebarmobile — 新窗口请求的接手判定测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 D1：一次点击只能产生一个结果，不得双开

import { describe, expect, it } from 'vitest';
import { decideOpenRequest } from '../../src/sidebar/state/frame-attribution.ts';

const OWNED = 'https://example.com';
const OWNED_PAGE = 'https://example.com/page';

/** 只有已授权来源被追踪 */
const trackedOnlyOwned = (originKey: string): boolean => originKey === OWNED;

/**
 * 终审 D1：一次点击曾产生**两个**标签页 —— 后台无条件 `tabs.create`（回退路径当主路径用），
 * 而 content script 不阻止默认行为，浏览器自己也开一个。
 *
 * 契约必须是"恰好一个结果"：侧栏接手 → 浏览器不开；侧栏拒绝 → 浏览器开（FR-040）。
 * 这个判定就是那份契约的落地点，因此必须穷尽测试。
 */
describe('新窗口请求的接手判定（终审 D1）', () => {
  it('已授权来源的请求被接手', () => {
    const decision = decideOpenRequest(`${OWNED}/target`, OWNED_PAGE, trackedOnlyOwned);

    expect(decision.handled).toBe(true);
    expect(decision.handled && decision.url).toBe(`${OWNED}/target`);
  });

  it('未授权来源的请求不被接手（脚本本就不该存在）', () => {
    const decision = decideOpenRequest('https://evil.example.org/x', 'https://evil.example.org/page', trackedOnlyOwned);

    expect(decision.handled).toBe(false);
  });

  it('目标是非 http(s) 协议时不接手（交给浏览器处理）', () => {
    expect(decideOpenRequest('mailto:a@example.com', OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest('javascript:alert(1)', OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest('file:///etc/passwd', OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
  });

  it('形状非法时不接手（不信任发送方）', () => {
    expect(decideOpenRequest(undefined, OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest('', OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest(`${OWNED}/target`, undefined, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest(42, OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
    expect(decideOpenRequest(`${OWNED}/target`, 42, trackedOnlyOwned).handled).toBe(false);
  });

  it('目标来源非法时不接手', () => {
    expect(decideOpenRequest('not-a-url', OWNED_PAGE, trackedOnlyOwned).handled).toBe(false);
  });

  it('跨来源打开：源已授权、目标是他站，仍被接手（在侧栏内开新标签）', () => {
    const decision = decideOpenRequest('https://other.example.org/x', OWNED_PAGE, trackedOnlyOwned);

    expect(decision.handled).toBe(true);
    expect(decision.handled && decision.originKey).toBe('https://other.example.org');
  });

  it('判定结果带上目标来源键（调用方可直接登记访问）', () => {
    const decision = decideOpenRequest(`${OWNED}/deep/path`, OWNED_PAGE, trackedOnlyOwned);

    expect(decision.handled && decision.originKey).toBe(OWNED);
  });

  it('源 url 的端口必须精确匹配（FR-038 精确来源）', () => {
    const decision = decideOpenRequest(`${OWNED}/target`, 'https://example.com:8443/page', trackedOnlyOwned);

    expect(decision.handled).toBe(false);
  });
});

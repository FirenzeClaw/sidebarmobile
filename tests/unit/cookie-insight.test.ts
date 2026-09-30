// sidebarmobile — Cookie 存在性检测单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T042：先写失败测试（RED，FR-012/FR-033，research R6）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import {
  createCookieInsight,
  SESSION_COOKIE_NAME_HINTS,
  type CookieInsightPort,
} from '../../src/adapters/cookie-insight.ts';

let mock: BrowserMock;
let insight: CookieInsightPort;

beforeEach(() => {
  mock = createBrowserMock();
  insight = createCookieInsight(mock.cookies);
});

describe('会话存在性检测（spec FR-012）', () => {
  it('无 Cookie 时报告未检测到会话', async () => {
    const result = await insight.detectSession('https://example.com');

    expect(result.status).toBe('absent');
    expect(result.cookieCount).toBe(0);
  });

  it('存在 Cookie 时报告检测到会话', async () => {
    mock.cookies.setCookieCountForUrl('https://example.com/', 3);

    const result = await insight.detectSession('https://example.com');

    expect(result.status).toBe('present');
    expect(result.cookieCount).toBe(3);
  });

  it('只返回数量，不返回任何 Cookie 值或名称', async () => {
    mock.cookies.setCookieCountForUrl('https://example.com/', 2);

    const result = await insight.detectSession('https://example.com');

    // 结果对象只允许出现 status / cookieCount / reason 三个字段；不得夹带 cookie 明细
    expect(Object.keys(result).sort()).toEqual(['cookieCount', 'status']);
    expect(JSON.stringify(result)).not.toContain('cookie-0');
    expect(JSON.stringify(result)).not.toContain('cookie-1');
  });

  it('结果可安全序列化到存储：不含 name/value/domain 字段', async () => {
    mock.cookies.setCookieCountForUrl('https://example.com/', 1);

    const result = await insight.detectSession('https://example.com');
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('"name"');
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"domain"');
    expect(serialized).not.toContain('"path"');
    expect(serialized).not.toContain('"secure"');
    expect(serialized).not.toContain('"expirationDate"');
  });

  it('按精确来源查询目标 URL（带端口时也用同一来源）', async () => {
    mock.cookies.setCookieCountForUrl('http://127.0.0.1:8919/', 2);

    const samePort = await insight.detectSession('http://127.0.0.1:8919');
    const otherPort = await insight.detectSession('http://127.0.0.1:8920');

    expect(samePort.status).toBe('present');
    expect(otherPort.status).toBe('absent');
  });

  it('非法来源键返回 unsupported 而不是抛错', async () => {
    const result = await insight.detectSession('not-a-url');

    expect(result.status).toBe('unsupported');
    expect(result.reason).toBeDefined();
  });
});

describe('API 不可用与错误映射（spec FR-036）', () => {
  it('cookies API 缺失时返回 unsupported（权限未授予的真实情况）', async () => {
    const noApi = createCookieInsight(undefined);

    const result = await noApi.detectSession('https://example.com');

    expect(result.status).toBe('unsupported');
    expect(result.cookieCount).toBe(0);
  });

  it('API 抛错时返回 failed 而不是冒泡（不打断侧栏）', async () => {
    const throwing = {
      getAll: async () => {
        throw new Error('cookies API unavailable');
      },
    };
    const failing = createCookieInsight(throwing);

    const result = await failing.detectSession('https://example.com');

    expect(result.status).toBe('failed');
    expect(result.cookieCount).toBe(0);
  });

  it('返回非数组的畸形响应时按 failed 处理', async () => {
    const malformed = {
      getAll: async () => null as unknown as Array<Record<string, unknown>>,
    };
    const port = createCookieInsight(malformed);

    const result = await port.detectSession('https://example.com');

    expect(result.status).toBe('failed');
  });

  it('任何失败路径都不抛异常', async () => {
    const throwing = {
      getAll: async () => {
        throw new Error('boom');
      },
    };
    const port = createCookieInsight(throwing);

    await expect(port.detectSession('https://example.com')).resolves.toBeTypeOf('object');
  });
});

describe('仅请求存在性所需的最小数据（宪法 III 权限最小化）', () => {
  it('查询只传 url，不请求分区/域级明细', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const recording = {
      getAll: async (details: { url: string }) => {
        calls.push(details);
        return [];
      },
    };
    const port = createCookieInsight(recording);

    await port.detectSession('https://example.com/page');

    expect(calls).toHaveLength(1);
    // 只允许 url 一个字段：多传 storeId/domain 等会把查询范围扩大到本来源之外
    expect(Object.keys(calls[0] ?? {})).toEqual(['url']);
  });

  it('每次检测只发起一次查询（不做逐 Cookie 明细遍历）', async () => {
    const getAll = vi.fn(async () => [{ name: 'a' }, { name: 'b' }]);
    const port = createCookieInsight({ getAll });

    await port.detectSession('https://example.com');

    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('数量统计不读取 Cookie 的 name/value 字段', async () => {
    const seen: string[] = [];
    const trapping = {
      getAll: async () => [
        // 用 getter 陷阱记录是否有人真的读过这些字段
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            seen.push('value');
            return 'secret';
          },
        }),
        Object.defineProperty({}, 'name', {
          enumerable: true,
          get() {
            seen.push('name');
            return 'session';
          },
        }),
      ],
    };
    const port = createCookieInsight(trapping as unknown as { getAll(details: { url: string }): Promise<Array<Record<string, unknown>>> });

    const result = await port.detectSession('https://example.com');

    expect(result.cookieCount).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe('会话名提示（用于解释「已检测到会话」，不改变判定）', () => {
  it('提供常见会话 Cookie 名提示常量供 UI 解释使用', () => {
    expect(Array.isArray(SESSION_COOKIE_NAME_HINTS)).toBe(true);
    expect(SESSION_COOKIE_NAME_HINTS.length).toBeGreaterThan(0);
    expect(SESSION_COOKIE_NAME_HINTS).toContain('sessionid');
  });

  it('判定不依赖 Cookie 名（无 host 权限时读不到，也不该依赖）', async () => {
    // 即便返回的 Cookie 名完全不含会话语义，只要存在就报告 present：
    // 「存在性」是唯一能可靠获得的事实（research R6）
    mock.cookies.setCookieCountForUrl('https://example.com/', 1);
    const result = await insight.detectSession('https://example.com');

    expect(result.status).toBe('present');
  });
});

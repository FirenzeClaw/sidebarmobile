// sidebarmobile — URL 策略单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T010：先写失败测试（RED）

import { describe, expect, it } from 'vitest';
import { normalizeUrl, parseUrlInput } from '../../src/shared/url-policy.ts';

describe('parseUrlInput：输入解析与协议校验（spec FR-002/FR-003）', () => {
  it('接受合法的 http 与 https 网址', () => {
    const httpsResult = parseUrlInput('https://example.com/path?query=1');
    expect(httpsResult.ok).toBe(true);
    if (httpsResult.ok) {
      expect(httpsResult.url).toBe('https://example.com/path?query=1');
    }

    const httpResult = parseUrlInput('http://example.com');
    expect(httpResult.ok).toBe(true);
  });

  it('为缺少协议的常见网址补全 https', () => {
    const result = parseUrlInput('example.com/read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://example.com/read');
    }
  });

  it('拒绝 javascript: 协议并给出可理解原因', () => {
    const result = parseUrlInput('javascript:alert(1)');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-protocol');
      expect(result.detail).toContain('http');
    }
  });

  it.each(['data:text/html,<h1>x</h1>', 'file:///C:/secret.txt', 'chrome://settings', 'ftp://example.com/file'])(
    '拒绝非 http/https 协议：%s',
    (input) => {
      const result = parseUrlInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unsupported-protocol');
      }
    },
  );

  it('拒绝空输入与纯空白', () => {
    expect(parseUrlInput('').ok).toBe(false);
    expect(parseUrlInput('   ').ok).toBe(false);
  });

  it('拒绝无法解析的畸形输入', () => {
    const result = parseUrlInput('https://');
    expect(result.ok).toBe(false);
  });

  it('保留原始输入以便用户编辑', () => {
    const rawInput = '  ftp://example.com  ';
    const result = parseUrlInput(rawInput);
    expect(result.raw).toBe(rawInput);
    expect(result.ok).toBe(false);
  });

  it('去掉首尾空白后解析', () => {
    const result = parseUrlInput('  https://example.com  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://example.com/');
    }
  });
});

describe('normalizeUrl：规范化（spec FR-005）', () => {
  it('把默认端口归一为无端口形式', () => {
    expect(normalizeUrl('https://example.com:443/')).toBe('https://example.com/');
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
  });

  it('保留非默认端口', () => {
    expect(normalizeUrl('https://example.com:8443/app')).toBe('https://example.com:8443/app');
  });

  it('主机名转小写', () => {
    expect(normalizeUrl('https://EXAMPLE.com/Path')).toBe('https://example.com/Path');
  });

  it('保留路径与查询串', () => {
    expect(normalizeUrl('https://example.com/a/b?c=1&d=2')).toBe('https://example.com/a/b?c=1&d=2');
  });

  it('去除哈希片段（片段不影响资源身份）', () => {
    expect(normalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });
});

/**
 * 终审 B5：带端口但无协议的输入曾被误判为「不支持的协议」。
 *
 * 根因：补协议判断用的是 `^[a-zA-Z][a-zA-Z0-9+.-]*:` —— `example.com:8080` 里的
 * `example.com:` 恰好匹配"有协议"，于是不补 https，随后 URL 解析出的 protocol 是
 * `example.com:`，被白名单拒绝，并给出「只支持 http 与 https 开头」这一**事实错误的提示**
 * （用户根本没写协议）。
 *
 * 更糟的是行为自相矛盾：`127.0.0.1:8000` 能过（因为 `127.0.0.1:` 不匹配协议正则），
 * 而 `example.com:8080` 被拒 —— 同为"域名:端口"却两种结果。
 */
describe('带端口但无协议的输入（终审 B5 回归）', () => {
  it('example.com:8080 补 https 后接受', () => {
    const result = parseUrlInput('example.com:8080');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://example.com:8080/');
    }
  });

  it('localhost:8000 补 https 后接受', () => {
    const result = parseUrlInput('localhost:8000');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://localhost:8000/');
    }
  });

  it('带路径的域名:端口同样接受', () => {
    const result = parseUrlInput('example.com:8080/x/y');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://example.com:8080/x/y');
    }
  });

  it('127.0.0.1:8000 与域名:端口行为一致', () => {
    const ipResult = parseUrlInput('127.0.0.1:8000');
    const hostResult = parseUrlInput('example.com:8000');

    expect(ipResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
  });

  it('http://example.com:8080 显式协议仍按 http 处理', () => {
    const result = parseUrlInput('http://example.com:8080/x');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('http://example.com:8080/x');
    }
  });

  it('真正的非白名单协议仍被拒绝且提示准确', () => {
    for (const input of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      const result = parseUrlInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unsupported-protocol');
      }
    }
  });

  it('拒绝提示不再误称为「用户没写协议」的情形', () => {
    const result = parseUrlInput('example.com:8080');
    // 该输入应被接受而不是拒绝；这条断言防止回归到"报错说只支持 http/https"
    expect(result.ok).toBe(true);
  });
});

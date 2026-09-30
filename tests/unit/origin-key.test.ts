// sidebarmobile — 精确来源键单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T012：先写失败测试（RED）

import { describe, expect, it } from 'vitest';
import { originKeyFromUrl, originKeyToString, parseOriginKey, sameOriginKey } from '../../src/shared/origin-key.ts';

describe('originKeyFromUrl：精确来源提取（spec FR-005）', () => {
  it('拆出协议、主机与端口', () => {
    const key = originKeyFromUrl('https://example.com:8443/app?x=1');
    expect(key).not.toBeNull();
    expect(key?.scheme).toBe('https');
    expect(key?.host).toBe('example.com');
    expect(key?.port).toBe(8443);
  });

  it('默认端口归一为 null', () => {
    expect(originKeyFromUrl('https://example.com/')?.port).toBeNull();
    expect(originKeyFromUrl('http://example.com/')?.port).toBeNull();
  });

  it('同一来源的不同路径产生相同键', () => {
    const first = originKeyFromUrl('https://example.com/a');
    const second = originKeyFromUrl('https://example.com/b/deep?q=1');
    expect(sameOriginKey(first, second)).toBe(true);
  });

  it('协议不同视为不同来源', () => {
    const https = originKeyFromUrl('https://example.com/');
    const http = originKeyFromUrl('http://example.com/');
    expect(sameOriginKey(https, http)).toBe(false);
  });

  it('端口不同视为不同来源', () => {
    const defaultPort = originKeyFromUrl('https://example.com/');
    const customPort = originKeyFromUrl('https://example.com:8443/');
    expect(sameOriginKey(defaultPort, customPort)).toBe(false);
  });

  it('子域名视为不同来源（不做主域名合并）', () => {
    const root = originKeyFromUrl('https://example.com/');
    const sub = originKeyFromUrl('https://app.example.com/');
    expect(sameOriginKey(root, sub)).toBe(false);
  });

  it('非法 URL 返回 null', () => {
    expect(originKeyFromUrl('not a url')).toBeNull();
    expect(originKeyFromUrl('ftp://example.com/')).toBeNull();
  });
});

describe('originKeyToString / parseOriginKey：序列化往返', () => {
  it('无端口时序列化不带端口', () => {
    const key = originKeyFromUrl('https://example.com/');
    expect(key === null ? null : originKeyToString(key)).toBe('https://example.com');
  });

  it('带端口时序列化含端口', () => {
    const key = originKeyFromUrl('https://example.com:8443/');
    expect(key === null ? null : originKeyToString(key)).toBe('https://example.com:8443');
  });

  it('序列化可被解析回等价键', () => {
    const original = originKeyFromUrl('http://localhost:8919/spa');
    const text = original === null ? '' : originKeyToString(original);
    const parsed = parseOriginKey(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.scheme).toBe('http');
    expect(parsed?.host).toBe('localhost');
    expect(parsed?.port).toBe(8919);
  });

  it('解析非法字符串返回 null', () => {
    expect(parseOriginKey('')).toBeNull();
    expect(parseOriginKey('ftp://example.com')).toBeNull();
    expect(parseOriginKey('example.com')).toBeNull();
  });
});

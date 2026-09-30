// sidebarmobile — 权限撤销监听测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：capabilities.changed 生产者的行为

import { describe, expect, it } from 'vitest';
import { originKeyFromPattern, watchPermissionRemovals } from '../../src/background/permission-watch.ts';

describe('host 权限 pattern 折回来源键', () => {
  it('普通 pattern', () => {
    expect(originKeyFromPattern('https://example.com/*')).toBe('https://example.com');
  });

  it('带非默认端口的 pattern 保留端口', () => {
    expect(originKeyFromPattern('https://example.com:8443/*')).toBe('https://example.com:8443');
  });

  it('默认端口归一为空（与 origin-key.ts 一致）', () => {
    expect(originKeyFromPattern('https://example.com:443/*')).toBe('https://example.com');
    expect(originKeyFromPattern('http://example.com:80/*')).toBe('http://example.com');
  });

  it('非法或非 http(s) 返回 null', () => {
    expect(originKeyFromPattern('')).toBeNull();
    expect(originKeyFromPattern('about:blank')).toBeNull();
    expect(originKeyFromPattern('<all_urls>')).toBeNull();
  });
});

/** 收集回调参数的替身 */
function createFakePermissionsApi() {
  let listener: ((removed: { permissions?: string[]; origins?: string[] }) => void) | null = null;
  return {
    api: {
      onRemoved: {
        addListener(next: (removed: { permissions?: string[]; origins?: string[] }) => void): void {
          listener = next;
        },
      },
    },
    emit(removed: { permissions?: string[]; origins?: string[] }): void {
      listener?.(removed);
    },
    hasListener(): boolean {
      return listener !== null;
    },
  };
}

/**
 * 终审 [建议修改]：契约声明了 `capabilities.changed` 由"权限被外部撤销"触发，
 * 但全项目没有任何代码订阅 `permissions.onRemoved` —— 该消息从来没有生产者，
 * 于是用户在浏览器设置里撤销权限后，侧栏会一直显示旧状态（FR-030 要求的回归不会发生）。
 */
describe('权限撤销监听（终审 [建议修改]）', () => {
  it('订阅后收到 host 权限撤销即回调来源键', () => {
    const fake = createFakePermissionsApi();
    const revoked: string[][] = [];
    watchPermissionRemovals({
      permissions: fake.api,
      onOriginsRevoked: (keys) => revoked.push(keys),
    });

    fake.emit({ origins: ['https://example.com/*'] });

    expect(revoked).toEqual([['https://example.com']]);
  });

  it('没有 origins 时不回调（API 权限撤销不影响按来源的判定）', () => {
    const fake = createFakePermissionsApi();
    const revoked: string[][] = [];
    watchPermissionRemovals({
      permissions: fake.api,
      onOriginsRevoked: (keys) => revoked.push(keys),
    });

    fake.emit({ permissions: ['cookies'] });

    expect(revoked).toEqual([]);
  });

  it('多个来源一次撤销时合并为一次回调', () => {
    const fake = createFakePermissionsApi();
    const revoked: string[][] = [];
    watchPermissionRemovals({
      permissions: fake.api,
      onOriginsRevoked: (keys) => revoked.push(keys),
    });

    fake.emit({ origins: ['https://a.example.com/*', 'https://b.example.com/*'] });

    expect(revoked).toEqual([['https://a.example.com', 'https://b.example.com']]);
  });

  it('非法 pattern 被丢弃，不产生空回调', () => {
    const fake = createFakePermissionsApi();
    const revoked: string[][] = [];
    watchPermissionRemovals({
      permissions: fake.api,
      onOriginsRevoked: (keys) => revoked.push(keys),
    });

    fake.emit({ origins: ['<all_urls>'] });

    expect(revoked).toEqual([]);
  });

  it('重复来源去重', () => {
    const fake = createFakePermissionsApi();
    const revoked: string[][] = [];
    watchPermissionRemovals({
      permissions: fake.api,
      onOriginsRevoked: (keys) => revoked.push(keys),
    });

    fake.emit({ origins: ['https://example.com/*', 'https://example.com:443/*'] });

    expect(revoked).toEqual([['https://example.com']]);
  });

  it('API 不可用时不订阅也不抛错', () => {
    expect(() => {
      watchPermissionRemovals({ permissions: undefined, onOriginsRevoked: () => undefined });
    }).not.toThrow();
  });
});

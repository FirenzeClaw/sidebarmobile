// sidebarmobile — 权限适配集成测试（测试）
// 2026-09-29 | Kimi(speckit-implement) | T032：先写失败集成测试（RED，FR-010/FR-035/FR-030）

import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserMock, type BrowserMock } from '../helpers/mock-browser.ts';
import { createPermissionsPort, type PermissionRequestSpec } from '../../src/adapters/permissions.ts';
import { originPatternFromOriginKey } from '../../src/adapters/ua-override.ts';

let mock: BrowserMock;

beforeEach(() => {
  mock = createBrowserMock();
});

describe('权限申请（spec FR-010/FR-035）', () => {
  it('用户同意时返回 granted 并记录已授予', async () => {
    const port = createPermissionsPort(mock.permissions);
    const spec: PermissionRequestSpec = {
      permissions: ['declarativeNetRequestWithHostAccess'],
      origins: ['https://example.com/*'],
    };

    const outcome = await port.request(spec);

    expect(outcome).toBe('granted');
    expect(await port.contains(spec)).toBe(true);
  });

  it('用户拒绝时返回 denied 而不是抛异常（降级为正常路径）', async () => {
    mock.permissions.setNextRequestResult(false);
    const port = createPermissionsPort(mock.permissions);

    const outcome = await port.request({ permissions: ['declarativeNetRequestWithHostAccess'], origins: [] });

    expect(outcome).toBe('denied');
  });

  it('浏览器不支持该 API 时返回 unsupported 而不是抛异常', async () => {
    const port = createPermissionsPort(undefined);

    const outcome = await port.request({ permissions: [], origins: [] });

    expect(outcome).toBe('unsupported');
  });

  it('request 抛异常时映射为 denied 或 unsupported，绝不冒泡', async () => {
    const throwingPermissions = {
      request: async () => {
        throw new Error('browser rejected the request');
      },
      contains: async () => false,
      remove: async () => false,
    };
    const port = createPermissionsPort(throwingPermissions);

    await expect(port.request({ permissions: [], origins: [] })).resolves.toBeTypeOf('string');
  });
});

describe('权限复核（spec FR-030）', () => {
  it('未申请过时 contains 返回 false', async () => {
    const port = createPermissionsPort(mock.permissions);
    expect(await port.contains({ permissions: ['cookies'], origins: ['https://example.com/*'] })).toBe(false);
  });

  it('授权后 contains 返回 true', async () => {
    const port = createPermissionsPort(mock.permissions);
    const spec: PermissionRequestSpec = { permissions: ['cookies'], origins: ['https://example.com/*'] };
    await port.request(spec);

    expect(await port.contains(spec)).toBe(true);
  });

  it('API 不可用时 contains 保守返回 false（不谎报持有）', async () => {
    const port = createPermissionsPort(undefined);
    expect(await port.contains({ permissions: ['cookies'], origins: [] })).toBe(false);
  });

  it('contains 抛异常时保守返回 false', async () => {
    const throwingPermissions = {
      request: async () => true,
      contains: async () => {
        throw new Error('boom');
      },
      remove: async () => true,
    };
    const port = createPermissionsPort(throwingPermissions);

    expect(await port.contains({ permissions: ['cookies'], origins: [] })).toBe(false);
  });
});

describe('权限撤销（spec FR-013）', () => {
  it('撤销后 contains 转为 false', async () => {
    const port = createPermissionsPort(mock.permissions);
    const spec: PermissionRequestSpec = { permissions: ['cookies'], origins: ['https://example.com/*'] };
    await port.request(spec);
    expect(await port.contains(spec)).toBe(true);

    const outcome = await port.remove(spec);

    expect(outcome).toBe('removed');
    expect(await port.contains(spec)).toBe(false);
  });

  it('撤销未申请的权限不抛异常', async () => {
    const port = createPermissionsPort(mock.permissions);

    await expect(port.remove({ permissions: ['cookies'], origins: ['https://example.com/*'] })).resolves.toBeTypeOf(
      'string',
    );
  });

  it('API 不可用时撤销返回 unsupported', async () => {
    const port = createPermissionsPort(undefined);
    expect(await port.remove({ permissions: [], origins: [] })).toBe('unsupported');
  });

  it('撤销抛异常时不冒泡', async () => {
    const throwingPermissions = {
      request: async () => true,
      contains: async () => true,
      remove: async () => {
        throw new Error('boom');
      },
    };
    const port = createPermissionsPort(throwingPermissions);

    await expect(port.remove({ permissions: [], origins: [] })).resolves.toBeTypeOf('string');
  });
});

describe('外部撤销后的回归（spec FR-030）', () => {
  it('浏览器设置里撤销权限后 contains 转为 false', async () => {
    const port = createPermissionsPort(mock.permissions);
    const spec: PermissionRequestSpec = {
      permissions: ['declarativeNetRequestWithHostAccess'],
      origins: ['https://example.com/*'],
    };
    await port.request(spec);
    expect(await port.contains(spec)).toBe(true);

    // 模拟用户去浏览器设置里移除该权限（不经扩展的 remove 路径）
    mock.permissions.revokeExternally(spec);

    expect(await port.contains(spec)).toBe(false);
  });

  it('只撤销来源权限时 API 权限仍在（两者独立复核）', async () => {
    const port = createPermissionsPort(mock.permissions);
    const full: PermissionRequestSpec = {
      permissions: ['declarativeNetRequestWithHostAccess'],
      origins: ['https://example.com/*'],
    };
    await port.request(full);

    mock.permissions.revokeExternally({ origins: ['https://example.com/*'] });

    // 来源权限没了，整条 spec 的复核必然失败（DNR 需要 host 权限才能命中该来源）
    expect(await port.contains(full)).toBe(false);
    // 但纯 API 权限部分仍持有：说明撤销是分来源的、不是一刀切
    expect(await port.contains({ permissions: ['declarativeNetRequestWithHostAccess'], origins: [] })).toBe(true);
  });

  it('request 抛错时下一次调用恢复正常（错误不粘滞）', async () => {
    const port = createPermissionsPort(mock.permissions);
    mock.permissions.failNextCallWith(new Error('transient'));

    expect(await port.request({ permissions: ['cookies'], origins: ['https://example.com/*'] })).toBe('denied');
    expect(await port.request({ permissions: ['cookies'], origins: ['https://example.com/*'] })).toBe('granted');
  });
});

describe('host 权限 pattern 生成（contracts/manifest-permissions.md）', () => {
  it('无端口来源生成 scheme://host/*', () => {
    expect(originPatternFromOriginKey('https://example.com')).toBe('https://example.com/*');
  });

  it('带端口来源把端口写进 pattern', () => {
    expect(originPatternFromOriginKey('https://example.com:8443')).toBe('https://example.com:8443/*');
  });

  it('http 来源保持 http scheme', () => {
    expect(originPatternFromOriginKey('http://127.0.0.1:8919')).toBe('http://127.0.0.1:8919/*');
  });

  it('非法来源键返回 null', () => {
    expect(originPatternFromOriginKey('not-a-url')).toBeNull();
    expect(originPatternFromOriginKey('ftp://example.com')).toBeNull();
    expect(originPatternFromOriginKey('')).toBeNull();
  });

  it('端口不进入 host 部分（host 与端口必须分离，否则 pattern 非法）', () => {
    const pattern = originPatternFromOriginKey('http://127.0.0.1:8919');
    expect(pattern).not.toContain('127.0.0.1:8919:');
    expect(pattern).toBe('http://127.0.0.1:8919/*');
  });
});

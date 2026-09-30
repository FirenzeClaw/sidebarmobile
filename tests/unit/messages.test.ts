// sidebarmobile — 消息协议单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T014：先写失败测试（RED）

import { describe, expect, it } from 'vitest';
import {
  createErrorResponse,
  createOkResponse,
  isKnownMessageType,
  validateRuntimeMessage,
} from '../../src/shared/messages.ts';

describe('validateRuntimeMessage：消息形状校验（contracts/runtime-messages.md）', () => {
  it('接受合法的权限申请消息', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.request-grant',
      payload: { originKey: 'https://example.com', grant: 'ua' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('permissions.request-grant');
    }
  });

  it('接受 cookie 授权类型', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.request-grant',
      payload: { originKey: 'https://example.com', grant: 'cookie' },
    });
    expect(result.ok).toBe(true);
  });

  it('拒绝未知的 grant 取值', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.request-grant',
      payload: { originKey: 'https://example.com', grant: 'everything' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-message');
    }
  });

  it('拒绝非法的 originKey', () => {
    const result = validateRuntimeMessage({
      type: 'permissions.request-grant',
      payload: { originKey: 'ftp://example.com', grant: 'ua' },
    });
    expect(result.ok).toBe(false);
  });

  it('接受 frame.report 并校验 url 合法', () => {
    const result = validateRuntimeMessage({
      type: 'frame.report',
      payload: { url: 'https://example.com/a', title: '标题', navKind: 'history' },
    });
    expect(result.ok).toBe(true);
  });

  it('拒绝 frame.report 中的非法 url', () => {
    const result = validateRuntimeMessage({
      type: 'frame.report',
      payload: { url: 'javascript:alert(1)', title: 'x', navKind: 'load' },
    });
    expect(result.ok).toBe(false);
  });

  it('拒绝未知消息类型', () => {
    const result = validateRuntimeMessage({ type: 'unknown.thing', payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-message');
    }
  });

  it('拒绝缺失 payload 的消息', () => {
    const result = validateRuntimeMessage({ type: 'capabilities.query' });
    expect(result.ok).toBe(false);
  });

  it('拒绝非对象消息', () => {
    expect(validateRuntimeMessage(null).ok).toBe(false);
    expect(validateRuntimeMessage('hi').ok).toBe(false);
    expect(validateRuntimeMessage(42).ok).toBe(false);
  });

  it('不再接受已移除的死类型（终审 [建议修改]）', () => {
    /**
     * 这三种消息在契约里声明过但全项目没有任何生产者或使用者，已从协议中移除。
     * 断言它们**被拒绝**，是防止协议面重新长出"看起来存在其实没人用"的通道。
     */
    expect(validateRuntimeMessage({ type: 'tabs.open-external', payload: { url: 'https://a.com/', where: 'current' } }).ok).toBe(false);
    expect(validateRuntimeMessage({ type: 'ua.sync-rules', payload: { originKey: 'https://a.com', enabled: true } }).ok).toBe(false);
    expect(validateRuntimeMessage({ type: 'session.dirty', payload: { persisted: false } }).ok).toBe(false);
  });
});

describe('isKnownMessageType：类型判别', () => {
  it('识别契约中定义的发送方向类型', () => {
    expect(isKnownMessageType('permissions.request-grant')).toBe(true);
    expect(isKnownMessageType('permissions.revoke-grant')).toBe(true);
    expect(isKnownMessageType('capabilities.query')).toBe(true);
    expect(isKnownMessageType('frame.report')).toBe(true);
    expect(isKnownMessageType('frame.open-request')).toBe(true);
  });

  it('拒绝未定义类型（未知消息一律忽略）', () => {
    expect(isKnownMessageType('random.type')).toBe(false);
    expect(isKnownMessageType('')).toBe(false);
  });
});

describe('响应信封（spec FR-029 错误不伪造成功）', () => {
  it('成功响应只含 ok 与 data', () => {
    const response = createOkResponse({ applied: true });
    expect(response).toEqual({ ok: true, data: { applied: true } });
  });

  it('错误响应含 code 与面向用户的 message', () => {
    const response = createErrorResponse('invalid-url', '该地址不被支持');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('invalid-url');
      expect(response.error.message).toBe('该地址不被支持');
    }
  });

  it('错误响应不暴露内部堆栈', () => {
    const response = createErrorResponse('storage-failed', '会话可能无法完整恢复');
    expect(JSON.stringify(response)).not.toContain('at ');
  });
});

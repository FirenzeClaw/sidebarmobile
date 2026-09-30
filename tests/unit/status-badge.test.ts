// sidebarmobile — 能力状态文案单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T039：徽章文案与 ui-states.md 逐字对齐（FR-029/SC-005）

import { describe, expect, it } from 'vitest';
import {
  capabilityBadges,
  cookieBadgeFor,
  DENIED_NOTICE,
  displayModeHint,
  embedBadgeFor,
  navigationBadgeFor,
  uaBadgeFor,
} from '../../src/sidebar/components/status-badge.ts';
import { createCapabilityState } from '../../src/shared/capability-state.ts';

describe('UA 徽章文案（contracts/ui-states.md 徽章表）', () => {
  it('未授权 → 「UA：未授权」中性灰', () => {
    expect(uaBadgeFor('unauthorized')).toEqual({ label: 'UA：未授权', tone: 'neutral' });
  });

  it('真实 UA 生效 → 正常色', () => {
    expect(uaBadgeFor('active')).toEqual({ label: 'UA：真实移动 UA', tone: 'ok' });
  });

  it('已授权但没落地 → 「已降级为移动视口」警示色', () => {
    expect(uaBadgeFor('degraded')).toEqual({ label: 'UA：已降级为移动视口', tone: 'warn' });
  });

  it('浏览器不支持 → 警示色，且与「已降级」文案不同', () => {
    expect(uaBadgeFor('unsupported').tone).toBe('warn');
    expect(uaBadgeFor('unsupported').label).not.toBe(uaBadgeFor('degraded').label);
  });

  it('unknown → 中性灰，不冒充可用', () => {
    expect(uaBadgeFor('unknown').tone).toBe('neutral');
  });
});

describe('Cookie 徽章文案', () => {
  it('已检测到会话 → 正常色', () => {
    expect(cookieBadgeFor('available')).toEqual({ label: 'Cookie：已检测到会话', tone: 'ok' });
  });

  it('未授权 → 中性灰', () => {
    expect(cookieBadgeFor('unauthorized')).toEqual({ label: 'Cookie：未授权', tone: 'neutral' });
  });

  it('能力受限 → 警示色（不是未授权，也不是可用）', () => {
    expect(cookieBadgeFor('limited').tone).toBe('warn');
  });
});

describe('导航与嵌入徽章文案', () => {
  it('Tier 1 不确定态 → 「地址可能未同步」中性灰', () => {
    expect(navigationBadgeFor('uncertain')).toEqual({ label: '导航：地址可能未同步', tone: 'neutral' });
  });

  it('嵌入未知不冒充正常', () => {
    expect(embedBadgeFor('unknown')).toEqual({ label: '嵌入：未知', tone: 'neutral' });
  });
});

describe('禁止把降级伪装成成功（spec SC-005）', () => {
  it('没有任何状态的文案同时声称「真实 UA」与「视口」', () => {
    const states = ['unknown', 'unauthorized', 'active', 'degraded', 'failed', 'unsupported'] as const;
    for (const state of states) {
      const { label } = uaBadgeFor(state);
      const mentionsRealUa = label.includes('真实');
      const mentionsViewport = label.includes('视口');
      expect(mentionsRealUa && mentionsViewport).toBe(false);
    }
  });

  it('降级态绝不使用正常色，正常态绝不使用警示色', () => {
    expect(uaBadgeFor('degraded').tone).not.toBe('ok');
    expect(uaBadgeFor('active').tone).toBe('ok');
    expect(cookieBadgeFor('available').tone).toBe('ok');
    expect(cookieBadgeFor('limited').tone).not.toBe('ok');
  });

  it('完整徽章集合按固定顺序给出四项', () => {
    const badges = capabilityBadges(createCapabilityState());

    expect(badges).toHaveLength(4);
    expect(badges.map((badge) => badge.label)).toEqual([
      'UA：未授权',
      'Cookie：未授权',
      '导航：地址可能未同步',
      '嵌入：未知',
    ]);
  });
});

describe('提示文案（runtime-messages.md 错误码表）', () => {
  it('拒绝授权提示逐字对齐', () => {
    expect(DENIED_NOTICE).toBe('未授权，已使用降级模式');
  });

  it('移动模式提示明确说视口而不是真实 UA', () => {
    expect(displayModeHint('mobile')).toBe('当前以移动视口显示');
    expect(displayModeHint('mobile')).not.toContain('真实');
  });

  it('桌面模式提示说的是版面而不是 UA', () => {
    expect(displayModeHint('desktop')).toBe('当前以桌面版面请求');
  });
});

describe('能力状态到徽章的端到端一致性', () => {
  it('未授权来源的四项徽章全部为中性或不确定态', () => {
    const badges = capabilityBadges(createCapabilityState());

    expect(badges.every((badge) => badge.tone === 'neutral')).toBe(true);
  });

  it('真实 UA 生效时 UA 徽章转为正常色，其余不受影响', () => {
    const state = createCapabilityState({
      ua: { grant: 'granted', permissionHeld: true, ruleApplied: true },
    });
    const badges = capabilityBadges(state);

    expect(badges[0]?.tone).toBe('ok');
    expect(badges[1]?.tone).toBe('neutral');
  });
});

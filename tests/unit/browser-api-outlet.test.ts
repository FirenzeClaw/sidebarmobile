// sidebarmobile — 适配层出口约束测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 C1：浏览器 API 只能从 adapters/browser-api.ts 出

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '..', '..', 'src');

/** 递归列出 src 下所有 .ts 文件 */
function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * 去掉注释后再匹配，避免把"讨论 browser.*"的说明文字当成违规用法。
 *
 * 只处理行注释与块注释两种形态；本项目不生成字符串里的伪代码，因此这个粒度足够。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 终审 C1：宪法 VII 要求浏览器 API 只从 `adapters/browser-api.ts` 出口访问，
 * 但实际有 7 处直接引用 `browser.*`（background 与 content 各自 import 了 polyfill）。
 *
 * 这条约束用测试锁住，理由与 FR-029 的文案断言相同：它是**结构契约**，
 * 靠人工审查守不住 —— 新增一处 `browser.tabs` 不会让任何既有测试失败。
 */
describe('浏览器 API 出口约束（宪法 VII，终审 C1）', () => {
  const files = listSourceFiles(SRC_DIR);

  it('扫描到了源文件（防止路径写错导致断言空转）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('只有 adapters 目录 import webextension-polyfill', () => {
    const offenders = files.filter((file) => {
      const relative = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (relative.startsWith('adapters/')) {
        return false;
      }
      const withoutComments = stripComments(readFileSync(file, 'utf8'));
      return withoutComments.includes('webextension-polyfill');
    });

    expect(offenders.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });

  it('除 browser-api.ts 外无直接的 browser.* 成员访问', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      // browser-api.ts 是出口本身；permissions.ts 只在注释里提到 polyfill（无成员访问）
      if (relative === 'adapters/browser-api.ts') {
        continue;
      }
      const withoutComments = stripComments(readFileSync(file, 'utf8'));
      /**
       * 匹配 `browser.<成员>` 或 `chrome.<成员>`。
       *
       * 不匹配 `__BROWSER__`（构建期常量，全大写）与 `browserNamespace(...)`（出口函数）——
       * 后者的实参是字符串，不是成员访问。
       */
      if (/(^|[^A-Za-z0-9_$.])(browser|chrome)\.[a-zA-Z]/.test(withoutComments)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});

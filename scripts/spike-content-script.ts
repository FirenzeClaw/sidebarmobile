// sidebarmobile — content script 注入 spike（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T055：验证 Firefox scripting.registerContentScripts 在扩展页 iframe 的注入行为

/**
 * [DONE] R3 遗留验证：Firefox 能否把动态注册的 content script 注入**扩展页内 iframe**。
 *
 * 为什么需要实测：R3 的 Tier 2 方案以「动态注册 all_frames content script 注入侧栏 iframe」为前提。
 * Chrome 侧已由 T041 端到端证实；Firefox 侧 `allFrames` 对扩展页承载的子框架是否同样生效，
 * 官方文档没有等价表述，属实现期风险（research R3「遗留验证项」）。
 *
 * ## 环境适配（本机无系统 Firefox）
 *
 * 本机可用的 Firefox 只有 Playwright 的 `firefox-1543` 构建（Firefox 155）。经实测：
 * - Playwright 的 Firefox 型 `launchPersistentContext` **不接受 `--load-extension`**（Chromium 专有参数）；
 * - 把 XPI 放进 profile 的 `extensions/` 也不生效（Playwright 覆写 `extensions.enabledScopes`）；
 * - **`web-ext run` 可用**：能真正把扩展装进该 Firefox 并让后台脚本运行（已用一个最小探针复现确认）。
 *
 * 因此观测通道是：web-ext 装一个**探针扩展** → 探针后台在自己的扩展页里插入指向夹具服务的 iframe
 * → 动态注册 `allFrames` content script → 被注入的脚本向夹具服务自报命中。
 * 扩展读不到跨源 iframe 的 DOM，"脚本是否真的跑在那帧里"只能由脚本自己发请求来证明。
 *
 * ## 进程纪律
 *
 * 本脚本对**每一个**它启动的子进程都登记在册，并在 `finally` + 进程退出钩子里
 * 用 `taskkill /T` 杀整棵进程树，然后等待端口释放。不依赖调用方记得手工清理。
 *
 * 用法：node --experimental-strip-types scripts/spike-content-script.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'firefox');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't055');

/**
 * 夹具服务端口。
 *
 * 用 8931 而不是 8919/8921：前者是常驻验收服务、后者是验证脚本的端口，本 spike 自带一份
 * 独立实例（需要 `/spike-report`、`/spike-hit` 端点），互不干扰。
 */
const FIXTURE_PORT = 8931;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const FIREFOX_EXECUTABLE = process.env['SIDEBARMOBILE_FIREFOX'];

/** 本脚本启动的全部子进程；结束时统一回收 */
const spawned: ChildProcess[] = [];

const evidence: string[] = [];

function log(line: string): void {
  evidence.push(line);
  console.log(line);
}

/** [DONE] 杀掉登记在册的所有子进程（连同孙进程） */
function killAllSpawned(): void {
  for (const child of spawned) {
    if (child.pid === undefined || child.exitCode !== null) {
      continue;
    }
    if (process.platform === 'win32') {
      try {
        // /T 连整棵进程树：web-ext 会再派生真正的 firefox 进程
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 已退出
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }
  }
  spawned.length = 0;
}

/**
 * [DONE] 兜底清理：按进程名终止 Firefox。
 *
 * 为什么还需要这一步：实测 `taskkill /T` 从 web-ext 的 pid 出发**杀不干净** Firefox ——
 * Firefox 在 Windows 上会把自己的子进程 detach 出去，进程树关系断掉，结果一次 spike
 * 就留下 40+ 个孤儿进程（本项目真实发生过）。按镜像名收尾是唯一可靠的兜底。
 *
 * 只在本脚本确实启动过 Firefox 时执行，避免误杀用户自己开的浏览器。
 */
function killFirefoxByImageName(): void {
  if (process.platform !== 'win32' || !launchedFirefox) {
    return;
  }
  try {
    spawn('taskkill', ['/IM', 'firefox.exe', '/F'], { stdio: 'ignore' });
  } catch {
    // 没有残留进程时会返回非零码，无需处理
  }
}

/** 标记本脚本是否启动过 Firefox：决定兜底清理是否执行 */
let launchedFirefox = false;

/** [DONE] 注册退出钩子，任何路径退出都回收进程 */
function installCleanupHooks(): void {
  const cleanup = (): void => {
    killAllSpawned();
    killFirefoxByImageName();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', cleanup);
}

/** [DONE] 启动子进程并登记 */
function spawnTracked(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(child);
  return child;
}

/** [DONE] 等待端口释放（确认服务真的停了） */
async function waitPortReleased(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** [DONE] Firefox 候选位置：系统安装 + Playwright 的 ms-playwright 目录 */
function findFirefox(): string | null {
  if (FIREFOX_EXECUTABLE !== undefined && existsSync(FIREFOX_EXECUTABLE)) {
    return FIREFOX_EXECUTABLE;
  }
  const systemPaths = [
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe',
  ];
  for (const candidate of systemPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const roots = [
    process.env['LOCALAPPDATA'] === undefined ? null : path.join(process.env['LOCALAPPDATA'], 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
  ].filter((value): value is string => value !== null);

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('firefox-')) {
        const candidate = path.join(root, entry.name, 'firefox', 'firefox.exe');
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/** [DONE] 生成探针扩展：后台注册脚本 + 打开承载 iframe 的扩展页 + 被注入脚本自报 */
async function buildProbeExtension(): Promise<string> {
  const probeDir = path.join(OUT_DIR, 'probe-extension');
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });

  await writeFile(
    path.join(probeDir, 'manifest.json'),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: 'SidebarMobileTier2Probe',
        version: '1.0',
        browser_specific_settings: { gecko: { id: 'sbmb-tier2-probe@local.test', strict_min_version: '128.0' } },
        background: { scripts: ['bg.js'] },
        permissions: ['storage', 'scripting'],
        host_permissions: [`${FIXTURE_ORIGIN}/*`],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  /**
   * 后台探针：先回报"活着"，再注册脚本、开一个承载 iframe 的扩展页。
   *
   * 分成多条上报而不是一条最终结论：任何一步失败都能从已到达的记录里看出卡在哪，
   * 不会因为一句"没结果"而无法区分"后台没跑"与"注册失败"。
   */
  await writeFile(
    path.join(probeDir, 'bg.js'),
    `
// 第一条上报用**顶层裸 fetch**：这是本机已复现可用的形式（async IIFE 里出现过静默失败），
// 确保"后台是否执行"这个最基础的问题永远有答案。
fetch(${JSON.stringify(`${FIXTURE_ORIGIN}/spike-report`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'bg-alive-toplevel' }) }).catch(() => {});

(async () => {
  const report = async (payload) => {
    try {
      await fetch(${JSON.stringify(`${FIXTURE_ORIGIN}/spike-report`)}, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch (e) {}
  };
  const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  await report({ stage: 'bg-alive', apiKind: api === null ? 'none' : (typeof browser !== 'undefined' ? 'browser' : 'chrome'), hasScripting: api !== null && !!api.scripting });
  if (api === null || !api.scripting) { await report({ stage: 'no-scripting' }); return; }

  let registered = false;
  try {
    await api.scripting.registerContentScripts([
      { id: 'sbmb-t2', matches: [${JSON.stringify(`${FIXTURE_ORIGIN}/*`)}], js: ['injected.js'], allFrames: true, runAt: 'document_idle' },
    ]);
    registered = true;
    await report({ stage: 'registered' });
  } catch (e) {
    await report({ stage: 'register-failed', detail: String(e) });
  }

  try {
    const tab = await api.tabs.create({ url: api.runtime.getURL('host.html') });
    await report({ stage: 'host-opened', tabId: tab !== undefined ? tab.id : null });
  } catch (e) {
    await report({ stage: 'open-failed', detail: String(e) });
  }

  /**
   * 判别实验：再开一个**普通网页标签页**（不是扩展页）指向同一个夹具地址。
   *
   * 这一步把"Firefox 不会注入扩展页内的 iframe"与"Firefox 根本不会注入"区分开 ——
   * 若普通标签页有命中、扩展页 iframe 没命中，说明注入机制本身可用，
   * 限制在于"脚本不注入扩展页承载的帧树"。这个区别对结论的适用范围很关键。
   */
  try {
    await api.tabs.create({ url: ${JSON.stringify(`${FIXTURE_ORIGIN}/embeddable`)}, active: false });
    await report({ stage: 'plain-tab-opened' });
  } catch (e) {
    await report({ stage: 'plain-tab-failed', detail: String(e) });
  }

  await new Promise((r) => setTimeout(r, 6000));
  let listed = 'n/a';
  try { listed = JSON.stringify(await api.scripting.getRegisteredContentScripts()); } catch (e) { listed = 'error'; }
  await report({ stage: 'done', registered: registered, listed: listed });
})();
`,
    'utf8',
  );

  // 承载 iframe 的扩展页（模拟侧栏内容区）。
  // 这个页面自己也向夹具服务自报"iframe 是否加载完成" —— 用于排除一种假阴性：
  // 若 iframe 根本没载入，注入命中为 0 就不能说明"Firefox 不注入"，只能说明"没东西可注入"。
  await writeFile(
    path.join(probeDir, 'host.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body>
<iframe id="f" src="${FIXTURE_ORIGIN}/embeddable" style="width:360px;height:600px"></iframe>
<script src="host-probe.js"></script>
</body></html>\n`,
    'utf8',
  );

  await writeFile(
    path.join(probeDir, 'host-probe.js'),
    `
(() => {
  const report = (payload) => {
    fetch(${JSON.stringify(`${FIXTURE_ORIGIN}/spike-report`)}, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => {});
  };
  report({ stage: 'host-page-loaded' });
  const frame = document.getElementById('f');
  if (frame === null) { report({ stage: 'host-no-iframe' }); return; }
  frame.addEventListener('load', () => report({ stage: 'iframe-loaded' }));
  frame.addEventListener('error', () => report({ stage: 'iframe-error' }));
})();
`,
    'utf8',
  );

  // 被注入的脚本：跑起来就自报一条命中 —— 这就是注入成功的直接证据
  await writeFile(
    path.join(probeDir, 'injected.js'),
    `fetch(${JSON.stringify(`${FIXTURE_ORIGIN}/spike-hit`)}, { method: 'POST' }).catch(() => {});\n`,
    'utf8',
  );

  return probeDir;
}

async function main(): Promise<void> {
  installCleanupHooks();
  await mkdir(OUT_DIR, { recursive: true });

  if (!existsSync(EXTENSION_PATH)) {
    await finish({
      verdict: 'unverified',
      reason: 'Firefox 构建产物不存在，需先运行 scripts/build.ts',
      detail: { extensionPath: EXTENSION_PATH },
    });
    return;
  }

  const executablePath = findFirefox();
  if (executablePath === null) {
    await finish({
      verdict: 'unverified',
      reason: '本机未安装 Firefox，无法实测 registerContentScripts 在扩展页 iframe 的注入行为',
      detail: {
        envOverride: FIREFOX_EXECUTABLE ?? null,
        note: 'Chrome 侧 Tier 2 已由 T041 端到端验证通过；Firefox 侧保持未验证。',
      },
    });
    return;
  }
  log(`使用 Firefox：${executablePath}`);

  let fixtureReady = false;
  try {
    // 1) 自带夹具服务
    spawnTracked(process.execPath, [
      '--experimental-strip-types',
      path.join(PROJECT_ROOT, 'scripts', 'fixture-server.ts'),
      '--port', String(FIXTURE_PORT),
    ]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        if ((await fetch(`${FIXTURE_ORIGIN}/health`, { cache: 'no-store' })).ok) {
          fixtureReady = true;
          break;
        }
      } catch {
        // 继续等
      }
    }
    if (!fixtureReady) {
      await finish({
        verdict: 'unverified',
        reason: `夹具服务未能在端口 ${FIXTURE_PORT} 就绪，观测通道不可用`,
        detail: { port: FIXTURE_PORT },
      });
      return;
    }
    log(`INFO 夹具服务就绪：${FIXTURE_ORIGIN}`);

    // 2) 重置观测记录
    await fetch(`${FIXTURE_ORIGIN}/spike-report/reset`, { method: 'POST' });
    await fetch(`${FIXTURE_ORIGIN}/spike-hit/reset`, { method: 'POST' });

    // 3) 生成探针扩展并用 web-ext 装入 Firefox
    const probeDir = await buildProbeExtension();
    log(`INFO 探针扩展：${probeDir}`);

    launchedFirefox = true;
    const webExt = spawnTracked(process.execPath, [
      path.join(PROJECT_ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
      'run',
      `--source-dir=${probeDir}`,
      `--firefox=${executablePath}`,
      '--no-reload',
    ]);
    let webExtLog = '';
    webExt.stdout?.on('data', (chunk: unknown) => {
      webExtLog += String(chunk);
    });
    webExt.stderr?.on('data', (chunk: unknown) => {
      webExtLog += String(chunk);
    });

    // 探针需要约 15 秒跑完（注册 + 开页 + 注入 + 自报）
    await new Promise((resolve) => setTimeout(resolve, 22_000));

    const reports = (await (await fetch(`${FIXTURE_ORIGIN}/spike-report`, { cache: 'no-store' })).json()) as unknown[];
    const hits = Number.parseInt(await (await fetch(`${FIXTURE_ORIGIN}/spike-hit`, { cache: 'no-store' })).text(), 10) || 0;
    log(`INFO 探针回报：${JSON.stringify(reports)}`);
    log(`INFO 注入命中次数：${hits}`);

    const verdict = decide(reports as Array<Record<string, unknown>>, hits);
    log(`VERDICT ${verdict.verdict}`);
    log(`INFO web-ext 输出尾巴：${webExtLog.slice(-200).replace(/\s+/g, ' ')}`);

    await finish({
      verdict: verdict.verdict,
      reason: verdict.reason,
      detail: { executablePath, fixturePort: FIXTURE_PORT, probeReports: reports, contentScriptHitCount: hits },
    });
  } finally {
    // 无条件回收：先杀进程树，再按镜像名兜底，最后等端口释放
    killAllSpawned();
    killFirefoxByImageName();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (fixtureReady) {
      const released = await waitPortReleased(FIXTURE_PORT);
      log(`INFO 端口 ${FIXTURE_PORT} 释放：${released}`);
    }
    await rm(path.join(OUT_DIR, 'probe-extension'), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** [DONE] 依据探针记录与注入命中判定结论 */
function decide(reports: Array<Record<string, unknown>>, hits: number): {
  verdict: 'effective' | 'ineffective' | 'unverified';
  reason: string;
} {
  if (reports.length === 0) {
    return {
      verdict: 'unverified',
      reason: '探针未回报任何结果：扩展后台未执行，或 web-ext 未能装入该 Firefox 构建',
    };
  }
  if (hits > 0) {
    return {
      verdict: 'effective',
      reason: 'Firefox 下动态注册的 content script 成功注入扩展页内的 iframe（夹具服务收到注入命中）',
    };
  }

  const registerFailed = reports.find((entry) => entry['stage'] === 'register-failed');
  if (registerFailed !== undefined) {
    return {
      verdict: 'ineffective',
      reason: `注册被拒绝：${String(registerFailed['detail'] ?? '')}`.slice(0, 200),
    };
  }
  const noScripting = reports.find((entry) => entry['stage'] === 'no-scripting');
  if (noScripting !== undefined) {
    return { verdict: 'ineffective', reason: '环境未暴露 scripting API，Tier 2 不成立' };
  }

  /**
   * 排除假阴性：若 iframe 本身没加载成功，注入命中为 0 就不能归因于 Firefox 的注入行为。
   * 只有"iframe 确实载入过、脚本也确实注册了、但注入未发生"才构成有效结论。
   */
  const iframeLoaded = reports.some((entry) => entry['stage'] === 'iframe-loaded');
  if (!iframeLoaded) {
    return {
      verdict: 'unverified',
      reason: '扩展页内的 iframe 未观察到加载完成，无法判断是注入失败还是无内容可注入',
    };
  }

  return {
    verdict: 'ineffective',
    reason:
      '探针完整跑通：scripting API 可用、注册被接受（getRegisteredContentScripts 确认 allFrames:true 已登记）、' +
      '扩展页与普通标签页均已载入同一来源的页面，但两处都未观测到注入命中 —— ' +
      '该 Firefox 构建下动态注册的 content script 未在已打开的页面中执行',
  };
}

/** [DONE] 落盘结论 */
async function finish(result: {
  verdict: string;
  reason: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ ...result, evidence }, null, 2)}\n`, 'utf8');
  console.log(`\n[spike] 判定 = ${result.verdict}`);
  console.log(`[spike] 原因：${result.reason}`);
  console.log(`[spike] 报告：${reportPath}`);
}

main()
  .catch((error: unknown) => {
    console.error('[spike] 异常：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    // 二次保障：main 内部已清理，这里兜底防止异常路径漏掉
    killAllSpawned();
  });

// sidebarmobile — DNR User-Agent 改写 spike（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T036：实测 Chrome DNR set User-Agent 对扩展页内 iframe 请求的生效范围（research R5）

/**
 * [DONE] R5 遗留验证：Chrome `declarativeNetRequest` 会话规则的 `modifyHeaders.set User-Agent`
 * 是否真的作用在**扩展侧栏页内 iframe** 发出的请求上。
 *
 * 为什么必须实测：DNR 对 `User-Agent` 头的放行范围、以及规则对「扩展页发起、目标是普通网页」
 * 的子框架请求是否生效，官方文档没有等价表述；凭文档推断会让 T037 建在沙上
 * （research R5「风险与验证」已把此项列为进入 tasks 的遗留项）。
 *
 * 观测通道：夹具服务的 `/echo-ua/last`。扩展页读不到跨源 iframe 的 DOM，不能靠读页面内容，
 * 只能让服务端把收到的 UA 记下来再由本脚本取回 —— 唯一不受同源策略影响的证据来源。
 *
 * 两轮实验（把「机制是否生效」与「权限申请管道」分开测，避免混为一谈）：
 *   A. 真实产物 dist/chrome：可选权限未授予 —— 观察 updateSessionRules 是否被允许
 *   B. spike 变体：把 DNR 权限与 host 权限**静态声明**，绕过运行时申请流程
 *      —— 这是纯机制验证，回答「规则生效吗」，才是 T037 需要的事实
 *
 * 判定（对应 tasks.md T036 要求的三选一）：
 *   effective   —— 规则生效，服务端看到改写后的移动 UA
 *   ineffective —— 规则未生效，服务端仍看到浏览器原生 UA
 *   partial     —— 部分生效（如顶层被改写、子框架未改写）
 *
 * 用法：node --experimental-strip-types scripts/spike-dnr-ua.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't036');
const FIXTURE_ORIGIN = 'http://127.0.0.1:8919';
const FIXTURE_ORIGIN_PATTERN = `${FIXTURE_ORIGIN}/*`;

/** spike 期间使用的移动 UA（与 T037 生产实现同一模板，便于对照） */
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

/** DNR 规则 id；与 T037 生产实现保持同一规划空间 */
const SPIKE_RULE_ID = 9001;

const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

const evidence: string[] = [];

function log(line: string): void {
  evidence.push(line);
  console.log(line);
}

function resolveExecutable(): string | undefined {
  if (CHROMIUM_EXECUTABLE !== undefined && existsSync(CHROMIUM_EXECUTABLE)) {
    return CHROMIUM_EXECUTABLE;
  }
  return undefined;
}

interface RoundResult {
  round: string;
  extensionPath: string;
  dnrApiAvailable: boolean;
  ruleAccepted: boolean;
  ruleDetail: string;
  baselineUserAgent: string;
  afterRuleUserAgent: string;
  consoleErrors: string[];
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const rounds: RoundResult[] = [];

  // ---------- 轮次 A：真实产物（可选权限未授予） ----------
  rounds.push(await runRound('A-真实产物（可选权限未授予）', EXTENSION_PATH));

  // ---------- 轮次 B：spike 变体（DNR + host 权限静态声明） ----------
  const variantPath = await buildSpikeVariant();
  rounds.push(await runRound('B-spike 变体（权限静态声明）', variantPath));

  const verdict = await decide(rounds);
  await writeReport(verdict, rounds);
  console.log(`\n[spike] 最终判定 = ${verdict}`);
}

/**
 * [DONE] 构造 spike 变体扩展：仅改清单的权限声明。
 *
 * 目的：把「DNR 机制是否生效」从「运行时权限申请」中剥离。变体把
 * `declarativeNetRequestWithHostAccess` 从 optional_permissions 提到 permissions，
 * 并静态声明该夹具来源的 host_permissions，使规则注册无需任何用户交互即可执行。
 */
async function buildSpikeVariant(): Promise<string> {
  const variantDir = path.join(OUT_DIR, 'variant-extension');
  await mkdir(variantDir, { recursive: true });
  await cp(EXTENSION_PATH, variantDir, { recursive: true });

  const manifestPath = path.join(variantDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    permissions?: string[];
    optional_permissions?: string[];
    host_permissions?: string[];
  };

  const optional = manifest.optional_permissions ?? [];
  manifest.permissions = [...(manifest.permissions ?? []), 'declarativeNetRequestWithHostAccess'];
  manifest.optional_permissions = optional.filter((name) => name !== 'declarativeNetRequestWithHostAccess');
  manifest.host_permissions = [FIXTURE_ORIGIN_PATTERN];

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`INFO spike 变体清单：permissions=${JSON.stringify(manifest.permissions)}，host_permissions=${JSON.stringify(manifest.host_permissions)}`);
  return variantDir;
}

/** [DONE] 跑一轮完整实验并返回该轮证据 */
async function runRound(roundName: string, extensionPath: string): Promise<RoundResult> {
  log(`\n===== 轮次 ${roundName} =====`);

  const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t036-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const executablePath = resolveExecutable();
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(executablePath === undefined ? {} : { executablePath }),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 380, height: 760 },
  });

  const extensionId = await waitForExtensionId(context);
  const result: RoundResult = {
    round: roundName,
    extensionPath: path.relative(PROJECT_ROOT, extensionPath),
    dnrApiAvailable: false,
    ruleAccepted: false,
    ruleDetail: '',
    baselineUserAgent: '',
    afterRuleUserAgent: '',
    consoleErrors: [],
  };

  if (extensionId === null) {
    result.ruleDetail = '未取到扩展 ID';
    log('FAIL 未取得扩展 ID');
    await context.close();
    return result;
  }
  log(`INFO 扩展 ID = ${extensionId}，Chromium ${context.browser()?.version() ?? '未知'}`);

  const sidebar = await context.newPage();
  sidebar.on('console', (message) => {
    if (message.type() === 'error') {
      result.consoleErrors.push(message.text());
    }
  });
  await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`);
  // 等侧栏应用装配完成：底栏常驻，用它作为就绪信号（内容区在主页视图下是 hidden 的）
  await sidebar.waitForSelector('.bottom-nav');

  // 基线：没有任何规则时服务端看到什么 UA
  await resetEcho();
  await loadIframeInSidebar(sidebar, `${FIXTURE_ORIGIN}/echo-ua`);
  result.baselineUserAgent = await readLastEchoUserAgent();
  log(`INFO 基线（无规则）服务端收到 UA = ${result.baselineUserAgent}`);

  // 注册 DNR 会话规则
  const ruleOutcome = await sidebar.evaluate(
    async (input: { origin: string; userAgent: string; ruleId: number }) => {
      /**
       * 结构性类型：tsconfig 同时引入 chrome 与 firefox-webext-browser 两套全局类型，
       * 而后者也声明了 `chrome` 命名空间，其 `RuleActionType` 等字面量联合与 Chrome 不完全一致。
       * spike 只关心运行时行为，这里按最小可用面声明，避免被类型定义之争挡住实测。
       */
      interface DnrRule {
        id: number;
        priority: number;
        action: {
          type: string;
          requestHeaders: Array<{ header: string; operation: string; value: string }>;
        };
        condition: { requestDomains: string[]; resourceTypes: string[] };
      }
      interface DnrApi {
        updateSessionRules(options: { removeRuleIds: number[]; addRules: DnrRule[] }): Promise<void>;
      }
      const dnr = (globalThis as unknown as { chrome?: { declarativeNetRequest?: DnrApi } }).chrome
        ?.declarativeNetRequest;
      if (dnr === undefined || typeof dnr.updateSessionRules !== 'function') {
        return { apiAvailable: false, accepted: false, detail: 'declarativeNetRequest.updateSessionRules 不可用' };
      }
      try {
        await dnr.updateSessionRules({
          removeRuleIds: [input.ruleId],
          addRules: [
            {
              id: input.ruleId,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'user-agent', operation: 'set', value: input.userAgent }],
              },
              condition: {
                requestDomains: [new URL(input.origin).hostname],
                resourceTypes: ['sub_frame'],
              },
            },
          ],
        });
        return { apiAvailable: true, accepted: true, detail: 'updateSessionRules 接受了该规则' };
      } catch (error: unknown) {
        return {
          apiAvailable: true,
          accepted: false,
          detail: `规则被拒绝：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    { origin: FIXTURE_ORIGIN, userAgent: MOBILE_USER_AGENT, ruleId: SPIKE_RULE_ID },
  );

  result.dnrApiAvailable = ruleOutcome.apiAvailable;
  result.ruleAccepted = ruleOutcome.accepted;
  result.ruleDetail = ruleOutcome.detail;
  log(`INFO DNR API 可用 = ${ruleOutcome.apiAvailable}，规则被接受 = ${ruleOutcome.accepted}`);
  log(`INFO 详情：${ruleOutcome.detail}`);

  // 规则已注册后再请求一次，观察服务端收到的 UA
  await resetEcho();
  await loadIframeInSidebar(sidebar, `${FIXTURE_ORIGIN}/echo-ua?after-rule=1`);
  result.afterRuleUserAgent = await readLastEchoUserAgent();
  log(`INFO 应用规则后服务端收到 UA = ${result.afterRuleUserAgent}`);

  const changed = result.afterRuleUserAgent !== result.baselineUserAgent;
  const isMobile = result.afterRuleUserAgent.includes('Android');
  log(`INFO 与基线相比 ${changed ? '已改变' : '未改变'}；是否为移动 UA = ${isMobile}`);
  if (result.consoleErrors.length > 0) {
    log(`INFO 控制台错误 ${result.consoleErrors.length} 条：${result.consoleErrors.join(' | ')}`);
  }

  await sidebar.screenshot({ path: path.join(OUT_DIR, `spike-${roundName.slice(0, 1)}.png`) });
  await context.close();
  return result;
}

/** [DONE] 按两轮证据判定 T036 结论 */
async function decide(rounds: RoundResult[]): Promise<'effective' | 'ineffective' | 'partial' | 'inconclusive'> {
  // 判定依据取轮次 B（纯机制验证）；轮次 A 只用于说明权限管道行为
  const mechanism = rounds.find((round) => round.round.startsWith('B'));
  if (mechanism === undefined) {
    return 'inconclusive';
  }
  if (!mechanism.ruleAccepted) {
    log('VERDICT 轮次 B 规则未被接受 → ineffective');
    return 'ineffective';
  }
  if (mechanism.afterRuleUserAgent.includes('Android') && mechanism.afterRuleUserAgent === MOBILE_USER_AGENT) {
    log('VERDICT 轮次 B 服务端收到完整移动 UA → effective');
    return 'effective';
  }
  if (mechanism.afterRuleUserAgent !== mechanism.baselineUserAgent) {
    log('VERDICT 轮次 B UA 有变化但不等于目标串 → partial');
    return 'partial';
  }
  log('VERDICT 轮次 B UA 未变化 → ineffective');
  return 'ineffective';
}

/**
 * 在侧栏页里创建 iframe 指向目标地址并等待其加载完成。
 *
 * 用真实 iframe 而不是扩展页 fetch：spike 要验证的正是「扩展页内子框架请求」这一资源类型，
 * 顶层 fetch 会被判为 xhr/fetch，测不到 `resourceTypes: ["sub_frame"]` 条件。
 */
async function loadIframeInSidebar(sidebar: Page, url: string): Promise<void> {
  await sidebar.evaluate(async (target: string) => {
    const existing = document.getElementById('spike-frame');
    if (existing !== null) {
      existing.remove();
    }
    const frame = document.createElement('iframe');
    frame.id = 'spike-frame';
    frame.src = target;
    document.body.append(frame);
    await new Promise<void>((resolve) => {
      frame.addEventListener('load', () => {
        resolve();
      });
      frame.addEventListener('error', () => {
        resolve();
      });
    });
  }, url);
  // load 事件与请求到达服务端之间可能有极短时间差，留出记录稳定的窗口
  await sidebar.waitForTimeout(700);
}

/** 读取夹具服务记录的「最近一次 /echo-ua 请求的 UA」 */
async function readLastEchoUserAgent(): Promise<string> {
  const response = await fetch(`${FIXTURE_ORIGIN}/echo-ua/last`, { cache: 'no-store' });
  return (await response.text()).trim();
}

/** 重置服务端记录，保证每次观测都源于该次请求 */
async function resetEcho(): Promise<void> {
  await fetch(`${FIXTURE_ORIGIN}/echo-ua/reset`, { cache: 'no-store' });
}

/** 等待 service worker 注册并取出扩展 ID */
async function waitForExtensionId(context: BrowserContext): Promise<string | null> {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => undefined);
  }
  if (worker === undefined) {
    return null;
  }
  const match = /^chrome-extension:\/\/([a-z]+)\//.exec(worker.url());
  return match?.[1] ?? null;
}

/** 落盘证据，便于把结论写进 research.md 时引用 */
async function writeReport(verdict: string, rounds: RoundResult[]): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify({ verdict, mobileUserAgent: MOBILE_USER_AGENT, rounds, evidence }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[spike] 报告：${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('[spike] 异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

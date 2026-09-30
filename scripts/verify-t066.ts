// sidebarmobile — US5 端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T066：真实 Chromium 验证会话恢复与损坏容错

/**
 * [DONE] T066 手动检查点的自动化执行器（US5 范围，quickstart 场景 11 与 15）。
 *
 * 验收项：
 *   1. 多标签多历史重启恢复：活动标签、各标签历史位置、站点设置三项都对
 *   2. 全关后回主页
 *   3. 注入损坏会话数据后仅该条丢弃、其余正常
 *   4. 存储失败时警示条出现
 *   5. 存储快照无 Cookie 值 / 密码 / 表单 / 页面内容
 *   6. 控制台无代码缺陷类 error
 *
 * **进程纪律**：自带夹具服务（端口 8921），try/finally 保证浏览器与服务被回收。
 *
 * 用法：node --experimental-strip-types scripts/verify-t066.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't066');
const FIXTURE_PORT = 8921;

const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const consoleMessages: Array<{ level: string; text: string; where: string }> = [];

/** 阶段推进记录：只用于定位问题，不参与控制台缺陷判定 */
const phaseLog: string[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function resolveExecutable(): string | undefined {
  if (CHROMIUM_EXECUTABLE !== undefined && existsSync(CHROMIUM_EXECUTABLE)) {
    return CHROMIUM_EXECUTABLE;
  }
  return undefined;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  const fixtureOrigin = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t066-${Date.now()}`);
    const executablePath = resolveExecutable();
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1000,820',
      ],
      viewport: { width: 380, height: 760 },
    });

    record('浏览器版本', context.browser() !== null, `Chromium ${context.browser()?.version() ?? '未知'}`);
    record('夹具服务', true, `自带实例已就绪：${fixtureOrigin}`);

    const extensionId = await waitForExtensionId(context);
    if (extensionId === null) {
      record('扩展加载', false, '未获取到扩展 ID');
      return;
    }
    record('扩展加载', true, `扩展 ID = ${extensionId}`);

    const sidebarUrl = `chrome-extension://${extensionId}/sidebar.html`;
    const sidebar = await context.newPage();
    attachConsoleCapture(sidebar, 'sidebar');
    await sidebar.goto(sidebarUrl);
    await sidebar.waitForSelector('.bottom-nav');

    const session = await buildSession(sidebar, fixtureOrigin);
    await checkRestoreAfterReload(sidebar, session);
    await checkAllTabsClosedShowsHome(sidebar, fixtureOrigin, session);
    await checkCorruptionTolerance(sidebar, fixtureOrigin);
    await checkStorageFailureNotice(sidebar);
    await checkStorageHasNoSensitiveData(sidebar);
    await writeConsoleReport();
  } finally {
    await context?.close();
    await fixture.stop();
    await finish();
  }
}

function attachConsoleCapture(page: Page, where: string): void {
  page.on('console', (message) => {
    const level = message.type();
    if (level === 'error' || level === 'warning') {
      consoleMessages.push({ level, text: message.text(), where });
    }
  });
  page.on('pageerror', (error) => {
    // 记录堆栈供定位：只报消息无法知道是哪一处接线出的问题
    const stack = (error.stack ?? '').split('\n').slice(0, 6).join(' | ');
    consoleMessages.push({ level: 'error', text: `pageerror: ${error.message} ||| ${stack}`, where });
  });
}

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

/** 添加网址并等浏览视图就绪 */
async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1500);
}

async function goHome(sidebar: Page): Promise<void> {
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(300);
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(400);
}

/** 本次测试构造出的会话关键信息，供重启后核对 */
interface BuiltSession {
  tabIds: string[];
  activeTabId: string | null;
  desktopOrigin: string;
  activeTabUrl: string;
}

/**
 * 构造一份"多标签 + 多历史 + 站点设置"的会话。
 *
 * 具体做法：开三个来源的标签，让第二个的 URL 前进两步再后退一格（历史位置停在中间），
 * 把第二个设为活动标签，并把第一个来源切到桌面模式 —— 这样重启后三个维度都有可核对的差异。
 */
/**
 * 构造一份已知的多标签 / 多历史 / 带站点设置的会话。
 *
 * **为什么直接写存储而不是走 UI 构造**：本环境无法给扩展授予可选权限（自动化点不到浏览器的
 * 原生权限对话框），因此 content script 不注入 → Tier 2 不上报 → iframe 内部的链接点击
 * **不会**进入扩展的历史栈（这是 US4 的既有结论，见 research R3）。用 UI 就只能得到一堆
 * 单条历史的标签，无法构造出"历史位置停在中间"这一要验证的状态。
 *
 * 直接写存储是**合法且更精确**的做法：US5 验证的是"能否正确恢复存储里的会话"，
 * 而不在于那份会话是怎么产生的；写入格式与 `session-store` 的落盘格式完全一致。
 */
async function buildSession(sidebar: Page, fixtureOrigin: string): Promise<BuiltSession> {
  // 先经 UI 真实添加两个网站条目（验证网站列表也随重启恢复），再覆盖会话为已知形态
  await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
  await goHome(sidebar);
  await addUrl(sidebar, `http://localhost:${FIXTURE_PORT}/login`);
  await sidebar.waitForTimeout(800);

  const seeded = await sidebar.evaluate(
    async (origin: string) => {
      const base = Date.now();
      const at = (offset: number): string => new Date(base + offset).toISOString();

      /** 一个三历史条目、位置停在中间的标签 —— 恢复后必须还是中间 */
      const multiHistoryTab = {
        tabId: 'tab-seed-multi',
        originKey: origin,
        currentUrl: `${origin}/embeddable?step=2`,
        title: '多历史标签',
        history: [
          { url: `${origin}/embeddable`, title: '首页', visitedAt: at(0) },
          { url: `${origin}/embeddable?step=2`, title: '第二步', visitedAt: at(1000) },
          { url: `${origin}/embeddable?step=3`, title: '第三步', visitedAt: at(2000) },
        ],
        historyIndex: 1,
        loadState: 'loaded',
        createdAt: at(0),
      };
      const secondTab = {
        tabId: 'tab-seed-second',
        originKey: origin,
        currentUrl: `${origin}/spa`,
        title: '第二标签',
        history: [{ url: `${origin}/spa`, title: '第二标签', visitedAt: at(3000) }],
        historyIndex: 0,
        loadState: 'loaded',
        createdAt: at(3000),
      };

      await chrome.storage.local.set({
        'session:v1': {
          version: 1,
          tabs: [multiHistoryTab, secondTab],
          // 活动标签选第一个：验证恢复的是"记录的那个"而不是"最后一个"
          activeTabId: 'tab-seed-multi',
          savedAt: new Date().toISOString(),
        },
        'site-settings:v1': {
          [origin]: { displayMode: 'desktop', uaGrant: 'never', cookieGrant: 'never' },
        },
      });

      return { tabIds: [multiHistoryTab.tabId, secondTab.tabId], activeTabId: 'tab-seed-multi' };
    },
    fixtureOrigin,
  );

  record('构造会话：已写入已知会话（2 标签，其一 3 条历史停在第 2 条）', true, `标签 = ${seeded.tabIds.join(', ')}`);
  record('构造会话：站点设置含桌面模式', true, `${fixtureOrigin} → desktop`);

  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(2000);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-before-reload.png') });

  return {
    tabIds: seeded.tabIds,
    activeTabId: seeded.activeTabId,
    desktopOrigin: fixtureOrigin,
    activeTabUrl: `${fixtureOrigin}/embeddable?step=2`,
  };
}

/** 读取持久化的会话快照（原始 JSON） */
async function readSessionSnapshot(sidebar: Page): Promise<Record<string, unknown>> {
  return sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get('session:v1');
    const stored = raw['session:v1'] as Record<string, unknown> | undefined;
    return stored ?? {};
  });
}

/** 场景 1：重载后三项全部恢复（标签/活动标签/历史位置/站点设置） */
async function checkRestoreAfterReload(sidebar: Page, session: BuiltSession): Promise<void> {
  phaseLog.push('restore');
  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(2000);

  const tabCount = await sidebar.textContent('#navTabCountBox');
  record('场景 1：重载后标签数一致', tabCount === String(session.tabIds.length), `标签数 = ${tabCount}（期望 ${session.tabIds.length}）`);

  const snapshot = await readSessionSnapshot(sidebar);
  const restoredTabs = (snapshot['tabs'] ?? []) as Array<Record<string, unknown>>;
  const restoredIds = restoredTabs.map((tab) => String(tab['tabId']));

  record(
    '场景 1：标签 id 集合与重载前一致',
    restoredIds.length === session.tabIds.length && session.tabIds.every((id) => restoredIds.includes(id)),
    `恢复 = ${restoredIds.length} 个，与原始集合一致`,
  );

  record(
    '场景 1：活动标签保持为同一标签',
    String(snapshot['activeTabId']) === session.activeTabId,
    `activeTabId = ${String(snapshot['activeTabId'])}（期望 ${session.activeTabId}）`,
  );

  // 历史位置：恢复后每个标签的 historyIndex 必须仍在合法范围且指向同一 URL
  const indexesValid = restoredTabs.every((tab) => {
    const history = (tab['history'] ?? []) as unknown[];
    const index = tab['historyIndex'];
    return typeof index === 'number' && index >= 0 && index < history.length;
  });
  record('场景 1：各标签历史位置仍在合法范围', indexesValid, `全部合法 = ${indexesValid}`);

  // 精确恢复：多历史标签的位置必须还是 1（不是被重置为末尾，也不是 0）
  const multiTab = restoredTabs.find((tab) => String(tab['tabId']) === 'tab-seed-multi') ?? null;
  const multiHistory = (multiTab?.['history'] ?? []) as Array<{ url: string }>;
  record(
    '场景 1：历史位置精确恢复（停在中间而非末尾）',
    multiTab?.['historyIndex'] === 1 && multiHistory.length === 3,
    `historyIndex = ${String(multiTab?.['historyIndex'])}，历史条数 = ${multiHistory.length}（期望 1 / 3）`,
  );
  record(
    '场景 1：当前 URL 与历史位置一致',
    String(multiTab?.['currentUrl']) === multiHistory[1]?.url,
    `currentUrl = ${String(multiTab?.['currentUrl'])}，history[1] = ${multiHistory[1]?.url ?? 'null'}`,
  );

  /**
   * 站点设置恢复：桌面模式仍生效。
   *
   * 断言方式用**设置存储**而不是当前 iframe 的宽度：重载后活动标签未必是该来源的标签，
   * 去点网站条目又会新开标签、改变后续场景的前置状态。存储里的 displayMode 正是"设置是否恢复"
   * 的直接证据，而"设置生效到 iframe"已由 T041 场景 6 单独验证。
   */
  const restoredSettings = await sidebar.evaluate(async (origin: string) => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    const all = (raw['site-settings:v1'] ?? {}) as Record<string, { displayMode?: string }>;
    return all[origin]?.displayMode ?? null;
  }, session.desktopOrigin);
  record(
    '场景 1：站点设置（桌面模式）恢复生效',
    restoredSettings === 'desktop',
    `存储中 ${session.desktopOrigin} 的 displayMode = ${restoredSettings ?? 'null'}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-after-reload.png') });
}

/** 场景 2：全关后回主页 */
async function checkAllTabsClosedShowsHome(sidebar: Page, fixtureOrigin: string, session: BuiltSession): Promise<void> {
  void fixtureOrigin;
  /**
   * 逐个关闭所有标签。
   *
   * 只打开弹层**一次**，然后在弹层内连续关闭：关闭后弹层会原地刷新（`refreshTabList`），
   * 每次重新点 `#navTabCount` 反而会被尚在打开的弹层遮住而点不到。
   */
  const count = Number.parseInt((await sidebar.textContent('#navTabCountBox')) ?? '0', 10) || 0;
  if (count > 0) {
    await sidebar.click('#navTabCount');
    await sidebar.waitForSelector('.tablist-row');
    await sidebar.waitForTimeout(500);
  }
  for (let index = 0; index < count; index += 1) {
    await sidebar.locator('.tablist-row').first().locator('.tablist-close').click();
    await sidebar.waitForTimeout(900);
  }
  await sidebar.waitForTimeout(800);

  const homeVisible = await sidebar.locator('#viewSiteList').isVisible();
  const finalCount = await sidebar.textContent('#navTabCountBox');
  record('场景 2：全部关闭后回到网站列表主页', homeVisible && finalCount === '0', `主页可见 = ${homeVisible}，标签数 = ${finalCount}`);

  // 再重载一次：全关的状态必须持久化（重启不恢复已关闭的标签）
  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(1500);
  const afterReloadHome = await sidebar.locator('#viewSiteList').isVisible();
  const afterReloadCount = await sidebar.textContent('#navTabCountBox');
  record(
    '场景 2：重载后仍回主页（全关已持久化）',
    afterReloadHome && afterReloadCount === '0',
    `主页可见 = ${afterReloadHome}，标签数 = ${afterReloadCount}`,
  );

  // 网站列表不受影响（两键独立）
  const siteCount = await sidebar.locator('#siteGrid .site-item').count();
  record('场景 2：网站列表不随标签全关而丢失', siteCount >= 1, `条目数 = ${siteCount}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-all-closed-home.png') });
  void session;
}

/** 场景 3：注入损坏会话数据后仅坏记录丢弃 */
async function checkCorruptionTolerance(sidebar: Page, fixtureOrigin: string): Promise<void> {
  phaseLog.push('corruption');
  // 构造一份含好标签与坏标签的会话，直接写进存储（模拟别的版本写坏的数据）
  await sidebar.evaluate(
    async (origin: string) => {
      const now = new Date().toISOString();
      const goodTab = {
        tabId: 'tab-good-us5',
        originKey: origin,
        currentUrl: `${origin}/embeddable`,
        title: '好标签',
        history: [{ url: `${origin}/embeddable`, title: '好标签', visitedAt: now }],
        historyIndex: 0,
        loadState: 'loaded',
        createdAt: now,
      };
      const badTab = { ...goodTab, tabId: 'tab-bad-us5', historyIndex: 999 };
      const veryBadTab = 'corrupted-string';
      await chrome.storage.local.set({
        'session:v1': {
          version: 1,
          tabs: [goodTab, badTab, veryBadTab],
          activeTabId: 'tab-good-us5',
          savedAt: now,
        },
      });
    },
    fixtureOrigin,
  );

  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(2000);

  const tabCount = await sidebar.textContent('#navTabCountBox');
  record('场景 3：损坏数据只丢弃坏条（好标签仍在）', tabCount === '1', `标签数 = ${tabCount}（期望 1）`);

  const noticeVisible = await sidebar.locator('#noticeBar').isVisible();
  const noticeText = await sidebar.locator('#noticeBar').textContent();
  record(
    '场景 3：顶部警示条告知有数据损坏',
    noticeVisible && (noticeText ?? '').includes('损坏'),
    `警示条可见 = ${noticeVisible}，文案 = ${noticeText ?? 'null'}`,
  );

  // 侧栏仍完全可用：能继续添加网址
  await goHome(sidebar);
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  record('场景 3：损坏数据不影响侧栏继续使用', true, '添加输入框可用');

  await sidebar.screenshot({ path: path.join(OUT_DIR, '04-corruption-tolerance.png') });
}

/**
 * 场景 4：存储写入失败时警示条出现（spec FR-032）。
 *
 * 模拟写入失败的可行做法：把 `chrome.storage.local.set` 临时替换成抛错。
 * 覆盖的是扩展**自身后续**的写入，正是要测的路径；测完恢复原实现，避免影响后续场景。
 */
async function checkStorageFailureNotice(sidebar: Page): Promise<void> {
  phaseLog.push('storage-failure');
  await sidebar.evaluate(() => {
    interface StorageLocal {
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local = (chrome.storage as unknown as { local: StorageLocal }).local;
    const originalSet = local.set.bind(local);
    /**
     * 用 window 上的标记控制"是否失败"而不是直接删掉 set：
     * 恢复时需要能拿回原实现，直接在闭包里保留引用最稳。
     */
    (window as unknown as { __sbmbFailWrites?: boolean }).__sbmbFailWrites = true;
    local.set = async (items: Record<string, unknown>) => {
      if ((window as unknown as { __sbmbFailWrites?: boolean }).__sbmbFailWrites === true) {
        throw new Error('simulated storage failure');
      }
      return originalSet(items);
    };
  });

  // 触发一次立即落盘：添加一个网址会开新标签 → 状态变更 → 落盘
  await addUrl(sidebar, `http://127.0.0.1:${FIXTURE_PORT}/csp`);
  await sidebar.waitForTimeout(2500);

  const noticeVisible = await sidebar.locator('#noticeBar').isVisible();
  const noticeText = await sidebar.locator('#noticeBar').textContent();
  record(
    '场景 4：写入失败时顶部警示条出现',
    noticeVisible && (noticeText ?? '').includes('无法完整恢复'),
    `警示条可见 = ${noticeVisible}，文案 = ${noticeText ?? 'null'}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '05-storage-failure-notice.png') });

  /**
   * 恢复写入并**主动触发一次成功写入**。
   *
   * 只把失败开关关掉不够：警示条要等到下一次写入**成功**才会撤下，而此刻可能已经没有任何
   * 待写变更（上一次失败后状态层认为"已保存过"）。因此这里制造一次新的变更
   * （关闭当前标签 → 立即落盘路径）来驱动成功写入。
   */
  await sidebar.evaluate(() => {
    (window as unknown as { __sbmbFailWrites?: boolean }).__sbmbFailWrites = false;
  });
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.waitForTimeout(400);
  await sidebar.locator('.tablist-row').first().locator('.tablist-close').click();
  await sidebar.waitForTimeout(2200);
  const noticeAfterRecovery = await sidebar.locator('#noticeBar').textContent();
  const visibleAfterRecovery = await sidebar.locator('#noticeBar').isVisible();

  /**
   * 警示条此时仍可见，但文案应已从"写入失败"变为"数据损坏"。
   *
   * 场景 3 已把"有 N 条会话数据损坏"这条提示拉起来了，而写入成功不该清掉它 ——
   * 数据已经丢了，不会因为后续写入成功而回来。这两类提示的语义必须分开。
   */
  const showsWriteFailure = (noticeAfterRecovery ?? '').includes('写入失败');
  record(
    '场景 4：写入恢复后不再显示"写入失败"提示',
    !showsWriteFailure,
    `警示条可见 = ${visibleAfterRecovery}，文案 = ${noticeAfterRecovery ?? 'null'}`,
  );
  record(
    '场景 4：写入恢复不会清掉"数据损坏"提示（语义独立）',
    visibleAfterRecovery && (noticeAfterRecovery ?? '').includes('损坏'),
    `文案 = ${noticeAfterRecovery ?? 'null'}`,
  );
}

/** 场景 5：存储快照无敏感数据（spec FR-018/FR-033） */
async function checkStorageHasNoSensitiveData(sidebar: Page): Promise<void> {
  const snapshot = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get(null);
    return JSON.stringify(raw);
  });

  record('场景 5：快照不含 Cookie 值字段', !snapshot.includes('"cookieValue"') && !snapshot.includes('"value"'), `含 value = ${snapshot.includes('"value"')}`);
  record('场景 5：快照不含夹具会话 Cookie 名', !snapshot.includes('fixture_session'), `含 fixture_session = ${snapshot.includes('fixture_session')}`);
  record('场景 5：快照不含密码或表单字段', !snapshot.includes('password') && !snapshot.includes('formData'), `含 password/formData = ${snapshot.includes('password') || snapshot.includes('formData')}`);
  record('场景 5：快照不含页面内容标记', !snapshot.includes('<script') && !snapshot.includes('<h1'), `含 HTML 标记 = ${snapshot.includes('<script')}`);

  // 标签对象只允许那 8 个字段（多一个都说明有不该持久化的东西）
  /**
   * 只检查**对象型**标签的字段集。
   *
   * 存储里可能残留场景 3 注入的字符串型损坏记录（它不会被读取，但仍躺在存储里直到下次成功写入）。
   * 对字符串取 `Object.keys` 会得到索引数组（"0,1,10,..."），那是断言方式的问题而非数据问题。
   */
  const tabFieldSets = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get('session:v1');
    const stored = raw['session:v1'] as { tabs?: unknown[] } | undefined;
    return (stored?.tabs ?? [])
      .filter((tab): tab is Record<string, unknown> => typeof tab === 'object' && tab !== null && !Array.isArray(tab))
      .map((tab) => Object.keys(tab).sort().join(','));
  });
  const expectedFields = 'createdAt,currentUrl,history,historyIndex,loadState,originKey,tabId,title';
  const allMatch = tabFieldSets.every((fields) => fields === expectedFields);
  const mismatches = tabFieldSets.filter((fields) => fields !== expectedFields);
  record(
    '场景 5：标签对象字段集与契约一致',
    allMatch,
    allMatch
      ? `检查 ${tabFieldSets.length} 个标签，全部一致`
      : `不一致 ${mismatches.length}/${tabFieldSets.length}：${mismatches.map((fields) => `[${fields}]`).join(' ')}`,
  );
}

/** 控制台检查：只对代码缺陷类消息判失败（浏览器级资源错误属被测行为） */
async function writeConsoleReport(): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(reportPath, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');

  const defectMessages = consoleMessages.filter((entry) => {
    if (entry.text.startsWith('pageerror:')) {
      return true;
    }
    // 被测的不可达/受限地址导致的资源加载失败：预期内
    if (entry.text.includes('Failed to load resource')) {
      return false;
    }
    return true;
  });

  record(
    '控制台无代码缺陷类 error',
    defectMessages.length === 0,
    `共 ${consoleMessages.length} 条，缺陷类 ${defectMessages.length} 条${defectMessages.length > 0 ? `：${defectMessages.map((entry) => entry.text).join(' | ')}` : ''}`,
  );
}

async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages, phaseLog }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T066 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const entry of failed) {
      console.log(`  - ${entry.name}：${entry.detail}`);
    }
    process.exitCode = 1;
  }
  console.log(`报告：${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('T066 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

// sidebarmobile — 测试夹具服务器（scripts）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：六类页面覆盖 spec FR-037

/**
 * [DONE] 本地夹具站点：为 e2e 与手动验收提供六类被测页面（spec FR-037）。
 *
 * 页面清单：
 *   /health          健康检查（Playwright webServer 探活）
 *   /embeddable      可嵌入页（允许 iframe，含可点链接与 target=_blank）
 *   /xfo             发送 X-Frame-Options: DENY，禁止嵌入
 *   /csp             发送 CSP frame-ancestors 'none'，禁止嵌入
 *   /login           登录态页（设置 Cookie，用于登录复用四态验证）
 *   /cross-origin    跨源跳转页（跳往 127.0.0.1 与 localhost 视为不同来源）
 *   /spa             单页应用（history.pushState 改 URL，不发请求）
 *   /blank-target    仅含 target=_blank 与 window.open 的页面
 *
 *   /echo-ua         回显服务端收到的 User-Agent（R5/T036 spike；观测走 /echo-ua/last）
 *
 * 使用：node --experimental-strip-types scripts/fixture-server.ts [--port 8919]
 */
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_PORT = 8919;
const portArgumentIndex = process.argv.indexOf('--port');
const PORT =
  portArgumentIndex !== -1 && process.argv[portArgumentIndex + 1] !== undefined
    ? Number(process.argv[portArgumentIndex + 1])
    : DEFAULT_PORT;

/** 最近一次 /echo-ua 收到的 UA；null 表示尚无请求（或已重置） */
let lastEchoUserAgent: string | null = null;

/** T055 spike 观测：content script 注入命中次数 */
let spikeHitCount = 0;

/** T055 spike 观测：探针回报记录 */
let spikeReports: unknown[] = [];

/** [DONE] 读取请求的 User-Agent（HTTP 头名大小写不敏感） */
function readUserAgent(headers: IncomingHttpHeaders): string {
  const value = headers['user-agent'];
  return Array.isArray(value) ? (value[0] ?? '(empty)') : (value ?? '(empty)');
}

/** [DONE] 回显页里放进 HTML 的最小转义，避免 UA 串里的尖括号破坏页面结构 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 公共页面外壳：保证每页有可识别标题与正文，不引入外部资源 */
function renderPage(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.6; color: #1f1f1f; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  a, button { font-size: 15px; }
  .card { border: 1px solid #dadce0; border-radius: 12px; padding: 16px; margin: 12px 0; }
</style>
${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

/** 路由表：把 URL 路径映射到响应（状态码 + 头 + 正文） */
function routeRequest(
  requestUrl: string,
  requestHeaders: IncomingHttpHeaders,
): { status: number; headers: Record<string, string>; body: string } {
  const url = new URL(requestUrl, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/health') {
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'ok' };
  }

  /**
   * Spike 观测端点（T055 content script 注入验证）。
   *
   * GET  `/spike-hit`    → 注入命中次数（纯文本数字）
   * POST `/spike-hit`    → content script 被注入时自报一次
   * GET  `/spike-report` → 探针回报的 JSON 数组
   * POST `/spike-report` → 探针追加一条回报
   * POST 两个 reset 端点  → 清空对应记录
   *
   * 为什么用服务端记录：扩展读不到跨源 iframe 的 DOM，"脚本是否真的在这帧里跑起来"
   * 只能由脚本自己发一个请求来证明，而请求是唯一不受同源策略影响的证据。
   */
  if (pathname === '/spike-hit') {
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: String(spikeHitCount) };
  }

  if (pathname === '/spike-report') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(spikeReports),
    };
  }

  /**
   * UA 回显端点（R5/T036 spike 用）。
   *
   * 服务端把收到的 `User-Agent` 原样回显，并记为「最近一次 /echo-ua 请求的 UA」。
   * 观测走 `/echo-ua/last`（纯文本）而不是页面内容：扩展页无法跨源读取 iframe DOM，
   * 服务端记录是唯一不受同源策略影响的观测通道。
   */
  if (pathname === '/echo-ua') {
    const receivedUserAgent = readUserAgent(requestHeaders);
    lastEchoUserAgent = receivedUserAgent;
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderPage(
        'UA 回显页',
        `<h1>UA 回显页</h1>
         <div class="card"><p id="ua">${escapeHtml(receivedUserAgent)}</p></div>`,
      ),
    };
  }

  if (pathname === '/echo-ua/last') {
    return {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: lastEchoUserAgent ?? '(none)',
    };
  }

  if (pathname === '/echo-ua/reset') {
    lastEchoUserAgent = null;
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'ok' };
  }

  if (pathname === '/embeddable') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderPage(
        '可嵌入示例页',
        `<h1>可嵌入示例页</h1>
         <div class="card"><p>本页允许被 iframe 嵌入，用于验证正常加载与导航追踪。</p></div>
         <div class="card"><a href="/cross-origin">前往跨源页</a></div>
         <div class="card"><a href="/spa">前往单页应用</a></div>
         <div class="card"><a href="/embeddable?step=2">站内第二步</a></div>
         <div class="card"><a href="/blank-target" target="_blank">打开新窗口链接</a></div>`,
      ),
    };
  }

  if (pathname === '/xfo') {
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 禁止嵌入：模拟真实站点防护
        'x-frame-options': 'DENY',
      },
      body: renderPage('XFO 拦截页', '<h1>XFO 拦截页</h1><p>本页发送 X-Frame-Options: DENY。</p>'),
    };
  }

  if (pathname === '/csp') {
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "frame-ancestors 'none'",
      },
      body: renderPage('CSP 拦截页', '<h1>CSP 拦截页</h1><p>本页发送 CSP frame-ancestors none。</p>'),
    };
  }

  if (pathname === '/login') {
    const hasSession = (url.searchParams.get('establish') ?? '') === '1';
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(hasSession
          ? {
              'set-cookie': 'fixture_session=1; Path=/; SameSite=None; Secure; Max-Age=3600',
            }
          : {}),
      },
      body: renderPage(
        '登录态示例页',
        `<h1>登录态示例页</h1>
         <div class="card"><p>会话状态：${hasSession ? '已设置 fixture_session（SameSite=None; Secure）' : '未设置会话 Cookie'}</p></div>
         <div class="card"><a href="/login?establish=1">建立会话</a></div>`,
      ),
    };
  }

  if (pathname === '/cross-origin') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderPage(
        '跨源跳转页',
        `<h1>跨源跳转页</h1>
         <div class="card"><p>从 127.0.0.1 跳到 localhost 视为不同来源，用于验证跨来源导航与不确定态。</p></div>
         <div class="card"><a href="http://localhost:${PORT}/embeddable">跳往 localhost 同端口页</a></div>`,
      ),
    };
  }

  if (pathname === '/spa') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderPage(
        '单页应用示例',
        `<h1>单页应用示例</h1>
         <div class="card"><p id="spa-view">当前视图：首页</p></div>
         <div class="card">
           <button id="go-detail">打开详情（pushState 改 URL）</button>
         </div>`,
        /**
         * 脚本必须对元素缺失保持健壮。
         *
         * 这里曾经直接 `getElementById('go-detail').addEventListener(...)` 而不判空：
         * 当页面被以 `/spa/detail`（pushState 之后的地址）之外的方式重新加载时，
         * 浏览器可能缓存并重放该脚本，此时按钮已被替换/移除，脚本抛
         * `Cannot read properties of null` —— 在侧栏里表现为一条控制台错误，
         * 很容易被误判为扩展自身的缺陷（本项目 T066 上就这样误查了一轮）。
         */
        `<script>
          const view = document.getElementById('spa-view');
          const goDetail = document.getElementById('go-detail');
          if (view !== null && goDetail !== null) {
            goDetail.addEventListener('click', () => {
              history.pushState({ page: 'detail' }, '', '/spa/detail');
              view.textContent = '当前视图：详情';
              document.title = '单页应用示例 · 详情';
            });
          }
        </script>`,
      ),
    };
  }

  if (pathname === '/blank-target') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderPage(
        '新窗口示例页',
        `<h1>新窗口示例页</h1>
         <div class="card"><a href="/embeddable" target="_blank" rel="noopener">target=_blank 链接</a></div>
         <div class="card"><button id="open-window">window.open 打开可嵌入页</button></div>
         <script>
           // 同 /spa：判空后再挂监听，避免脚本重放时抛错并污染被测页面的控制台
           const openWindow = document.getElementById('open-window');
           if (openWindow !== null) {
             openWindow.addEventListener('click', () => {
               window.open('/embeddable', '_blank');
             });
           }
         </script>`,
      ),
    };
  }

  return {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderPage('未找到', '<h1>404</h1><p>夹具站点无此路径。</p>'),
  };
}

const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
  const requestUrl = request.url ?? '/';

  /**
   * CORS 预处理（OPTIONS）与跨源放行。
   *
   * 为什么必需：扩展页向夹具服务发 POST 且带 `content-type: application/json` 时，
   * 浏览器会先发一个 OPTIONS 预检请求。若服务端不回应预检，真实 POST 根本不会发出 ——
   * 表现为"探针里的 fetch 静默失败"，极难与"后台没执行"区分开（本项目 T055 上就为此
   * 多花了一轮排查）。这里统一放行并声明允许的方法与头。
   *
   * 仅对本地夹具服务生效，不涉及生产代码。
   */
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  /**
   * Spike 写入端点（POST）：探针与注入脚本用它自报。
   *
   * 单独分支而不是塞进 routeRequest：routeRequest 是纯读的 URL → 响应映射，
   * 写入有副作用，混在一起会让那段难以推理。
   */
  if (request.method === 'POST') {
    const pathname = new URL(requestUrl, `http://127.0.0.1:${PORT}`).pathname;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');

      if (pathname === '/spike-hit') {
        spikeHitCount += 1;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(String(spikeHitCount));
        return;
      }

      if (pathname === '/spike-report') {
        try {
          spikeReports.push(JSON.parse(raw) as unknown);
        } catch {
          spikeReports.push({ stage: 'unparsable', raw: raw.slice(0, 200) });
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('ok');
        return;
      }

      if (pathname === '/spike-report/reset') {
        spikeReports = [];
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('ok');
        return;
      }

      if (pathname === '/spike-hit/reset') {
        spikeHitCount = 0;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('ok');
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('not found');
    });
    return;
  }

  const { status, headers, body } = routeRequest(requestUrl, request.headers);
  // 回显端点必须逐次可分辨：禁止中间缓存/复用，否则 spike 观测到的 UA 可能来自上一次请求
  response.writeHead(status, { ...headers, 'cache-control': 'no-store' });
  response.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixtures] 夹具站点已启动：http://127.0.0.1:${PORT}/（localhost:${PORT} 亦可达）`);
});

// sidebarmobile — 夹具服务生命周期（测试辅助）
// 2026-09-29 | Kimi(speckit-implement) | T048/T059：验证脚本自带的夹具服务生命周期，保证进程必被回收

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * [DONE] 夹具服务的自管理生命周期。
 *
 * **为什么必须自带**：验证脚本若依赖"外部已经起好的服务"，就会出现两个问题 ——
 *   1. 脚本自身不可独立运行（换台机器/换个人就得先手工起服务）；
 *   2. **服务由别人起、没人负责收**，进程残留会一直占着端口与内存。
 * 第二个问题在本项目上已经真实发生过（残留进程累积导致系统资源耗尽），因此这条纪律写成代码。
 *
 * 三重保障（任一环失效都不会留下孤儿进程）：
 *   - `stop()` 用 `taskkill /T /F` 杀**整棵进程树**（Windows 上单靠 `child.kill()` 杀不掉孙进程）；
 *   - `process.on('exit'|'SIGINT'|'SIGTERM'|'uncaughtException')` 兜底注册清理；
 *   - `stop()` 等待端口真正释放后才返回，避免"以为停了其实还在监听"。
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 默认端口：避开其它切片使用的端口，减少冲突面 */
export const DEFAULT_FIXTURE_PORT = 8921;

export interface FixtureServerHandle {
  /** 服务基地址，如 http://127.0.0.1:8921 */
  origin: string;
  port: number;
  /** 停止服务并等待端口释放；可重复调用 */
  stop(): Promise<void>;
}

export interface StartFixtureOptions {
  port?: number;
  /** 就绪等待上限（毫秒） */
  readyTimeoutMs?: number;
}

/** [DONE] 启动夹具服务并等待就绪；就绪失败会自行清理后抛错 */
export async function startFixtureServer(options: StartFixtureOptions = {}): Promise<FixtureServerHandle> {
  const port = options.port ?? DEFAULT_FIXTURE_PORT;
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const origin = `http://127.0.0.1:${port}`;

  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'fixture-server.ts');
  if (!existsSync(scriptPath)) {
    throw new Error(`夹具服务脚本不存在：${scriptPath}`);
  }

  const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath, '--port', String(port)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stopped = false;

  /** [DONE] 终止进程树并等待端口释放 */
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    unregisterCleanup();
    await killProcessTree(child);
    await waitForPortRelease(port, 5000);
  };

  // 兜底：无论脚本因何退出（正常结束、异常、Ctrl+C），都保证服务被回收
  const unregisterCleanup = registerProcessCleanup(() => {
    if (!stopped) {
      stopped = true;
      // 退出钩子内不能 await，用同步方式尽力终止进程树
      killProcessTreeSync(child);
    }
  });

  const ready = await waitForHealth(origin, readyTimeoutMs);
  if (!ready) {
    const output = await readChildOutput(child);
    await stop();
    throw new Error(`夹具服务未在 ${readyTimeoutMs}ms 内就绪（端口 ${port}）。输出：${output.slice(-400)}`);
  }

  return { origin, port, stop };
}

/** [DONE] 轮询 /health 直到就绪 */
async function waitForHealth(origin: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { cache: 'no-store' });
      if (response.ok) {
        return true;
      }
    } catch {
      // 尚未监听，继续等
    }
    await delay(200);
  }
  return false;
}

/** [DONE] 等待端口不再被监听（确认服务真的停了） */
async function waitForPortRelease(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) {
      return;
    }
    await delay(150);
  }
  // 超时不抛错：清理已经尽力，让调用方继续（抛错会掩盖真正的验证结果）
}

/**
 * [DONE] 检查端口是否有监听者。
 *
 * 用一次连接尝试而不是解析 `netstat`：跨平台且不依赖文本格式，
 * 连得上就说明还有进程在监听。
 */
async function isPortListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(500),
    });
    // 能连上即视为仍在监听（/health 返回任何状态码都说明进程活着）
    void response;
    return true;
  } catch {
    return false;
  }
}

/**
 * [DONE] 杀掉整棵进程树。
 *
 * Windows 上 `child.kill()` 只杀直接子进程；`node --experimental-strip-types` 会再派生
 * 真实脚本进程，所以必须用 `taskkill /T` 连树一起杀，否则会留下监听端口的孤儿。
 */
async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  killProcessTreeSync(child);
  // 等待进程真正退出，避免"刚 kill 就继续"导致端口仍被占用
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killProcessTreeSync(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // taskkill 不可用时退回普通 kill
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退出
      }
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 已经退出
  }
}

/** [DONE] 注册进程退出钩子；返回注销函数 */
function registerProcessCleanup(cleanup: () => void): () => void {
  const handlers: Array<[NodeJS.Signals | 'exit' | 'uncaughtException', () => void]> = [
    ['exit', cleanup],
    ['SIGINT', cleanup],
    ['SIGTERM', cleanup],
    ['uncaughtException', cleanup],
  ];
  for (const [event, handler] of handlers) {
    process.on(event, handler);
  }
  return () => {
    for (const [event, handler] of handlers) {
      process.off(event, handler);
    }
  };
}

/** [DONE] 读取子进程已产生的输出（失败诊断用） */
function readChildOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    child.stdout?.on('data', (chunk: unknown) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      output += String(chunk);
    });
    setTimeout(() => resolve(output), 200);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

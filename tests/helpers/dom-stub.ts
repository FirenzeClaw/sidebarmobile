// sidebarmobile — 最小 DOM 替身（测试辅助）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B1：为侧栏视图模块提供无依赖的 DOM 环境，使真实模块可被单测
// 2026-09-30 | Kimi(fix) | 补 disabled 属性一致性、可控定时器与 requestAnimationFrame（弹层单测需要）

/**
 * [DONE] 最小 DOM 替身。
 *
 * **为什么不用 jsdom**：本项目的依赖是刻意收紧的（宪法 I，YAGNI），而视图模块实际用到的 DOM 面
 * 很窄 —— 元素创建、属性、子节点、监听器、几个布局只读属性。为此引入一个完整 DOM 实现
 * （jsdom 约数十 MB、API 面极广）不划算；手写替身还能做到 jsdom 做不到的事：
 * **对"疑似死循环"给出确定性失败**（见 `clientWidth` 的读取预算）。
 *
 * 覆盖范围仅限 `src/sidebar/views/browser-view.ts` 与降级覆盖层所需的面。
 * 需要真实布局/渲染的行为（滚动位置、CSS 生效）不在覆盖范围，那由真实浏览器检查点负责。
 */

/** 一个替身元素 */
export class StubElement {
  readonly tagName: string;
  className = '';
  id = '';
  textContent = '';
  hidden = false;
  title = '';
  src = '';
  /** 直接赋值型属性表（setAttribute/getAttribute 的落地处） */
  readonly attributes = new Map<string, string>();
  readonly children: StubElement[] = [];
  parent: StubElement | null = null;
  /** 是否已挂到"文档"上；接线会据此挡掉孤儿元素 */
  isConnected = false;

  readonly style: Record<string, string> = {};
  readonly classList = {
    _set: new Set<string>(),
    add: (name: string): void => {
      // 用闭包外的对象不方便，改为方法在 createStubElement 里绑定
      void name;
    },
    remove: (_name: string): void => undefined,
    toggle: (_name: string, _force?: boolean): void => undefined,
    contains: (_name: string): boolean => false,
  };

  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  /** 布局只读属性：测试直接赋值以模拟尺寸 */
  private ownClientWidth = 0;
  offsetWidth = 0;
  offsetHeight = 0;

  get clientWidth(): number {
    // 未显式赋值时继承父元素宽度：真实布局里块级子元素的宽度来自父容器，
    // 而视图代码读的是 iframe 宿主（子）的 clientWidth —— 替身必须反映这层继承关系，
    // 否则"桌面模式重算缩放"这类路径永远走不到（宽度恒为 0）。
    return this.ownClientWidth > 0 ? this.ownClientWidth : (this.parent?.clientWidth ?? 0);
  }

  set clientWidth(value: number) {
    this.ownClientWidth = value;
  }

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  /**
   * 焦点落点接收器（由 `installDomEnvironment` 安装）。
   *
   * `focus()` 需要把焦点写到文档级的 `activeElement` 上，而替身元素本身不持有文档引用 ——
   * 因此用这个静态钩子把两者接起来。未安装时是 null，`focus()` 静默无操作。
   */
  static focusSink: ((element: StubElement) => void) | null = null;

  /** [DONE] 聚焦：把焦点交给文档（弹层的"打开者记录 / 关闭回焦"依赖它） */
  focus(): void {
    StubElement.focusSink?.(this);
  }

  /**
   * `disabled` 与属性表双向一致。
   *
   * 真实性要求：生产代码用 `createElement(..., { disabled })` 写属性，而测试代码读的是
   * `element.disabled`（与真实浏览器一致）。若两者各存一份，会出现"元素其实已被禁用、
   * 断言却看到 false"这种**替身自身造成的假绿**，而禁用态恰恰是本次要验证的行为。
   */
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }

  set disabled(value: boolean) {
    if (value) {
      this.attributes.set('disabled', '');
    } else {
      this.attributes.delete('disabled');
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'class') {
      this.className = value;
    }
    if (name === 'id') {
      this.id = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'class') {
      return this.className;
    }
    if (name === 'id') {
      return this.id;
    }
    return this.attributes.has(name) ? (this.attributes.get(name) ?? null) : null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name) || (name === 'class' && this.className.length > 0);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: Array<StubElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.textContent += node;
        continue;
      }
      node.parent = this;
      this.children.push(node);
      markConnected(node, this.isConnected);
    }
  }

  removeChild(child: StubElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
      markConnected(child, false);
    }
  }

  remove(): void {
    this.parent?.removeChild(this);
    markConnected(this, false);
  }

  get firstChild(): StubElement | null {
    return this.children[0] ?? null;
  }

  /** 只支持按标签名与 `.class` 选择（视图代码实际只用到这两种） */
  querySelector(selector: string): StubElement | null {
    return this.findDescendant((element) => matches(element, selector));
  }

  querySelectorAll(selector: string): StubElement[] {
    const found: StubElement[] = [];
    this.collectDescendants((element) => {
      if (matches(element, selector)) {
        found.push(element);
      }
    });
    return found;
  }

  contains(node: StubElement | null): boolean {
    if (node === null) {
      return false;
    }
    if (node === this) {
      return true;
    }
    return this.children.some((child) => child.contains(node));
  }

  closest(selector: string): StubElement | null {
    let current: StubElement | null = this;
    while (current !== null) {
      if (matches(current, selector)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** 测试辅助：派发事件（不冒泡，视图代码不依赖冒泡语义） */
  dispatch(type: string, event: Partial<Event> = {}): void {
    const payload = { type, target: this, preventDefault: (): void => undefined, stopPropagation: (): void => undefined, ...event };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload as Event);
    }
  }

  /** 测试辅助：某类监听器数量（用于断言监听器是否泄漏） */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.offsetHeight };
  }

  private findDescendant(predicate: (element: StubElement) => boolean): StubElement | null {
    for (const child of this.children) {
      if (predicate(child)) {
        return child;
      }
      const nested = child.findDescendant(predicate);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  private collectDescendants(visit: (element: StubElement) => void): void {
    for (const child of this.children) {
      visit(child);
      child.collectDescendants(visit);
    }
  }
}

/** [DONE] 选择器匹配：支持 `tag`、`.class`、`tag.class` 与逗号分隔的组合 */
function matches(element: StubElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      return false;
    }
    const [tagPart, classPart] = trimmed.includes('.') ? trimmed.split('.') : [trimmed, null];
    const tagOk = tagPart === '' || tagPart === '*' || element.tagName === tagPart.toUpperCase();
    const classOk =
      classPart === null ||
      classPart === '' ||
      element.className.split(/\s+/).includes(classPart);
    return tagOk && classOk;
  });
}

function markConnected(element: StubElement, connected: boolean): void {
  element.isConnected = connected;
  for (const child of element.children) {
    markConnected(child, connected);
  }
}

export interface DomEnvironment {
  document: {
    createElement(tag: string): StubElement;
    createElementNS(namespace: string, tag: string): StubElement;
    getElementById(id: string): StubElement | null;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
    /** 已登记的文档级监听器数量 */
    listenerCount(type: string): number;
    /** 派发一次文档级 keydown（弹层的 Esc 关闭路径） */
    dispatchKeydown(key: string): void;
    /** 元素是否在文档里 */
    contains(node: StubElement | null): boolean;
    /** 当前聚焦元素；测试可赋值以模拟"打开弹层前焦点在哪" */
    activeElement: StubElement | null;
    body: StubElement;
  };
  window: {
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
    dispatchResize(): void;
    dispatchKeydown(key: string): void;
  };
  /** 注册一个可按 id 查到的元素 */
  registerElement(id: string, element: StubElement): void;
  /** 布局读取预算：超出即抛错，把"死循环"变成确定性失败而不是挂起 */
  setMeasureBudget(count: number): void;
  /** 已读取布局属性的次数（用于断言没有异常空转） */
  measureCount(): number;
  /**
   * 推进虚拟时钟并执行到期定时器。
   *
   * 弹层动画与 toast 都靠定时器收尾，测试必须能精确走到"动画已结束"那一刻，
   * 否则"关闭后是否真的隐藏"这类断言只能靠 sleep，既慢又不稳定。
   */
  advanceTimers(ms: number): void;
  /** 尚未执行的定时器数量（断言"没有残留定时器"用） */
  pendingTimerCount(): number;
  restore(): void;
}

/**
 * [DONE] 安装 DOM 替身到全局。
 *
 * **布局读取预算**是这里最关键的机制：像"遍历 Map 时增删导致无限循环"这类缺陷，
 * 在无预算时表现为测试永久挂起（CI 上只能超时失败，且看不出原因）。
 * 这里给 `clientWidth`/`offsetWidth` 的读取设上限，超限直接抛错 ——
 * 死循环立刻变成一条可读的失败信息，测试能给出确定的 RED。
 */
export function installDomEnvironment(): DomEnvironment {
  const registry = new Map<string, StubElement>();
  const body = new StubElement('body');
  body.isConnected = true;

  let measureBudget = Number.POSITIVE_INFINITY;
  let measures = 0;

  /** 布局属性包装：统一计入预算 */
  function defineMeasure(element: StubElement, property: 'offsetWidth'): void {
    let stored = 0;
    Object.defineProperty(element, property, {
      get(): number {
        measures += 1;
        if (measures > measureBudget) {
          throw new Error(`布局读取超出预算（${measureBudget} 次）：疑似陷入循环`);
        }
        return stored;
      },
      set(value: number): void {
        stored = value;
      },
      configurable: true,
    });
  }

  /**
   * 文档级监听器表。
   *
   * 与 window 上的分开维护：`document.addEventListener` 与 `window.addEventListener`
   * 在真实浏览器里是两套监听器，替身若合并会让"到底挂在哪里"这类问题无法被测试区分。
   */
  const documentListeners = new Map<string, Set<(event: Event) => void>>();

  /**
   * 元件工厂：`createElement` 与 `createElementNS` 共用同一实现。
   *
   * 抽出成函数而不是让两者各写一遍：classList / clientWidth 预算这些装配逻辑只该有一份，
   * 否则 SVG 元素会缺掉其中一部分，表现为"图标相关的断言行为诡异"。
   */
  function createElementStub(tag: string): StubElement {
      const element = new StubElement(tag);
      defineMeasure(element, 'offsetWidth');
      // clientWidth 的读取也要计入预算：它是 resize 重算路径上被反复读取的属性，
      // 死循环正是通过它无限空转的。
      const clientDescriptor = Object.getOwnPropertyDescriptor(StubElement.prototype, 'clientWidth');
      if (clientDescriptor?.get !== undefined && clientDescriptor.set !== undefined) {
        const baseGet = clientDescriptor.get.bind(element) as () => number;
        const baseSet = clientDescriptor.set.bind(element) as (value: number) => void;
        Object.defineProperty(element, 'clientWidth', {
          get(): number {
            measures += 1;
            if (measures > measureBudget) {
              throw new Error(`布局读取超出预算（${measureBudget} 次）：疑似陷入循环`);
            }
            return baseGet();
          },
          set(value: number): void {
            baseSet(value);
          },
          configurable: true,
        });
      }
      // classList 的等价实现（视图代码用到 add/remove/toggle/contains）
      Object.defineProperty(element, 'classList', {
        value: {
          add: (name: string): void => {
            const parts = new Set(element.className.split(/\s+/).filter((part) => part.length > 0));
            parts.add(name);
            element.className = [...parts].join(' ');
          },
          remove: (name: string): void => {
            element.className = element.className
              .split(/\s+/)
              .filter((part) => part.length > 0 && part !== name)
              .join(' ');
          },
          toggle: (name: string, force?: boolean): void => {
            const parts = new Set(element.className.split(/\s+/).filter((part) => part.length > 0));
            const shouldAdd = force === undefined ? !parts.has(name) : force;
            if (shouldAdd) {
              parts.add(name);
            } else {
              parts.delete(name);
            }
            element.className = [...parts].join(' ');
          },
          contains: (name: string): boolean => element.className.split(/\s+/).includes(name),
        },
        configurable: true,
      });
      return element;
  }

  const documentStub = {
    /** 当前聚焦元素（弹层打开时要记录"打开者"、关闭时要回焦） */
    activeElement: null as StubElement | null,
    addEventListener(type: string, listener: (event: Event) => void): void {
      const set = documentListeners.get(type) ?? new Set();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void): void {
      documentListeners.get(type)?.delete(listener);
    },
    /** 已登记的文档级监听器数量（断言"没有越积越多"用） */
    listenerCount(type: string): number {
      return documentListeners.get(type)?.size ?? 0;
    },
    /**
     * 命名空间元素创建（图标由内联 SVG 构建）。
     *
     * 返回同一种替身元素：视图代码只对它 setAttribute / append，不依赖 SVG 特有 API，
     * 因此不需要为 SVG 单独建模。
     */
    createElementNS(_namespace: string, tag: string): StubElement {
      return createElementStub(tag);
    },
    createElement(tag: string): StubElement {
      return createElementStub(tag);
    },
    getElementById(id: string): StubElement | null {
      return registry.get(id) ?? null;
    },
    /** 元素是否仍在文档里（弹层关闭后回焦前会以此判断触发器是否还活着） */
    contains(node: StubElement | null): boolean {
      return node !== null && node.isConnected;
    },
    /** 派发一次文档级 keydown（Esc 关闭弹层的路径） */
    dispatchKeydown(key: string): void {
      for (const listener of [...(documentListeners.get('keydown') ?? [])]) {
        listener({ type: 'keydown', key, preventDefault: (): void => undefined, stopPropagation: (): void => undefined } as unknown as Event);
      }
    },
    body,
  };

  /**
   * 可控定时器。
   *
   * 弹层的升起/关闭动画与 toast 自动隐藏都靠定时器推进，而这些延迟（200ms+）在单测里
   * 若真的等待会拖慢整套测试、且断言时机不确定。这里把 `window.setTimeout` /
   * `requestAnimationFrame` 收敛到一个**测试可显式推进**的队列：调用 `advanceTimers(ms)`
   * 精确走到动画结束点，断言"关闭后元素确实被隐藏"这类状态才可复现。
   */
  const scheduledTasks = new Map<number, { at: number; run: () => void }>();
  let taskSequence = 0;
  let clockMs = 0;

  function schedule(delayMs: number, run: () => void): number {
    taskSequence += 1;
    scheduledTasks.set(taskSequence, { at: clockMs + delayMs, run });
    return taskSequence;
  }

  const windowListeners = new Map<string, Set<(event: Event) => void>>();
  const windowStub = {
    addEventListener(type: string, listener: (event: Event) => void): void {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void): void {
      windowListeners.get(type)?.delete(listener);
    },
    setTimeout: (run: () => void, delayMs = 0): number => schedule(delayMs, run),
    clearTimeout: (handle: number): void => {
      scheduledTasks.delete(handle);
    },
    /** 替身里 rAF 等同"下一帧"（0ms 定时器）：调用方只关心"布局后执行"，不关心帧对齐 */
    requestAnimationFrame: (run: () => void): number => schedule(0, run),
    cancelAnimationFrame: (handle: number): void => {
      scheduledTasks.delete(handle);
    },
    dispatchResize(): void {
      for (const listener of [...(windowListeners.get('resize') ?? [])]) {
        listener({ type: 'resize' } as Event);
      }
    },
    dispatchKeydown(key: string): void {
      for (const listener of [...(windowListeners.get('keydown') ?? [])]) {
        listener({ type: 'keydown', key } as unknown as Event);
      }
    },
  };

  const previousDocument = Reflect.get(globalThis, 'document');
  const previousWindow = Reflect.get(globalThis, 'window');
  const previousIframe = Reflect.get(globalThis, 'HTMLIFrameElement');
  const previousHtmlElement = Reflect.get(globalThis, 'HTMLElement');

  // 焦点落点：元素的 focus() 写回本环境的 document.activeElement
  const previousFocusSink = StubElement.focusSink;
  StubElement.focusSink = (element: StubElement): void => {
    documentStub.activeElement = element;
  };

  Reflect.set(globalThis, 'document', documentStub);
  Reflect.set(globalThis, 'window', windowStub);
  /**
   * 提供 `HTMLIFrameElement` / `HTMLElement` 构造器。
   *
   * 视图代码用 `element instanceof HTMLIFrameElement` 做类型收敛（这是正确的写法，
   * 不应为了测试而改成鸭子类型）。因此替身必须让这些构造器存在，且 `instanceof` 判定成立 ——
   * 用同一个类作为所有元素的原型即可，因为替身元素只有一种实现。
   */
  Reflect.set(globalThis, 'HTMLElement', StubElement);
  Reflect.set(globalThis, 'HTMLIFrameElement', StubElement);
  Reflect.set(globalThis, 'HTMLDivElement', StubElement);
  Reflect.set(globalThis, 'HTMLButtonElement', StubElement);

  return {
    document: documentStub,
    window: windowStub,
    registerElement(id: string, element: StubElement): void {
      registry.set(id, element);
      element.id = id;
      element.setAttribute('id', id);
    },
    setMeasureBudget(count: number): void {
      measureBudget = count;
      measures = 0;
    },
    measureCount(): number {
      return measures;
    },
    /** 推进虚拟时钟并执行到期任务（按到期时间排序，同刻按登记顺序） */
    advanceTimers(ms: number): void {
      clockMs += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...scheduledTasks.entries()]
          .filter(([, task]) => task.at <= clockMs)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        for (const [handle, task] of due) {
          if (!scheduledTasks.has(handle)) {
            // 同一批里已被更早的任务取消
            continue;
          }
          scheduledTasks.delete(handle);
          task.run();
          progressed = true;
        }
      }
    },
    pendingTimerCount(): number {
      return scheduledTasks.size;
    },
    restore(): void {
      Reflect.set(globalThis, 'document', previousDocument);
      Reflect.set(globalThis, 'window', previousWindow);
      Reflect.set(globalThis, 'HTMLIFrameElement', previousIframe);
      Reflect.set(globalThis, 'HTMLElement', previousHtmlElement);
      StubElement.focusSink = previousFocusSink;
    },
  };
}

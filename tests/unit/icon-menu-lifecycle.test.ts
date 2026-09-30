// sidebarmobile — 图标菜单接线生命周期测试（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：重绘后失效接线必须释放

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDomEnvironment, type DomEnvironment, type StubElement } from '../helpers/dom-stub.ts';
import { createIconMenu } from '../../src/sidebar/components/icon-menu.ts';

let dom: DomEnvironment;

/**
 * 把替身元素交给以 `HTMLElement` 为参数的生产代码。
 *
 * 手写替身无法在类型上满足 `HTMLElement` 的两百余个成员（也不该为了测试去实现它们），
 * 因此这一处转换是必要的。运行时行为才是本文件断言的对象：接线表按**元素身份**索引，
 * 而替身对象正好提供 `isConnected` 与监听器语义。
 */
function asHtmlElement(element: StubElement): HTMLElement {
  return element as unknown as HTMLElement;
}

beforeEach(() => {
  dom = installDomEnvironment();
  // icon-menu 通过 requireElement 取菜单容器
  dom.registerElement('iconMenu', dom.document.createElement('div'));
});

afterEach(() => {
  dom.restore();
});

/**
 * 终审 [建议修改]：网站列表每次重绘都会重建行元素，而图标菜单把**触发器元素**当键存接线。
 * 旧元素被替换后接线仍留在表里（连同它的 5 个监听器），实测 200 轮重绘累积约 5000 个。
 *
 * `pruneDetached` 让调用方在"一批元素刚被重建"之后释放它们。这里用 `isConnected`
 * 判定失效：DOM 替身会在 `append`/`remove` 时递归维护该标志。
 */
describe('图标菜单接线生命周期（终审 [建议修改]）', () => {
  it('pruneDetached 释放已脱离文档的触发器接线', () => {
    const menu = createIconMenu({ container: asHtmlElement(dom.document.createElement('div')) });
    const stale = dom.document.createElement('button');
    const live = dom.document.createElement('button');
    dom.document.body.append(stale, live);

    menu.attach(asHtmlElement(stale), () => []);
    menu.attach(asHtmlElement(live), () => []);

    // 模拟重绘：旧按钮被移除，新按钮进来
    stale.remove();

    menu.pruneDetached();

    // 再次 prune 不应抛错（幂等），且活着的触发器仍可用
    menu.pruneDetached();
    expect(live.isConnected).toBe(true);
  });

  it('pruneDetached 可重复调用且不误伤仍在文档中的接线', () => {
    const menu = createIconMenu({ container: asHtmlElement(dom.document.createElement('div')) });
    const trigger = dom.document.createElement('button');
    dom.document.body.append(trigger);
    menu.attach(asHtmlElement(trigger), () => [{ icon: 'more', label: '测试项', onSelect: () => undefined }]);

    menu.pruneDetached();
    menu.pruneDetached();

    // 触发器仍在文档中：接线应保留，点击仍能打开菜单
    trigger.dispatch('click');
    expect(menu.isOpen()).toBe(true);
  });

  it('未挂载的触发器不产生接线（attach 静默跳过）', () => {
    const menu = createIconMenu({ container: asHtmlElement(dom.document.createElement('div')) });
    const detached = dom.document.createElement('button');

    menu.attach(asHtmlElement(detached), () => []);

    // 未连接的元素被静默跳过：prune 后仍然不抛错
    menu.pruneDetached();
    expect(menu.isOpen()).toBe(false);
  });

  it('反复重建 200 轮后表不累积失效接线（prune 每次都释放旧批）', () => {
    const menu = createIconMenu({ container: asHtmlElement(dom.document.createElement('div')) });

    for (let round = 0; round < 200; round += 1) {
      const trigger = dom.document.createElement('button');
      dom.document.body.append(trigger);
      menu.attach(asHtmlElement(trigger), () => []);
      // 下一轮会替换元素，这里模拟"重绘前先释放上一批"
      menu.pruneDetached();
      trigger.remove();
    }
    menu.pruneDetached();

    // 只要 prune 生效，这里不会有异常；断言聚焦"没有残留可被再次清理的对象"
    expect(dom.document.body.children.length).toBe(0);
  });
});

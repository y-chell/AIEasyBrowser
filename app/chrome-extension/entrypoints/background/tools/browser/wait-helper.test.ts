import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function fixture() {
  class Element {
    nodeType = 1;
    isConnected = true;
    hidden = false;
    inert = false;
    parentElement: Element | null = null;
    assignedSlot: Element | null = null;
    host: Element | null = null;
    children: Element[] = [];
    childNodes: any[] = [];
    attrs: Record<string, string> = {};
    style = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' };
    constructor(public id: string) {}
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    }
    getRootNode() {
      return { host: this.host };
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 30 };
    }
    matches(selector: string) {
      return selector === '#' + this.id;
    }
    closest() {
      return null;
    }
    append(child: Element) {
      child.parentElement = this;
      this.children.push(child);
      this.childNodes.push(child);
    }
  }
  const body = new Element('body');
  const dialog = new Element('dialog');
  const target = new Element('target');
  body.append(dialog);
  dialog.append(target);
  target.childNodes.push({ nodeType: 3, textContent: 'Delete complete' });
  const elements = [body, dialog, target];
  const document = {
    body,
    documentElement: body,
    visibilityState: 'visible',
    hidden: false,
    hasFocus: () => true,
    querySelector: (selector: string) => elements.find((el) => el.matches(selector)) || null,
    querySelectorAll: (selector: string) => elements.filter((el) => el.matches(selector)),
  };
  let listener: any;
  const file = path.resolve(__dirname, '../../../..', 'inject-scripts/wait-helper.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    window: { __claudeElementMap: { ref_1: new WeakRef(target) } },
    document,
    Element,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    WeakRef,
    getComputedStyle: (el: Element) => el.style,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn: any) => {
            listener = fn;
          },
        },
      },
    },
  });
  const request = (args: Record<string, unknown>) =>
    new Promise<any>((resolve) => listener({ timeout: 20, ...args }, {}, resolve));
  return { body, dialog, target, document, request };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('wait helper visibility', () => {
  test.each(['opacity', 'visibility', 'display', 'aria-hidden', 'hidden'])(
    'a remaining dialog subtree is hidden by ancestor %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'opacity') f.dialog.style.opacity = '0.0';
      if (kind === 'visibility') f.dialog.style.visibility = 'hidden';
      if (kind === 'display') f.dialog.style.display = 'none';
      if (kind === 'aria-hidden') f.dialog.attrs['aria-hidden'] = 'true';
      if (kind === 'hidden') f.dialog.hidden = true;
      const passed = await f.request({
        action: 'waitForSelector',
        selector: '#target',
        visible: false,
      });
      expect(passed).toMatchObject({
        success: true,
        elementState: {
          exists: true,
          visible: false,
          hiddenReason: expect.stringContaining('ancestor:'),
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  test('a hidden-page disappearance succeeds without converting completed work into PAGE_HIDDEN', async () => {
    const f = fixture();
    f.document.hidden = true;
    f.document.visibilityState = 'hidden';
    f.dialog.style.opacity = '0';
    const result = await f.request({ action: 'waitForSelector', ref: 'ref_1', visible: false });
    expect(result).toMatchObject({
      success: true,
      pageVisibility: { hidden: true, hasFocus: true },
    });
    expect(result.code).toBeUndefined();
  });
  test('a visible condition can already be satisfied on a hidden page', async () => {
    const f = fixture();
    f.document.hidden = true;
    f.document.visibilityState = 'hidden';
    expect(await f.request({ action: 'waitForSelector', selector: '#target' })).toMatchObject({
      success: true,
      pageVisibility: { hidden: true },
    });
  });
  test('unmet visible wait reports hidden-page diagnosis despite hasFocus=true', async () => {
    const f = fixture();
    f.document.hidden = true;
    f.document.visibilityState = 'hidden';
    f.dialog.style.opacity = '0';
    const pending = f.request({ action: 'waitForSelector', selector: '#target' });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      success: false,
      reason: 'timeout',
      code: 'PAGE_HIDDEN',
      pageVisibility: { hidden: true, hasFocus: true },
      elementState: { exists: true, visible: false, hiddenReason: 'ancestor:opacity:0' },
      guidance: expect.stringContaining('Do not repeat an already completed action'),
    });
  });
  test('visible parent text does not resurrect an invisible exiting dialog', async () => {
    const f = fixture();
    f.dialog.style.opacity = '0';
    expect(
      await f.request({ action: 'waitForText', text: 'Delete complete', appear: false }),
    ).toMatchObject({ success: true });
    f.dialog.style.opacity = '1';
    expect(await f.request({ action: 'waitForText', text: 'Delete complete' })).toMatchObject({
      success: true,
    });
  });
  test('follows a shadow host when the parentElement chain ends', async () => {
    const f = fixture();
    f.target.parentElement = null;
    f.target.host = f.dialog;
    f.dialog.style.opacity = '0';
    expect(
      await f.request({ action: 'waitForSelector', ref: 'ref_1', visible: false }),
    ).toMatchObject({ success: true, elementState: { hiddenReason: 'ancestor:opacity:0' } });
  });
  test('a detached ref is hidden instead of clickable', async () => {
    const f = fixture();
    f.target.isConnected = false;
    expect(
      await f.request({ action: 'waitForSelector', ref: 'ref_1', visible: false }),
    ).toMatchObject({ success: true, elementState: { exists: false, visible: false } });
  });
  test('honors timeout=0 and includes an invisible-target diagnosis on a visible page', async () => {
    const f = fixture();
    f.dialog.style.opacity = '0';
    const pending = f.request({ action: 'waitForClickable', ref: 'ref_1', timeout: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({
      success: false,
      reason: 'timeout',
      elementState: { hiddenReason: 'ancestor:opacity:0' },
    });
  });
});

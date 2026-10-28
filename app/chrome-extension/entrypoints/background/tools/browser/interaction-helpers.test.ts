import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function helper(kind: 'click' | 'fill') {
  class Element {
    isConnected = true;
    tagName = 'INPUT';
    type = 'text';
    id = 'fixture';
    className = '';
    textContent = 'Fixture';
    value = 'unchanged';
    readOnly = false;
    disabled = false;
    inert = false;
    events: string[] = [];
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
    }
    scrollIntoView() {}
    matches() {
      return this.disabled;
    }
    closest() {
      return this.inert ? this : null;
    }
    contains(other: unknown) {
      return other === this;
    }
    dispatchEvent(event: { type: string }) {
      this.events.push(event.type);
      return true;
    }
    focus() {}
    blur() {}
  }
  const target = new Element();
  const document = {
    querySelectorAll: vi.fn(() => [target]),
    elementFromPoint: vi.fn(() => target),
  };
  const style = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' };
  let listener: any;
  class Event {
    constructor(public type: string) {}
  }
  const window = {
    __claudeElementMap: { ref_1: { deref: () => target } },
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => style,
  };
  const file = path.resolve(__dirname, '../../../..', 'inject-scripts', kind + '-helper.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    window,
    document,
    Element,
    MouseEvent: Event,
    Event,
    setTimeout,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (callback: any) => {
            listener = callback;
          },
        },
      },
    },
  });
  const request = (args: Record<string, unknown>) =>
    new Promise<any>((resolve) =>
      listener({ action: kind === 'click' ? 'clickElement' : 'fillElement', ...args }, {}, resolve),
    );
  return { target, document, style, request };
}

describe('injected interaction preconditions', () => {
  test('dispatches one click for a connected visible unique target', async () => {
    const fixture = helper('click');
    expect((await fixture.request({ ref: 'ref_1' })).success).toBe(true);
    expect(fixture.target.events).toEqual(['mousedown', 'mouseup', 'click']);
  });
  test.each(['detached', 'disabled', 'inert', 'covered', 'hidden', 'pointer'] as const)(
    'rejects %s ref before emitting input events',
    async (state) => {
      const fixture = helper('click');
      if (state === 'detached') fixture.target.isConnected = false;
      if (state === 'disabled') fixture.target.disabled = true;
      if (state === 'inert') fixture.target.inert = true;
      if (state === 'covered') fixture.document.elementFromPoint.mockReturnValue({} as any);
      if (state === 'hidden') fixture.style.visibility = 'hidden';
      if (state === 'pointer') fixture.style.pointerEvents = 'none';
      expect((await fixture.request({ ref: 'ref_1' })).error).toContain(
        state === 'detached' ? 'STALE_REF' : 'NOT_INTERACTABLE',
      );
      expect(fixture.target.events).toEqual([]);
    },
  );
  test('hit-tests a coordinate click at its requested point, not at the element center', async () => {
    const fixture = helper('click');
    fixture.document.elementFromPoint.mockImplementation(((x: number) =>
      x === 5 ? fixture.target : null) as any);
    expect((await fixture.request({ coordinates: { x: 5, y: 5 } })).success).toBe(true);
    expect(fixture.document.elementFromPoint).toHaveBeenLastCalledWith(5, 5);
  });
  test('rejects empty-space coordinates instead of reporting a successful click', async () => {
    const fixture = helper('click');
    fixture.document.elementFromPoint.mockReturnValue(null as any);
    expect((await fixture.request({ coordinates: { x: 5, y: 5 } })).error).toContain(
      'NOT_INTERACTABLE',
    );
  });
  test('reports a hidden selector rejection before dispatch', async () => {
    const fixture = helper('click');
    fixture.style.display = 'none';
    expect((await fixture.request({ selector: '#fixture' })).error).toContain('NOT_INTERACTABLE');
    expect(fixture.target.events).toEqual([]);
  });
  test.each(['click', 'fill'] as const)('rejects ambiguous %s selectors', async (kind) => {
    const fixture = helper(kind);
    fixture.document.querySelectorAll.mockReturnValue([fixture.target, fixture.target]);
    expect((await fixture.request({ selector: '.duplicate', value: 'new' })).error).toContain(
      'matches multiple',
    );
    expect(fixture.target.events).toEqual([]);
    expect(fixture.target.value).toBe('unchanged');
  });
  test('fills a normal unique input', async () => {
    const fixture = helper('fill');
    expect((await fixture.request({ selector: '#fixture', value: 'new' })).success).toBe(true);
    expect(fixture.target.value).toBe('new');
    expect(fixture.target.events).toContain('change');
  });
  test.each(['detached', 'disabled', 'readonly', 'inert'] as const)(
    'does not mutate %s input',
    async (state) => {
      const fixture = helper('fill');
      if (state === 'detached') fixture.target.isConnected = false;
      if (state === 'disabled') fixture.target.disabled = true;
      if (state === 'readonly') fixture.target.readOnly = true;
      if (state === 'inert') fixture.target.inert = true;
      expect((await fixture.request({ ref: 'ref_1', value: 'new' })).error).toContain(
        state === 'detached' ? 'STALE_REF' : 'NOT_INTERACTABLE',
      );
      expect(fixture.target.value).toBe('unchanged');
      expect(fixture.target.events).toEqual([]);
    },
  );
});

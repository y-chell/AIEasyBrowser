import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Run the actual message handler with deterministic layout. No browser, scrolling,
// or DOM library is needed; these fixtures control both screen and scrollport bounds.
function fixture() {
  type Rect = { left: number; top: number; width: number; height: number };
  class Element {
    children: Element[] = [];
    childNodes: unknown[] = [];
    parentNode: Element | ShadowRoot | Document | null = null;
    shadowRoot: ShadowRoot | null = null;
    assignedSlot: Element | null = null;
    nodeType = 1;
    style = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      clipPath: 'none',
      overflowX: 'visible',
      overflowY: 'visible',
      position: 'static',
      zIndex: 'auto',
    };
    attrs: Record<string, string>;
    rect: Rect;
    textContent: string;
    innerText?: string;
    value = '';
    labels?: Element[];
    tagName: string;
    constructor(tag: string, id: string, rect: Partial<Rect> = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = { id };
      this.textContent = id;
      this.rect = { left: 300, top: 100, width: 100, height: 30, ...rect };
    }
    get id() {
      return this.attrs.id;
    }
    get parentElement(): Element | null {
      return this.parentNode instanceof Element ? this.parentNode : null;
    }
    get attributes() {
      return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
    }
    get offsetWidth() {
      return this.style.display === 'none' ? 0 : this.rect.width;
    }
    get offsetHeight() {
      return this.style.display === 'none' ? 0 : this.rect.height;
    }
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    }
    hasAttribute(name: string) {
      return name in this.attrs;
    }
    append(...children: Element[]) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
      return this;
    }
    getRootNode(): Element | ShadowRoot | Document {
      return this.parentNode instanceof Element
        ? this.parentNode.getRootNode()
        : this.parentNode || this;
    }
    getBoundingClientRect() {
      const { left, top, width, height } = this.rect;
      return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    }
    matches(selector: string): boolean {
      return selector.split(',').some((part) => {
        part = part.trim();
        if (part === ':disabled') return this.hasAttribute('disabled');
        if (part === ':popover-open') return this.hasAttribute('data-popover-open');
        if (part.startsWith('#')) return this.id === part.slice(1);
        const not = part.match(/:not\((.*)\)$/);
        if (not) {
          if (this.matches(not[1])) return false;
          part = part.slice(0, not.index);
        }
        const descendant = part.match(/^(\w+) (\w+)$/);
        if (descendant)
          return this.matches(descendant[2]) && Boolean(this.parentElement?.closest(descendant[1]));
        const tag = part.match(/^([\w-]+)/)?.[1];
        if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
        const attribute = part.match(/\[([\w-]+)(?:([*]?=)"([^"]*)"(?: i)?)?\]/);
        if (attribute) {
          const value = this.getAttribute(attribute[1]);
          if (value === null) return false;
          if (attribute[2] === '=') return value === attribute[3];
          if (attribute[2] === '*=')
            return value.toLowerCase().includes(attribute[3].toLowerCase());
        }
        return Boolean(tag || attribute);
      });
    }
    closest(selector: string): Element | null {
      return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }
  class ShadowRoot {
    children: Element[] = [];
    constructor(public host: Element) {}
    append(...children: Element[]) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
    getElementById(id: string) {
      return this.querySelector(`#${id}`);
    }
  }
  class Document {
    title = 'Compact fixture';
    readyState = 'complete';
    documentElement = new Element('html', 'html');
    body = new Element('body', 'body');
    constructor() {
      this.documentElement.parentNode = this;
      this.documentElement.append(this.body);
    }
    querySelectorAll(selector: string) {
      return this.documentElement.querySelectorAll(selector);
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
    getElementById(id: string) {
      return this.querySelector(`#${id}`);
    }
  }
  const document = new Document();
  const window = {
    innerWidth: 1536,
    innerHeight: 695,
    devicePixelRatio: 1,
    getComputedStyle: (element: Element) => element.style,
    addEventListener() {},
    __claudeElementMap: {} as Record<string, WeakRef<Element>>,
  };
  let listener: (request: unknown, sender: unknown, reply: (value: any) => void) => void;
  const file = path.resolve(
    __dirname,
    '../../../..',
    'inject-scripts/accessibility-tree-helper.js',
  );
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    window,
    document,
    location: { href: 'https://fixture.test/' },
    Element,
    ShadowRoot,
    Document,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    WeakRef,
    CSS: { escape: (value: string) => value },
    chrome: {
      runtime: { onMessage: { addListener: (callback: typeof listener) => (listener = callback) } },
    },
  });
  const request = (payload: Record<string, unknown>) => {
    let response: any;
    listener(payload, {}, (value) => (response = value));
    expect(response?.success).toBe(true);
    return response;
  };
  const scan = (limit = 40) =>
    request({
      action: 'scanCompact',
      maxElements: limit,
      includeTextBlocks: false,
      includeIframes: false,
    });
  const element = (tag: string, id: string, rect?: Partial<Rect>) => new Element(tag, id, rect);
  const shadow = (host: Element, ...children: Element[]) => {
    host.shadowRoot = new ShadowRoot(host);
    host.shadowRoot.append(...children);
  };
  return { document, window, element, shadow, scan, request };
}

function ids(result: any): string[] {
  return result.elements.map((item: any) => item.attrs?.id || item.attributes?.id);
}

describe('compact scan discovery before truncation', () => {
  test.each([true, false])(
    'reports document visibility without hiding the scan: hidden=%s',
    (hidden) => {
      const page = fixture();
      Object.assign(page.document, {
        hidden,
        visibilityState: hidden ? 'hidden' : 'visible',
        hasFocus: () => true,
      });
      page.document.body.append(page.element('button', 'control'));
      const result = page.scan();
      expect(result.pageVisibility).toEqual({
        hidden,
        visibilityState: hidden ? 'hidden' : 'visible',
        hasFocus: true,
      });
      expect(ids(result)).toEqual(['control']);
    },
  );
  test.each([40, 160])(
    'finds screen content after 180 off-canvas menu links at limit %s',
    (limit) => {
      const page = fixture();
      const sidebar = page.element('aside', 'sidebar');
      for (let i = 0; i < 180; i++) {
        const link = page.element('a', `menu-${i}`, {
          left: -217,
          top: 1027,
          width: 203,
          height: 34,
        });
        link.attrs.href = `#menu-${i}`;
        sidebar.append(link);
      }
      const add = page.element('button', 'add-record', {
        left: 1185,
        top: 450,
        width: 100,
        height: 36,
      });
      // Deliberately no main/role=main landmark, as in many application shells.
      page.document.body.append(sidebar, add);
      const result = page.scan(limit);
      expect(ids(result)[0]).toBe('add-record');
      expect(result.elements).toHaveLength(limit);
      expect(result.counts.elements).toBe(181);
      expect(result.truncated.elements).toBe(true);
      expect(page.window.__claudeElementMap[result.elements[0].ref].deref()).toBe(add);
    },
  );

  test('prioritizes main content over preceding visible navigation without removing navigation', () => {
    const page = fixture();
    const nav = page.element('nav', 'nav');
    nav.append(...Array.from({ length: 60 }, (_, i) => page.element('button', `nav-${i}`)));
    const main = page.element('main', 'main').append(page.element('button', 'topic'));
    page.document.body.append(nav, main);
    expect(ids(page.scan())).toEqual([
      'topic',
      ...Array.from({ length: 39 }, (_, i) => `nav-${i}`),
    ]);
  });

  test.each(['overflowX', 'overflowY'] as const)(
    'honors ancestor %s clipping inside the viewport',
    (axis) => {
      const page = fixture();
      const clip = page.element('div', 'scrollport', { left: 0, top: 0, width: 80, height: 80 });
      clip.style[axis] = 'auto';
      const outside = axis === 'overflowX' ? { left: 100, top: 20 } : { left: 20, top: 100 };
      const clipped = page.element('button', 'clipped', { ...outside, width: 20, height: 20 });
      clip.append(clipped);
      page.document.body.append(clip, page.element('button', 'visible'));
      expect(ids(page.scan(1))).toEqual(['visible']);
      expect(ids(page.scan(2))).toEqual(['visible', 'clipped']);
    },
  );

  test('retains below-fold controls after visible ones and preserves DOM order in ordinary queries', () => {
    const page = fixture();
    page.document.body.append(
      page.element('button', 'below', { top: 1500 }),
      page.element('button', 'first-visible'),
      page.element('button', 'second-visible'),
    );
    const result = page.scan(3);
    expect(ids(result)).toEqual(['first-visible', 'second-visible', 'below']);
    expect(result.truncated.elements).toBe(false);
    expect(ids(page.request({ action: 'queryElements', selector: 'button', limit: 2 }))).toEqual([
      'below',
      'first-visible',
    ]);
  });

  test('keeps a partially clipped control eligible for the visible budget', () => {
    const page = fixture();
    const clip = page.element('div', 'clip', { left: 0, top: 0, width: 150, height: 150 });
    clip.style.overflowY = 'hidden';
    clip.append(page.element('button', 'partial', { left: 10, top: 140, height: 30 }));
    page.document.body.append(page.element('button', 'below', { top: 1000 }), clip);
    expect(ids(page.scan(1))).toEqual(['partial']);
  });

  test('prioritizes open dialogs/popovers and never revives hidden or closed controls', () => {
    const page = fixture();
    const closed = page.element('dialog', 'closed').append(page.element('button', 'closed-action'));
    const open = page.element('dialog', 'open').append(page.element('button', 'dialog-action'));
    open.attrs.open = '';
    const popover = page.element('div', 'popover').append(page.element('button', 'popover-action'));
    popover.attrs.popover = '';
    popover.attrs['data-popover-open'] = '';
    const hidden = page.element('button', 'hidden');
    hidden.style.display = 'none';
    const transparent = page
      .element('div', 'transparent')
      .append(page.element('button', 'transparent-action'));
    transparent.style.opacity = '0';
    page.document.body.append(
      page.element('button', 'background'),
      closed,
      hidden,
      transparent,
      open,
      popover,
    );
    expect(ids(page.scan())).toEqual(['dialog-action', 'popover-action', 'background']);
  });

  test('crosses shadow hosts for dialog priority and overflow clipping', () => {
    const page = fixture();
    const dialog = page.element('div', 'dialog');
    dialog.attrs.role = 'dialog';
    const host = page.element('custom-panel', 'host');
    page.shadow(host, page.element('button', 'shadow-dialog'));
    dialog.append(host);
    const clippedHost = page.element('custom-scroll', 'clipped-host', {
      left: 0,
      top: 0,
      width: 50,
      height: 50,
    });
    clippedHost.style.overflowY = 'scroll';
    page.shadow(clippedHost, page.element('button', 'shadow-clipped', { left: 0, top: 200 }));
    page.document.body.append(clippedHost, page.element('button', 'background'), dialog);
    expect(ids(page.scan())).toEqual(['shadow-dialog', 'background', 'shadow-clipped']);
  });

  test.each(['self', 'ancestor', 'shadow'] as const)(
    'excludes aria-hidden mirror inputs through %s without changing ordinary queries',
    (kind) => {
      const page = fixture();
      const mirror = page.element('input', 'mirror', { width: 1, height: 1 });
      mirror.style.clipPath = 'inset(50%)';
      if (kind === 'self') {
        mirror.attrs['aria-hidden'] = 'true';
        page.document.body.append(mirror);
      } else {
        const wrapper = page.element('div', 'hidden-wrapper');
        wrapper.attrs['aria-hidden'] = 'true';
        // A descendant cannot opt back into the accessibility tree on its own.
        mirror.attrs['aria-hidden'] = 'false';
        if (kind === 'shadow') page.shadow(wrapper, mirror);
        else wrapper.append(mirror);
        page.document.body.append(wrapper);
      }
      page.document.body.append(page.element('input', 'visible-field'));
      expect(ids(page.scan(1))).toEqual(['visible-field']);
      expect(ids(page.scan())).toEqual(['visible-field']);
      expect(ids(page.request({ action: 'queryElements', selector: 'input', limit: 3 }))).toEqual([
        'mirror',
        'visible-field',
      ]);
    },
  );

  test.each(['input', 'textarea', 'select'])(
    'resolves multiple aria-labelledby IDs before fallback labels for %s without exposing values',
    (tag) => {
      const page = fixture();
      const name = page.element('span', 'name');
      name.textContent = '  Content\n  ';
      const qualifier = page.element('span', 'qualifier');
      qualifier.textContent = '\t required  ';
      const label = page.element('label', 'label');
      label.attrs.for = 'field';
      label.textContent = 'Associated label';
      const field = page.element(tag, 'field');
      field.attrs['aria-labelledby'] = ' name\tmissing\nqualifier ';
      field.attrs['aria-label'] = 'Aria fallback';
      field.attrs.placeholder = 'Placeholder fallback';
      field.value = 'secret-field-value';
      field.textContent = 'secret-default-value';
      page.document.body.append(name, qualifier, label, field);
      const result = page.scan();
      expect(result.elements[0].text).toBe('Content required');
      expect(result.elements[0].attrs.hasValue).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret-');
    },
  );

  test.each([
    ['aria', 'Aria label'],
    ['associated', 'Associated label'],
    ['placeholder', 'Placeholder text'],
    ['unlabelled', ''],
  ])('uses %s fallback without reading a form value', (kind, expected) => {
    const page = fixture();
    const field = page.element('textarea', 'field');
    field.attrs['aria-labelledby'] = 'missing';
    field.value = 'private-value';
    field.textContent = 'private-default-value';
    if (kind === 'aria') field.attrs['aria-label'] = '  Aria\n label  ';
    if (kind !== 'unlabelled') field.attrs.placeholder = '  Placeholder\ttext ';
    if (kind === 'aria' || kind === 'associated') {
      const label = page.element('label', 'label');
      label.attrs.for = 'field';
      label.textContent = ' Associated\n label ';
      page.document.body.append(label);
    }
    page.document.body.append(field);
    const result = page.scan();
    expect(result.elements[0].text).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  test('resolves label IDs inside the same shadow root instead of another document label', () => {
    const page = fixture();
    const wrong = page.element('span', 'field-label');
    wrong.textContent = 'Wrong document label';
    const label = page.element('span', 'field-label');
    label.textContent = 'Shadow label';
    const field = page.element('input', 'field');
    field.attrs['aria-labelledby'] = 'field-label';
    const host = page.element('custom-field', 'host');
    page.shadow(host, label, field);
    page.document.body.append(wrong, host);
    expect(page.scan().elements[0].text).toBe('Shadow label');
  });

  test('keeps visible combobox text separate from its resolved field label', () => {
    const page = fixture();
    const label = page.element('span', 'type-label');
    label.textContent = '类型';
    const button = page.element('button', 'record-type');
    button.attrs.role = 'combobox';
    button.attrs['aria-labelledby'] = 'type-label';
    button.attrs['aria-label'] = 'Fallback';
    button.innerText = ' TXT ';
    button.textContent = 'Hidden text TXT';
    page.document.body.append(label, button);
    expect(page.scan().elements[0]).toMatchObject({ text: 'TXT', label: '类型' });
  });

  test('does not use a referenced textarea as a source of label text', () => {
    const page = fixture();
    const secret = page.element('textarea', 'secret');
    secret.textContent = 'private-default-value';
    const field = page.element('input', 'field');
    field.attrs['aria-labelledby'] = 'secret';
    field.attrs.placeholder = 'Safe fallback';
    page.document.body.append(secret, field);
    const result = page.scan();
    expect(result.elements[1].text).toBe('Safe fallback');
    expect(JSON.stringify(result)).not.toContain('private-default-value');
  });

  test('returns disabled controls with their state instead of hiding them', () => {
    const page = fixture();
    const disabled = page.element('button', 'disabled');
    disabled.attrs.disabled = '';
    page.document.body.append(disabled);
    const result = page.scan();
    expect(ids(result)).toEqual(['disabled']);
    expect(result.elements[0].enabled).toBe(false);
  });
});

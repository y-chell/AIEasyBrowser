/**
 * Page-side hook runtime for chrome_cdp_inject. It is stringified into a document-start script
 * (Page.addScriptToEvaluateOnNewDocument), so it must stay self-contained: no imports, no closure
 * over module scope, no syntax the bundler would rewrite into helpers. Records go to the session's
 * Runtime binding; the background treats them as page data, not trusted telemetry.
 */

export type HookKind = 'function' | 'property' | 'fetch' | 'xhr';

export interface HookSpec {
  id: string;
  kind: HookKind;
  /** Property path from globalThis, already split, e.g. ['crypto', 'subtle', 'sign']. */
  parts: string[];
  access: 'get' | 'set' | 'both';
  maxRecords: number;
  stackDepth: number;
  sourceUrl: string;
}

export function installHook(g: any, bindingName: string, spec: HookSpec): void {
  const binding = g[bindingName];
  if (typeof binding !== 'function') return;
  const stringify = JSON.stringify;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const getOwnDescriptor = Object.getOwnPropertyDescriptor;
  const defineProperty = Object.defineProperty;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectKeys = Object.keys;
  const isArray = Array.isArray;
  const NativeError = Error;
  const NativeProxy = Proxy;
  const NativeWeakMap = WeakMap;
  const now = Date.now;
  const href = () => {
    try {
      return String(g.location.href);
    } catch (error) {
      return '';
    }
  };
  let sent = 0;
  let limited = false;
  let busy = false;
  let nextCall = 0;

  const send = (message: any, counted: boolean) => {
    if (counted) {
      if (sent >= spec.maxRecords) {
        if (!limited) {
          limited = true;
          message = { id: spec.id, type: 'limit', maxRecords: spec.maxRecords };
        } else {
          return;
        }
      } else {
        sent += 1;
      }
    }
    message.id = spec.id;
    message.href = href();
    try {
      binding(stringify(message));
    } catch (error) {
      // A detached session removes the binding target; the page must keep running.
    }
  };

  const preview = (value: any, depth: number): any => {
    const type = typeof value;
    if (value === null || type === 'boolean') return value;
    if (type === 'number') return isFinite(value) ? value : String(value);
    if (type === 'string') {
      return value.length > 200 ? value.slice(0, 200) + '...[' + value.length + ' chars]' : value;
    }
    if (type === 'undefined') return '[undefined]';
    if (type === 'bigint') return String(value) + 'n';
    if (type === 'symbol') return String(value);
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    try {
      if (value instanceof NativeError) {
        return { error: String(value.name), message: preview(value.message, 0) };
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return (
          '[' + (value.constructor && value.constructor.name) + ' ' + value.byteLength + ' bytes]'
        );
      }
      if (typeof value.then === 'function') return '[Promise]';
      if (depth <= 0) {
        return isArray(value)
          ? '[Array(' + value.length + ')]'
          : '[' + ((value.constructor && value.constructor.name) || 'Object') + ']';
      }
      if (isArray(value)) {
        const items: any[] = [];
        for (let i = 0; i < value.length && i < 10; i++) items.push(preview(value[i], depth - 1));
        if (value.length > 10) items.push('...[' + value.length + ' items]');
        return items;
      }
      const out: any = {};
      const keys = objectKeys(value);
      for (let i = 0; i < keys.length && i < 10; i++) {
        const descriptor = getOwnDescriptor(value, keys[i]);
        // Reading an accessor would run page code and could recurse into a hook.
        out[keys[i]] =
          descriptor && 'value' in descriptor ? preview(descriptor.value, depth - 1) : '[getter]';
      }
      if (keys.length > 10) out['...'] = keys.length + ' keys';
      return out;
    } catch (error) {
      return '[unreadable]';
    }
  };

  const stack = (): string[] | undefined => {
    if (spec.stackDepth <= 0) return undefined;
    const text = new NativeError().stack || '';
    const lines = text.split('\n');
    const frames: string[] = [];
    for (let i = 1; i < lines.length && frames.length < spec.stackDepth; i++) {
      const line = lines[i].trim();
      if (line && line.indexOf(spec.sourceUrl) < 0) frames.push(line);
    }
    return frames;
  };

  const ownerOf = (): any => {
    let owner = g;
    for (let i = 0; i < spec.parts.length - 1; i++) {
      owner = owner[spec.parts[i]];
      if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) {
        return undefined;
      }
    }
    return owner;
  };

  const findDescriptor = (target: any, key: string): any => {
    for (let object = target; object; object = getPrototypeOf(object)) {
      const descriptor = getOwnDescriptor(object, key);
      if (descriptor) return { holder: object, descriptor: descriptor };
    }
    return undefined;
  };

  const replace = (owner: any, key: string, wrapped: any): string | undefined => {
    const descriptor = getOwnDescriptor(owner, key);
    if (descriptor && !descriptor.configurable && !descriptor.writable) {
      return 'property is neither configurable nor writable';
    }
    if (descriptor && !descriptor.configurable) {
      owner[key] = wrapped;
    } else {
      defineProperty(owner, key, {
        value: wrapped,
        writable: descriptor ? descriptor.writable : true,
        enumerable: descriptor ? descriptor.enumerable : false,
        configurable: true,
      });
    }
    return owner[key] === wrapped ? undefined : 'assignment did not take effect';
  };

  const installFunction = (): string | undefined => {
    const owner = ownerOf();
    if (owner === undefined) return 'owner object not found';
    const key = spec.parts[spec.parts.length - 1];
    const original = owner[key];
    if (typeof original !== 'function') return 'not a function (' + typeof original + ')';
    const invoke = (call: () => any, args: any[], self: any, isNew: boolean) => {
      if (busy) return call();
      busy = true;
      const callId = ++nextCall;
      const record: any = {
        type: 'call',
        call: callId,
        path: spec.parts.join('.'),
        // The array itself takes one level: each argument is previewed like a return value.
        args: preview(args, 3),
        stack: stack(),
      };
      if (isNew) record.construct = true;
      else if (self !== g && self !== undefined) record.this = preview(self, 0);
      busy = false;
      try {
        const result = call();
        busy = true;
        record.result = preview(result, 2);
        send(record, true);
        busy = false;
        return result;
      } catch (error) {
        busy = true;
        record.threw = preview(error, 1);
        send(record, true);
        busy = false;
        throw error;
      }
    };
    const wrapped = new NativeProxy(original, {
      apply(target: any, self: any, args: any[]) {
        return invoke(() => apply(target, self, args), args, self, false);
      },
      construct(target: any, args: any[], newTarget: any) {
        return invoke(() => construct(target, args, newTarget), args, undefined, true);
      },
    });
    return replace(owner, key, wrapped);
  };

  const installProperty = (): string | undefined => {
    const owner = ownerOf();
    if (owner === undefined) return 'owner object not found';
    const key = spec.parts[spec.parts.length - 1];
    const path = spec.parts.join('.');
    const found = findDescriptor(owner, key);
    const note = (op: 'get' | 'set', value: any) => {
      if (busy || (spec.access !== 'both' && spec.access !== op)) return;
      busy = true;
      send({ type: op, path: path, value: preview(value, 2), stack: stack() }, true);
      busy = false;
    };
    if (found && (found.descriptor.get || found.descriptor.set)) {
      // Accessors (document.cookie) live on a prototype; wrap them where they are defined.
      if (!found.descriptor.configurable) return 'accessor is not configurable';
      const getter = found.descriptor.get;
      const setter = found.descriptor.set;
      defineProperty(found.holder, key, {
        get: getter
          ? function (this: any) {
              const value = apply(getter, this, []);
              note('get', value);
              return value;
            }
          : undefined,
        set: setter
          ? function (this: any, value: any) {
              note('set', value);
              apply(setter, this, [value]);
            }
          : undefined,
        enumerable: found.descriptor.enumerable,
        configurable: true,
      });
      return undefined;
    }
    const own = getOwnDescriptor(owner, key);
    if (own && !own.configurable) return 'property is not configurable';
    // A data property (or a global that does not exist yet) becomes an accessor on the owner.
    let current = found ? found.descriptor.value : undefined;
    const writable = found ? found.descriptor.writable !== false : true;
    defineProperty(owner, key, {
      get() {
        note('get', current);
        return current;
      },
      set(value: any) {
        note('set', value);
        if (writable) current = value;
      },
      enumerable: own ? own.enumerable : true,
      configurable: true,
    });
    return undefined;
  };

  const headerNames = (headers: any): string[] => {
    const names: string[] = [];
    try {
      if (!headers) return names;
      if (typeof headers.forEach === 'function' && !isArray(headers)) {
        headers.forEach((_value: any, name: string) => names.push(String(name)));
      } else if (isArray(headers)) {
        for (let i = 0; i < headers.length; i++) names.push(String(headers[i][0]));
      } else {
        const keys = objectKeys(headers);
        for (let i = 0; i < keys.length; i++) names.push(keys[i]);
      }
    } catch (error) {
      names.push('[unreadable]');
    }
    return names;
  };

  const installFetch = (): string | undefined => {
    const original = g.fetch;
    if (typeof original !== 'function') return 'fetch is not available';
    const wrapped = new NativeProxy(original, {
      apply(target: any, self: any, args: any[]) {
        if (busy) return apply(target, self, args);
        busy = true;
        const callId = ++nextCall;
        const started = now();
        const input = args[0];
        const init = args[1] || {};
        let url = '';
        let method = 'GET';
        let names: string[] = [];
        try {
          const isRequest = typeof input === 'object' && input !== null && 'url' in input;
          url = String(isRequest ? input.url : input);
          method = String(init.method || (isRequest && input.method) || 'GET').toUpperCase();
          names = headerNames(init.headers || (isRequest ? input.headers : undefined));
        } catch (error) {
          url = '[unreadable]';
        }
        const record: any = {
          type: 'fetch',
          call: callId,
          method: method,
          url: url,
          headerNames: names,
          body: init.body === undefined ? undefined : preview(init.body, 1),
          stack: stack(),
        };
        busy = false;
        let promise: any;
        try {
          promise = apply(target, self, args);
        } catch (error) {
          busy = true;
          record.threw = preview(error, 1);
          send(record, true);
          busy = false;
          throw error;
        }
        const settle = (field: string, value: any) => {
          busy = true;
          record[field] = value;
          record.ms = now() - started;
          send(record, true);
          busy = false;
        };
        // Any then() marks the original promise handled, so the page gets the derived promise:
        // a rejection the page does not catch still reaches unhandledrejection.
        try {
          return apply(promise.then, promise, [
            (response: any) => {
              settle('status', response && response.status);
              return response;
            },
            (error: any) => {
              settle('rejected', preview(error, 1));
              throw error;
            },
          ]);
        } catch (error) {
          // A non-standard return value; the page gets it unchanged.
          return promise;
        }
      },
    });
    return replace(g, 'fetch', wrapped);
  };

  const installXhr = (): string | undefined => {
    const Xhr = g.XMLHttpRequest;
    if (typeof Xhr !== 'function') return 'XMLHttpRequest is not available';
    const proto = Xhr.prototype;
    const state = new NativeWeakMap();
    const wrap = (name: string, before: (xhr: any, args: any[]) => void) => {
      const original = proto[name];
      if (typeof original !== 'function') return name + ' is not a function';
      const wrapped = new NativeProxy(original, {
        apply(target: any, self: any, args: any[]) {
          if (!busy) {
            busy = true;
            try {
              before(self, args);
            } catch (error) {
              // Never break the page's request because a record could not be built.
            }
            busy = false;
          }
          return apply(target, self, args);
        },
      });
      return replace(proto, name, wrapped);
    };
    const failure =
      wrap('open', (xhr, args) => {
        state.set(xhr, { method: String(args[0]).toUpperCase(), url: String(args[1]), names: [] });
      }) ||
      wrap('setRequestHeader', (xhr, args) => {
        const entry = state.get(xhr);
        if (entry) entry.names.push(String(args[0]));
      }) ||
      wrap('send', (xhr, args) => {
        const entry = state.get(xhr) || { method: '', url: '', names: [] };
        const record: any = {
          type: 'xhr',
          call: ++nextCall,
          method: entry.method,
          url: entry.url,
          headerNames: entry.names,
          body: args[0] === undefined || args[0] === null ? undefined : preview(args[0], 1),
          stack: stack(),
        };
        const started = now();
        xhr.addEventListener('loadend', () => {
          busy = true;
          record.status = xhr.status;
          record.ms = now() - started;
          send(record, true);
          busy = false;
        });
      });
    return failure;
  };

  const installers: Record<HookKind, () => string | undefined> = {
    function: installFunction,
    property: installProperty,
    fetch: installFetch,
    xhr: installXhr,
  };
  let installed = false;
  const attempt = (phase: string, last: boolean) => {
    if (installed) return;
    let error: string | undefined;
    try {
      error = installers[spec.kind]();
    } catch (thrown) {
      error = String(thrown);
    }
    if (!error) {
      installed = true;
      send({ type: 'installed', phase: phase }, false);
    } else if (last) {
      send({ type: 'failed', phase: phase, error: error }, false);
    }
  };
  // Page globals such as an app's signer usually do not exist at document start; retry once the
  // document has parsed and once it has loaded before reporting failure. Our listener was added
  // first, so the parsed retry waits a task for the page's own DOMContentLoaded handlers.
  const later = setTimeout;
  const doc = g.document;
  const complete = !doc || doc.readyState === 'complete';
  attempt('start', complete);
  if (!installed && !complete) {
    if (doc.readyState === 'loading') {
      doc.addEventListener(
        'DOMContentLoaded',
        () => later(() => attempt('DOMContentLoaded', false), 0),
        {
          once: true,
        },
      );
    }
    g.addEventListener('load', () => attempt('load', true), { once: true });
  }
}

/** Document-start source for one hook: the runtime above applied to its spec. */
export function hookSource(bindingName: string, spec: HookSpec): string {
  return (
    `(${installHook.toString()})(globalThis, ${JSON.stringify(bindingName)}, ${JSON.stringify(spec)});\n` +
    `//# sourceURL=${spec.sourceUrl}`
  );
}

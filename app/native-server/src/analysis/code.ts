import { parse as acornParse } from 'acorn';
import esquery from 'esquery';
import { css as beautifyCss, html as beautifyHtml, js as beautifyJs } from 'js-beautify';
import { AnalysisError, invalid } from './errors';
import { byteLength, clip, lineStarts, locate, shown, type TextBase } from './text';

// ESTree nodes from acorn. They are walked generically, so a loose type is enough.
type Node = any;

export type CodeLanguage = 'js' | 'css' | 'html';

export function beautify(text: string, language: CodeLanguage): string {
  const options = { indent_size: 2, end_with_newline: true };
  if (language === 'css') return beautifyCss(text, options);
  if (language === 'html') return beautifyHtml(text, options);
  return beautifyJs(text, options);
}

/**
 * Parses a script first (most bundles), then a module. When both fail, the error that got
 * further into the text is reported, at its resource-relative 0-based location.
 */
export function parseProgram(text: string, base: TextBase): Node {
  const failures: Array<{ message: string; pos: number }> = [];
  for (const sourceType of ['script', 'module'] as const) {
    try {
      return acornParse(text, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: sourceType === 'script',
      });
    } catch (error) {
      const failure = error as { message?: string; pos?: number };
      failures.push({ message: String(failure.message), pos: failure.pos ?? -1 });
    }
  }
  const worst = failures[1].pos > failures[0].pos ? failures[1] : failures[0];
  const where = worst.pos >= 0 ? locate(lineStarts(text), worst.pos, base) : undefined;
  // acorn appends its own 1-based "(line:column)"; report the 0-based one used everywhere else.
  const message = worst.message.replace(/\s*\(\d+:\d+\)$/, '');
  throw new AnalysisError(
    'PARSE_FAILED',
    where
      ? `${message} at line ${where.line}, column ${where.column} (offset ${worst.pos})`
      : message,
  );
}

const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out;
}

function isFunction(node: Node): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

interface Visit {
  node: Node;
  parent: Node | undefined;
  /** Name of the innermost enclosing function, '' at top level. */
  enclosing: string;
  /** Function scope the node appears in. */
  scope: Scope;
  /** For function nodes: the scope of their own parameters and body. */
  inner?: Scope;
}

/** Function-level scope; block scoping is ignored, which is enough for bundle runtimes. */
interface Scope {
  node: Node;
  parent?: Scope;
  params: string[];
  vars: Map<string, Node>;
}

/**
 * Pre-order walk with an explicit stack: minified bundles nest deep enough to overflow a
 * recursive walker.
 */
function walk(root: Node, visit: (entry: Visit) => void): void {
  const program: Scope = { node: root, params: [], vars: new Map() };
  const stack: Visit[] = [{ node: root, parent: undefined, enclosing: '', scope: program }];
  while (stack.length) {
    const entry = stack.pop()!;
    const { node } = entry;
    let { enclosing, scope } = entry;
    if (isFunction(node)) {
      entry.inner = {
        node,
        parent: scope,
        params: node.params.map((param: Node) => (param.type === 'Identifier' ? param.name : '')),
        vars: new Map(),
      };
    }
    visit(entry);
    if (entry.inner) {
      enclosing = functionName(node, entry.parent) ?? '(anonymous)';
      scope = entry.inner;
    }
    const next = children(node);
    for (let index = next.length - 1; index >= 0; index -= 1) {
      stack.push({ node: next[index], parent: node, enclosing, scope });
    }
  }
}

function keyName(key: Node, computed: boolean): string | undefined {
  if (computed) return key.type === 'Literal' ? String(key.value) : undefined;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return '#' + key.name;
  if (key.type === 'Literal') return String(key.value);
  return undefined;
}

/** Dotted path of an expression such as `a.b["c"].d`, limited to plain member chains. */
export function pathOf(node: Node, depth = 0): string | undefined {
  if (depth > 32) return undefined;
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'ThisExpression':
      return 'this';
    case 'Super':
      return 'super';
    case 'ChainExpression':
      return pathOf(node.expression, depth + 1);
    case 'MemberExpression': {
      const object = pathOf(node.object, depth + 1);
      if (object === undefined) return undefined;
      if (node.computed) {
        return node.property.type === 'Literal'
          ? `${object}[${JSON.stringify(node.property.value)}]`
          : `${object}[…]`;
      }
      return `${object}.${keyName(node.property, false)}`;
    }
    default:
      return undefined;
  }
}

function functionName(node: Node, parent: Node | undefined): string | undefined {
  if (node.id?.name) return node.id.name;
  if (!parent) return undefined;
  if (
    parent.type === 'VariableDeclarator' &&
    parent.init === node &&
    parent.id.type === 'Identifier'
  )
    return parent.id.name;
  if (parent.type === 'AssignmentExpression' && parent.right === node) return pathOf(parent.left);
  if (
    parent.type === 'AssignmentPattern' &&
    parent.right === node &&
    parent.left.type === 'Identifier'
  )
    return parent.left.name;
  if (
    (parent.type === 'Property' ||
      parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
    parent.value === node
  )
    return keyName(parent.key, parent.computed);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// search

export type SearchKind = 'function' | 'call' | 'string' | 'selector';

export interface SearchOptions {
  kind: SearchKind;
  query?: string;
  isRegex: boolean;
  caseSensitive: boolean;
  selector?: string;
  contextChars: number;
  cursor: number;
  limit: number;
  maxOutputBytes: number;
  sanitize: boolean;
}

interface Match {
  node: Node;
  name?: string;
  value?: string;
  enclosing?: string;
}

function matcher(options: SearchOptions): (value: string | undefined) => boolean {
  const { query } = options;
  if (query === undefined || query === '') return () => true;
  if (options.isRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, options.caseSensitive ? '' : 'i');
    } catch (error) {
      invalid(`query is not a valid regular expression: ${(error as Error).message}`);
    }
    return (value) => value !== undefined && pattern.test(value);
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (value) =>
    value !== undefined && (options.caseSensitive ? value : value.toLowerCase()).includes(needle);
}

function stringValue(node: Node): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const quasi = node.quasis[0];
    return quasi.value.cooked ?? quasi.value.raw;
  }
  return undefined;
}

function collect(ast: Node, options: SearchOptions): Match[] {
  const matches: Match[] = [];
  if (options.kind === 'selector') {
    let selector: ReturnType<typeof esquery.parse>;
    try {
      selector = esquery.parse(options.selector!);
    } catch (error) {
      invalid(`selector is not a valid esquery selector: ${(error as Error).message}`);
    }
    const found = new Set<Node>(esquery.match(ast, selector));
    // One walk gives every matched node its enclosing function name.
    walk(ast, ({ node, enclosing }) => {
      if (found.has(node)) matches.push({ node, enclosing });
    });
    return matches;
  }
  const accepts = matcher(options);
  walk(ast, ({ node, parent, enclosing }) => {
    if (options.kind === 'function' && isFunction(node)) {
      const name = functionName(node, parent);
      if (accepts(name ?? '')) matches.push({ node, name: name ?? '(anonymous)', enclosing });
    } else if (
      options.kind === 'call' &&
      (node.type === 'CallExpression' || node.type === 'NewExpression')
    ) {
      const name = pathOf(node.callee) ?? '';
      if (accepts(name)) matches.push({ node, name, enclosing });
    } else if (options.kind === 'string') {
      const value = stringValue(node);
      if (value !== undefined && accepts(value)) matches.push({ node, value, enclosing });
    }
  });
  return matches;
}

const MAX_NAME_CHARS = 200;
const MAX_VALUE_CHARS = 500;

export function search(text: string, base: TextBase, options: SearchOptions) {
  const ast = parseProgram(text, base);
  const matches = collect(ast, options).sort(
    (a, b) => a.node.start - b.node.start || b.node.end - a.node.end,
  );
  const starts = lineStarts(text);
  const page: object[] = [];
  let used = 0;
  let redacted = false;
  let index = options.cursor;
  let truncatedByBytes = false;
  for (; index < matches.length && page.length < options.limit; index += 1) {
    const match = matches[index];
    const { start, end } = match.node;
    const before = text.slice(Math.max(0, start - options.contextChars), start);
    const body = text.slice(start, Math.min(end, start + options.contextChars));
    const after =
      end <= start + options.contextChars ? text.slice(end, end + options.contextChars) : '…';
    const view = (value: string) => {
      const result = shown(value, options.sanitize);
      redacted ||= result.redacted;
      return result.text;
    };
    const entry = {
      ...locate(starts, start, base),
      offset: start,
      endOffset: end,
      type: match.node.type,
      ...(match.name !== undefined ? { name: view(clip(match.name, MAX_NAME_CHARS)) } : {}),
      ...(match.value !== undefined ? { value: view(clip(match.value, MAX_VALUE_CHARS)) } : {}),
      enclosing: view(clip(match.enclosing || '', MAX_NAME_CHARS)),
      snippet: view(before + body + after),
    };
    const size = byteLength(entry);
    if (page.length > 0 && used + size > options.maxOutputBytes) {
      truncatedByBytes = true;
      break;
    }
    page.push(entry);
    used += size;
  }
  return {
    kind: options.kind,
    total: matches.length,
    matches: page,
    hasMore: index < matches.length,
    ...(index < matches.length ? { nextCursor: String(index) } : {}),
    ...(truncatedByBytes ? { pageTruncatedByBytes: true } : {}),
    ...(redacted ? { redacted: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// unpack

export type BundleFormat = 'webpack' | 'webpack-chunk' | 'browserify';

export interface BundleModule {
  id: string;
  format: BundleFormat;
  chunkIds?: string[];
  offset: number;
  endOffset: number;
  line: number;
  column: number;
  deps: string[];
  entry?: boolean;
}

interface Invocation {
  args: Node[];
  scope: Scope;
}

function literalId(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value);
  return undefined;
}

function propertyId(property: Node): string | undefined {
  if (property.type !== 'Property' || property.computed || property.kind !== 'init')
    return undefined;
  return property.key.type === 'Identifier' ? property.key.name : literalId(property.key);
}

/** `{id: factory, ...}` or `[factory, , factory]`, as webpack emits module tables. */
function moduleTable(node: Node | undefined): Array<{ id: string; factory: Node }> | undefined {
  if (!node) return undefined;
  const entries: Array<{ id: string; factory: Node }> = [];
  if (node.type === 'ObjectExpression') {
    for (const property of node.properties) {
      const id = propertyId(property);
      if (id === undefined || !isFunction(property.value)) return undefined;
      entries.push({ id, factory: property.value });
    }
  } else if (node.type === 'ArrayExpression') {
    for (let index = 0; index < node.elements.length; index += 1) {
      const element = node.elements[index];
      if (element === null) continue;
      if (!isFunction(element)) return undefined;
      entries.push({ id: String(index), factory: element });
    }
  } else {
    return undefined;
  }
  return entries.length ? entries : undefined;
}

/** Callee and arguments of `fn(...)` and `fn.call(this, ...)` invocations. */
function invokedFunction(node: Node): { fn: Node; args: Node[] } | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee;
  if (isFunction(callee)) return { fn: callee, args: node.arguments };
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.name === 'call' &&
    isFunction(callee.object)
  ) {
    return { fn: callee.object, args: node.arguments.slice(1) };
  }
  return undefined;
}

/** `T[id].call(...)` or `T[id](...)` with `id` the given parameter; returns T's name. */
function requireTableName(node: Node, param: string): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  let target = node.callee;
  if (target.type === 'MemberExpression' && !target.computed && target.property.name === 'call')
    target = target.object;
  if (
    target.type === 'MemberExpression' &&
    target.computed &&
    target.object.type === 'Identifier' &&
    target.property.type === 'Identifier' &&
    target.property.name === param
  ) {
    return target.object.name;
  }
  return undefined;
}

function isChunkPush(node: Node): boolean {
  if (node.type !== 'CallExpression' || node.arguments.length !== 1) return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'push')
    return false;
  const arg = node.arguments[0];
  return arg.type === 'ArrayExpression' && arg.elements.length >= 2;
}

function isBrowserifyCall(node: Node): boolean {
  if (node.type !== 'CallExpression' || node.arguments.length !== 3) return false;
  const [table, cache, entries] = node.arguments;
  return (
    table.type === 'ObjectExpression' &&
    table.properties.length > 0 &&
    cache.type === 'ObjectExpression' &&
    entries.type === 'ArrayExpression' &&
    table.properties.every(
      (property: Node) =>
        propertyId(property) !== undefined &&
        property.value.type === 'ArrayExpression' &&
        property.value.elements.length === 2 &&
        property.value.elements[0] &&
        isFunction(property.value.elements[0]) &&
        property.value.elements[1]?.type === 'ObjectExpression',
    )
  );
}

function webpackDeps(factory: Node): string[] {
  const param = factory.params[2];
  if (!param || param.type !== 'Identifier') return [];
  const name = param.name;
  const deps = new Set<string>();
  const stack: Node[] = [factory.body];
  while (stack.length) {
    const node = stack.pop()!;
    // A nested function that rebinds the name no longer refers to webpack's require.
    if (
      isFunction(node) &&
      node.params.some((p: Node) => p.type === 'Identifier' && p.name === name)
    )
      continue;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === name &&
      node.arguments.length === 1
    ) {
      const id = literalId(node.arguments[0]);
      if (id !== undefined) deps.add(id);
    }
    pushAll(stack, children(node));
  }
  return [...deps];
}

export function unpack(
  text: string,
  base: TextBase,
): { formats: BundleFormat[]; modules: BundleModule[] } {
  const ast = parseProgram(text, base);
  const invocations = new Map<Node, Invocation>();
  const requireCandidates: Array<{ scope: Scope; table: string }> = [];
  const chunkPushes: Node[] = [];
  const browserifyCalls: Node[] = [];

  walk(ast, ({ node, scope, inner }) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init)
      scope.vars.set(node.id.name, node.init);
    const invoked = invokedFunction(node);
    if (invoked) invocations.set(invoked.fn, { args: invoked.args, scope });
    if (isChunkPush(node)) chunkPushes.push(node);
    if (isBrowserifyCall(node)) browserifyCalls.push(node);
    // webpack's require: one parameter, reads `.exports`, calls `table[param]`.
    if (
      inner &&
      node.params.length === 1 &&
      node.params[0].type === 'Identifier' &&
      text.slice(node.start, node.end).includes('.exports')
    ) {
      const param = node.params[0].name;
      const stack: Node[] = [node.body];
      while (stack.length) {
        const current = stack.pop()!;
        const table = requireTableName(current, param);
        if (table) {
          requireCandidates.push({ scope: inner, table });
          break;
        }
        pushAll(stack, children(current));
      }
    }
  });

  const resolve = (name: string, from: Scope, depth: number): Node | undefined => {
    for (let scope: Scope | undefined = from; scope; scope = scope.parent) {
      const value = scope.vars.get(name);
      if (value) return deref(value, scope, depth);
      const index = scope.params.indexOf(name);
      if (index >= 0) {
        const invocation = invocations.get(scope.node);
        const arg = invocation?.args[index];
        return arg && invocation ? deref(arg, invocation.scope, depth) : undefined;
      }
    }
    return undefined;
  };
  const deref = (node: Node, scope: Scope, depth: number): Node | undefined => {
    if (node.type !== 'Identifier') return node;
    return depth < 4 ? resolve(node.name, scope, depth + 1) : undefined;
  };

  const modules = new Map<number, BundleModule>();
  const seenTables = new Set<number>();
  const starts = lineStarts(text);
  const add = (
    module: Omit<BundleModule, 'offset' | 'endOffset' | 'line' | 'column'>,
    factory: Node,
  ) => {
    if (modules.has(factory.start)) return;
    modules.set(factory.start, {
      ...module,
      offset: factory.start,
      endOffset: factory.end,
      ...locate(starts, factory.start, base),
    });
  };

  for (const candidate of requireCandidates) {
    const tableNode = resolve(candidate.table, candidate.scope, 0);
    const table = moduleTable(tableNode);
    if (!table || seenTables.has(tableNode.start)) continue;
    seenTables.add(tableNode.start);
    for (const { id, factory } of table)
      add({ id, format: 'webpack', deps: webpackDeps(factory) }, factory);
  }
  for (const push of chunkPushes) {
    const [ids, tableNode] = push.arguments[0].elements;
    const table = moduleTable(tableNode);
    if (!table || ids?.type !== 'ArrayExpression' || seenTables.has(tableNode.start)) continue;
    const chunkIds: Array<string | undefined> = ids.elements.map(literalId);
    if (chunkIds.some((id) => id === undefined)) continue;
    seenTables.add(tableNode.start);
    for (const { id, factory } of table) {
      add(
        { id, format: 'webpack-chunk', chunkIds: chunkIds as string[], deps: webpackDeps(factory) },
        factory,
      );
    }
  }
  for (const call of browserifyCalls) {
    const entries = new Set(call.arguments[2].elements.map(literalId));
    for (const property of call.arguments[0].properties) {
      const id = propertyId(property)!;
      const [factory, depMap] = property.value.elements;
      const deps = new Set<string>();
      for (const dep of depMap.properties) {
        const target = dep.type === 'Property' ? literalId(dep.value) : undefined;
        if (target !== undefined) deps.add(target);
      }
      add(
        { id, format: 'browserify', deps: [...deps], ...(entries.has(id) ? { entry: true } : {}) },
        factory,
      );
    }
  }

  if (!modules.size) {
    throw new AnalysisError(
      'BUNDLE_FORMAT_UNKNOWN',
      'no webpack module table, webpack chunk push or browserify bundle found',
    );
  }
  const list = [...modules.values()].sort((a, b) => a.offset - b.offset);
  return { formats: [...new Set(list.map((module) => module.format))], modules: list };
}

function pushAll(stack: Node[], items: Node[]): void {
  for (const item of items) stack.push(item);
}

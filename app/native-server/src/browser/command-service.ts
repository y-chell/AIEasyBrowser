import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TOOL_SCHEMAS, type BrowserToolResult } from 'aieasybrowser-shared';
import type { NativeMessagingHost } from '../native-messaging-host';
import { BRIDGE_VERSION } from '../constant';
import {
  browserCommandSchema,
  browserFailure,
  BrowserCommandError,
  type ActionStatus,
  type BrowserCommand,
  type BrowserCommandResponse,
  type ScanOptions,
} from './protocol';
import {
  dispatchBrowserTool,
  getBrowserToolDefinition,
  ToolInputError,
  validateBrowserToolArguments,
} from './tool-dispatch';
import { logger, startTimer } from '../util/diag-log';

interface ElementTarget {
  ref: string;
  frameId: number;
  documentId: string;
}

interface BrowserSession {
  id: string;
  tabId?: number;
  revision: number;
  refs: Map<string, ElementTarget>;
  documents: Map<number, string>;
  scanOptions: ScanOptions;
  busy: boolean;
}

interface WorkflowState {
  phase: string;
  actionStatus: ActionStatus;
  completed: number;
  failedAction?: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeToolResult(result: BrowserToolResult, toolName: string): unknown {
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text || { content: result.content };
    }
  }
  if (
    result.isError ||
    (isRecord(payload) && (payload.success === false || payload.ok === false))
  ) {
    const message =
      typeof payload === 'string'
        ? payload
        : isRecord(payload)
          ? String(
              payload.error?.message || payload.error || payload.message || 'Browser tool failed',
            )
          : 'Browser tool failed';
    const directInteraction =
      toolName === 'chrome_click_element' || toolName === 'chrome_fill_or_select';
    const code = /\bSTALE_DOCUMENT:/.test(message)
      ? 'STALE_DOCUMENT'
      : directInteraction && /\bSTALE_REF:/.test(message)
        ? 'STALE_REF'
        : directInteraction && /\bNOT_INTERACTABLE:/.test(message)
          ? 'NOT_INTERACTABLE'
          : /\bTARGET_CLOSED:/.test(message)
            ? 'TARGET_CLOSED'
            : 'BROWSER_ERROR';
    throw new BrowserCommandError(code, message);
  }
  const attachments = result.content.filter((item) => item.type !== 'text');
  return attachments.length ? { data: payload, attachments } : payload;
}

// A disconnected client must not wait for an uncooperative page Promise or commit its late result.
async function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

export class BrowserCommandService {
  private readonly sessions = new Map<string, BrowserSession>();
  /**
   * Correlation id per in-flight command. AsyncLocalStorage keeps it bound to the
   * async call chain, so concurrent commands (including one rejected with
   * SESSION_BUSY) can never overwrite each other's identifier.
   */
  private readonly commandContext = new AsyncLocalStorage<{ id: string }>();

  constructor(private readonly getHost: () => NativeMessagingHost | null) {}

  private currentCommandId(): string {
    return this.commandContext.getStore()?.id ?? 'unknown';
  }

  async execute(
    raw: unknown,
    signal: AbortSignal,
    correlationId?: string,
  ): Promise<BrowserCommandResponse> {
    return this.commandContext.run({ id: correlationId ?? randomUUID() }, () =>
      this.executeInner(raw, signal),
    );
  }

  private async executeInner(raw: unknown, signal: AbortSignal): Promise<BrowserCommandResponse> {
    const parsed = browserCommandSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; ');
      // The request was rejected before validation, so its session and command
      // strings are untrusted. Log only the outcome, never those raw values.
      logger.warn({
        event: 'command.rejected',
        requestId: this.currentCommandId(),
        code: 'INVALID_ARGUMENT',
      });
      return browserFailure('INVALID_ARGUMENT', message);
    }
    const command = parsed.data;
    const elapsed = startTimer();
    if (signal.aborted) {
      return {
        ...browserFailure(
          signal.reason instanceof BrowserCommandError ? signal.reason.code : 'CANCELLED',
          errorMessage(signal.reason),
        ),
        session: command.session,
        phase: command.command,
        completed: 0,
      };
    }
    const state: WorkflowState = {
      phase: command.command,
      actionStatus: 'not_started',
      completed: 0,
    };
    let session = this.sessions.get(command.session);
    if (command.command === 'session' && command.mode === 'list') {
      return {
        ok: true,
        session: command.session,
        result: [...this.sessions].map(([name, entry]) => ({
          name,
          tabId: entry.tabId,
          refs: entry.refs.size,
          busy: entry.busy,
        })),
      };
    }
    if (command.command === 'session' && command.mode === 'forget' && !session) {
      return { ok: true, session: command.session, result: { forgotten: command.session } };
    }
    if (session?.busy)
      return {
        ...browserFailure('SESSION_BUSY', 'Another command is running in this session'),
        session: command.session,
      };
    if (!session) {
      if (this.sessions.size >= 64)
        return browserFailure(
          'SESSION_LIMIT',
          '64 browser sessions are already in use; forget an unused session',
        );
      session = {
        id: randomUUID(),
        revision: 0,
        refs: new Map(),
        documents: new Map(),
        scanOptions: { limit: 40, text: 10 },
        busy: false,
      };
      this.sessions.set(command.session, session);
    }
    session.busy = true;
    try {
      signal.throwIfAborted();
      const result = await this.run(command, session, state, signal);
      signal.throwIfAborted();
      logger.info({
        event: 'command.done',
        requestId: this.currentCommandId(),
        session: session.id,
        tool: command.command,
        durationMs: elapsed(),
        phase: state.phase,
        actionStatus: state.actionStatus,
        completed: state.completed,
      });
      return { ok: true, session: command.session, result };
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      const message = errorMessage(cause);
      const code =
        cause instanceof BrowserCommandError
          ? cause.code
          : cause instanceof ToolInputError
            ? 'INVALID_ARGUMENT'
            : cause instanceof Error && cause.name === 'AbortError'
              ? 'CANCELLED'
              : /\bSTALE_DOCUMENT:/.test(message)
                ? 'STALE_DOCUMENT'
                : /\bTARGET_CLOSED:/.test(message)
                  ? 'TARGET_CLOSED'
                  : 'BROWSER_ERROR';
      if (
        [
          'STALE_DOCUMENT',
          'STALE_REF',
          'NOT_INTERACTABLE',
          'TARGET_CLOSED',
          'INVALID_ARGUMENT',
          'NO_TARGET',
          'BRIDGE_UNAVAILABLE',
        ].includes(code) &&
        state.actionStatus === 'unknown'
      ) {
        state.actionStatus = state.completed > 0 ? 'partial' : 'not_started';
      }
      logger.warn({
        event: 'command.failed',
        requestId: this.currentCommandId(),
        session: session.id,
        tool: command.command,
        durationMs: elapsed(),
        phase: state.phase,
        actionStatus: state.actionStatus,
        completed: state.completed,
        code,
      });
      return {
        ok: false,
        session: command.session,
        error: { code, message },
        ...state,
      };
    } finally {
      session.busy = false;
    }
  }

  private invalidate(session: BrowserSession): void {
    session.refs.clear();
    session.documents.clear();
  }

  private target(session: BrowserSession): number {
    if (!session.tabId)
      throw new BrowserCommandError('NO_TARGET', 'Select a tab with use <tabId> or open <url>');
    return session.tabId;
  }

  private async invoke(
    session: BrowserSession,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    documentId?: string,
  ): Promise<any> {
    signal.throwIfAborted();
    validateBrowserToolArguments(name, args);
    const host = this.getHost();
    if (!host) throw new BrowserCommandError('BRIDGE_UNAVAILABLE', 'Native host is not connected');
    const nativeRequestId = randomUUID();
    const elapsed = startTimer();
    const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
    const frameId = typeof args.frameId === 'number' ? args.frameId : undefined;
    logger.info({
      event: 'tool.start',
      requestId: this.currentCommandId(),
      session: session.id,
      tool: name,
      nativeRequestId,
      tabId,
      frameId,
      hasDocumentId: Boolean(documentId),
    });
    try {
      const result = await withSignal(
        dispatchBrowserTool(
          host,
          name,
          args,
          {
            transport: 'cli',
            sessionId: `cli:${session.id}`,
            requestId: nativeRequestId,
            documentId,
          },
          { signal, requestId: nativeRequestId },
        ),
        signal,
      );
      signal.throwIfAborted();
      // Decode first: a transport-level success that fails to decode is a tool
      // failure, and must not be logged as tool.ok.
      const decoded = decodeToolResult(result, name);
      signal.throwIfAborted();
      logger.info({
        event: 'tool.ok',
        requestId: this.currentCommandId(),
        session: session.id,
        tool: name,
        nativeRequestId,
        tabId,
        durationMs: elapsed(),
      });
      return decoded;
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      logger[
        cause instanceof BrowserCommandError && cause.code === 'STALE_DOCUMENT' ? 'warn' : 'error'
      ]({
        event: 'tool.failed',
        requestId: this.currentCommandId(),
        session: session.id,
        tool: name,
        nativeRequestId,
        tabId,
        frameId,
        durationMs: elapsed(),
        code:
          cause instanceof BrowserCommandError
            ? cause.code
            : cause instanceof Error && cause.name === 'AbortError'
              ? 'CANCELLED'
              : 'BROWSER_ERROR',
        errorName: cause instanceof Error ? cause.name : undefined,
      });
      throw cause instanceof Error || signal.aborted ? cause : error;
    }
  }

  private async scan(session: BrowserSession, signal: AbortSignal, options = session.scanOptions) {
    const tabId = this.target(session);
    this.invalidate(session);
    session.revision += 1;
    const payload = await this.invoke(
      session,
      'chrome_scan_compact',
      {
        tabId,
        frameId: options.frameId,
        maxElements: options.limit,
        maxTextBlocks: options.text,
        includeCoordinates: false,
      },
      signal,
    );
    if (!isRecord(payload) || payload.tabId !== tabId || !Array.isArray(payload.frames)) {
      throw new BrowserCommandError(
        'INVALID_SCAN',
        'The scan did not return the selected tab and frame documents',
      );
    }

    const elements: Record<string, unknown>[] = [];
    const text: Record<string, unknown>[] = [];
    const frames: Record<string, unknown>[] = [];
    const refs = new Map<string, ElementTarget>();
    const documents = new Map<number, string>();
    const errors: string[] = Array.isArray(payload.errors) ? payload.errors.slice(0, 10) : [];
    let truncated = (payload.errors?.length ?? 0) > errors.length || payload.frames.length > 20;
    for (const frame of payload.frames) {
      if (
        !isRecord(frame) ||
        !Number.isInteger(frame.frameId) ||
        typeof frame.documentId !== 'string' ||
        !frame.documentId
      ) {
        throw new BrowserCommandError(
          'INVALID_SCAN',
          'A frame has no documentId; reload the updated extension and scan again',
        );
      }
      documents.set(frame.frameId, frame.documentId);
      if (frames.length < 20)
        frames.push({ frameId: frame.frameId, url: frame.url, readyState: frame.readyState });
      for (const element of Array.isArray(frame.elements) ? frame.elements : []) {
        if (!isRecord(element) || typeof element.ref !== 'string') continue;
        if (elements.length >= options.limit) {
          truncated = true;
          break;
        }
        const ref = `${session.id}.${session.revision}.${elements.length + 1}`;
        refs.set(ref, { ref: element.ref, frameId: frame.frameId, documentId: frame.documentId });
        const attrs = isRecord(element.attrs) ? element.attrs : {};
        elements.push({
          ref,
          frameId: frame.frameId,
          kind: element.kind,
          role: element.role,
          text: typeof element.text === 'string' ? element.text.slice(0, 160) : '',
          ...(element.enabled === false ? { disabled: true } : {}),
          ...(element.visible === false ? { hidden: true } : {}),
          ...(attrs['aria-label'] ? { label: attrs['aria-label'] } : {}),
          ...(attrs.placeholder ? { placeholder: attrs.placeholder } : {}),
          ...(attrs.id ? { id: attrs.id } : {}),
          ...(attrs.href ? { href: attrs.href } : {}),
          ...(typeof attrs.checked === 'boolean' ? { checked: attrs.checked } : {}),
          ...(typeof attrs.hasValue === 'boolean' ? { hasValue: attrs.hasValue } : {}),
          ...(attrs.autofill?.protected ? { protected: true } : {}),
        });
      }
      for (const block of Array.isArray(frame.textBlocks) ? frame.textBlocks : []) {
        if (!isRecord(block)) continue;
        if (text.length >= options.text) {
          truncated = true;
          break;
        }
        text.push({
          frameId: frame.frameId,
          tag: block.tag,
          text: String(block.text || '').slice(0, 300),
        });
      }
      truncated ||= Object.values(frame.truncated || {}).some((value) => value === true);
    }
    signal.throwIfAborted();
    session.refs = refs;
    session.documents = documents;
    session.scanOptions = options;
    return {
      tabId,
      title: payload.title,
      url: payload.url,
      snapshot: `${session.id}.${session.revision}`,
      elements,
      text,
      frames,
      truncated,
      errors,
    };
  }

  private async run(
    command: BrowserCommand,
    session: BrowserSession,
    state: WorkflowState,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (command.command) {
      case 'health': {
        const health = await this.invoke(session, 'chrome_health', {}, signal);
        return {
          ...health,
          bridge: { version: BRIDGE_VERSION, transport: 'cli', sessions: this.sessions.size },
        };
      }
      case 'tabs':
      case 'use': {
        const data = await this.invoke(session, 'get_windows_and_tabs', {}, signal);
        if (!Array.isArray(data?.windows))
          throw new BrowserCommandError('INVALID_RESULT', 'Browser returned no window list');
        const tabs = data.windows.flatMap((window: any) =>
          (Array.isArray(window.tabs) ? window.tabs : []).map((tab: any) => ({
            tabId: tab.tabId ?? tab.id,
            windowId: window.windowId ?? window.id,
            title: tab.title,
            url: tab.url,
            active: tab.active,
          })),
        );
        if (command.command === 'tabs') {
          const match = command.match?.toLowerCase();
          return {
            tabs: match
              ? tabs.filter((tab: any) => `${tab.title} ${tab.url}`.toLowerCase().includes(match))
              : tabs,
          };
        }
        const selected = tabs.find((tab: any) => tab.tabId === command.tabId);
        if (!selected)
          throw new BrowserCommandError('TARGET_CLOSED', `Tab ${command.tabId} is not open`);
        if (command.focus)
          await this.invoke(session, 'chrome_switch_tab', { tabId: command.tabId }, signal);
        signal.throwIfAborted();
        this.invalidate(session);
        session.tabId = command.tabId;
        return selected;
      }
      case 'open': {
        const tabId = command.current ? this.target(session) : undefined;
        this.invalidate(session);
        state.actionStatus = 'unknown';
        const opened = await this.invoke(
          session,
          'chrome_navigate',
          { url: command.url, tabId, background: command.background },
          signal,
        );
        state.actionStatus = 'completed';
        state.completed = 1;
        if (!Number.isInteger(opened?.tabId))
          throw new BrowserCommandError('INVALID_RESULT', 'Navigation returned no tabId');
        session.tabId = opened.tabId;
        return { ...opened, actionStatus: state.actionStatus };
      }
      case 'scan':
        return this.scan(session, signal, {
          limit: command.limit,
          text: command.text,
          frameId: command.frameId,
        });
      case 'act': {
        const tabId = this.target(session);
        // Resolve the whole batch before sending any action, so malformed/foreign refs cannot cause partial execution.
        const actions = command.actions.map((action) => {
          if (action.op === 'press') {
            const frameId = action.frameId ?? 0;
            const documentId = session.documents.get(frameId);
            if (!documentId)
              throw new BrowserCommandError(
                'STALE_REF',
                'Scan the target frame before pressing keys',
              );
            return {
              name: 'chrome_keyboard',
              args: { tabId, frameId, keys: action.keys },
              documentId,
            };
          }
          const target = session.refs.get(action.ref);
          if (!target)
            throw new BrowserCommandError(
              'STALE_REF',
              `Unknown or expired ref ${action.ref}; use refs from this session's latest scan`,
            );
          return {
            name: action.op === 'click' ? 'chrome_click_element' : 'chrome_fill_or_select',
            args: {
              tabId,
              frameId: target.frameId,
              ref: target.ref,
              ...(action.op === 'click' ? { double: action.double } : { value: action.value }),
            },
            documentId: target.documentId,
          };
        });
        this.invalidate(session);
        for (const [index, action] of actions.entries()) {
          state.phase = 'action';
          state.failedAction = index;
          state.actionStatus = 'unknown';
          await this.invoke(session, action.name, action.args, signal, action.documentId);
          state.completed += 1;
          state.actionStatus = state.completed === actions.length ? 'completed' : 'partial';
        }
        delete state.failedAction;
        let expectation: unknown;
        if (command.expect) {
          state.phase = 'expect';
          expectation = await this.invoke(
            session,
            'chrome_assert',
            { tabId, condition: command.expect, timeoutMs: command.timeoutMs },
            signal,
          );
        }
        state.phase = 'scan';
        const page = command.scan ? await this.scan(session, signal) : undefined;
        return {
          actionStatus: 'completed',
          completed: state.completed,
          ...(expectation === undefined ? {} : { expectation }),
          ...(page === undefined ? {} : { page }),
        };
      }
      case 'wait': {
        const tabId = this.target(session);
        state.phase = 'wait';
        const observed = await this.invoke(
          session,
          'chrome_wait_for',
          {
            tabId,
            frameId: command.frameId,
            condition: command.condition,
            timeoutMs: command.timeoutMs,
          },
          signal,
        );
        state.phase = 'scan';
        return { observed, ...(command.scan ? { page: await this.scan(session, signal) } : {}) };
      }
      case 'eval': {
        const tabId = this.target(session);
        this.invalidate(session);
        state.actionStatus = 'unknown';
        const result = await this.invoke(
          session,
          'chrome_javascript',
          {
            tabId,
            frameId: command.frameId,
            code: command.code,
            timeoutMs: command.timeoutMs,
            maxOutputBytes: 16_384,
          },
          signal,
        );
        state.actionStatus = 'completed';
        return result;
      }
      case 'tools': {
        const query = command.query?.toLowerCase();
        return TOOL_SCHEMAS.filter(
          (tool) => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query),
        ).map((tool) => ({
          name: tool.name,
          description: tool.description?.split('\n')[0].slice(0, 160),
        }));
      }
      case 'describe':
        return getBrowserToolDefinition(command.tool);
      case 'call': {
        const tool = getBrowserToolDefinition(command.tool);
        const args = { ...command.args };
        if (
          'tabId' in (tool.inputSchema.properties || {}) &&
          args.tabId === undefined &&
          session.tabId !== undefined
        )
          args.tabId = session.tabId;
        validateBrowserToolArguments(command.tool, args);
        if (
          command.tool === 'chrome_close_tabs' &&
          args.tabIds === undefined &&
          args.url === undefined
        )
          args.tabIds = [this.target(session)];
        this.invalidate(session);
        state.actionStatus = 'unknown';
        const result = await this.invoke(session, command.tool, args, signal);
        state.actionStatus = 'completed';
        return result;
      }
      case 'session':
        if (command.mode === 'forget') {
          this.sessions.delete(command.session);
          return { forgotten: command.session };
        }
        return {
          name: command.session,
          tabId: session.tabId,
          refs: session.refs.size,
          snapshot: `${session.id}.${session.revision}`,
        };
    }
  }
}

import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { getOwnedSession, type HeldSession } from '@/utils/cdp-event-hub';
import { ensureScriptDebugger, findScript } from '@/utils/cdp-scripts';
import {
  OBJECT_GROUP,
  arm,
  disarmIfIdle,
  releaseObjects,
  sessionKey,
  waitForPause,
  type BreakpointRecord,
  type PauseRecord,
} from '@/utils/cdp-debugger';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  isSensitiveKey,
  redactInlineSecrets,
} from '@/utils/output-sanitizer';
import { clampInt, serializeResult } from './cdp';

type Action =
  | 'status'
  | 'wait'
  | 'pause'
  | 'resume'
  | 'stepOver'
  | 'stepInto'
  | 'stepOut'
  | 'continueToLocation'
  | 'setBreakpoint'
  | 'removeBreakpoint'
  | 'evaluate'
  | 'properties'
  | 'blackbox';

interface CdpDebuggerParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  url?: string;
  urlRegex?: string;
  scriptId?: string;
  line?: number;
  column?: number;
  condition?: string;
  logMessage?: string;
  xhrUrl?: string;
  eventName?: string;
  targetName?: string;
  breakpointId?: string;
  after?: number;
  timeoutMs?: number;
  frameIndex?: number;
  scopeIndex?: number;
  objectId?: string;
  expression?: string;
  returnByValue?: boolean;
  depth?: number;
  maxProperties?: number;
  maxFrames?: number;
  patterns?: string[];
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_STEP_WAIT_MS = 3_000;
const MAX_WAIT_MS = 60_000;
const DEFAULT_MAX_FRAMES = 20;
const MAX_FRAMES = 200;
const DEFAULT_MAX_PROPERTIES = 100;
const MAX_PROPERTIES = 1000;
const MAX_DEPTH = 3;
const MAX_DESCRIPTION_CHARS = 1000;
const encoder = new TextEncoder();

const STEP_COMMANDS = {
  stepOver: 'Debugger.stepOver',
  stepInto: 'Debugger.stepInto',
  stepOut: 'Debugger.stepOut',
  continueToLocation: 'Debugger.continueToLocation',
} as const;

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function bytesOf(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function clip(text: string, sanitize: boolean): string {
  const shown = sanitize ? redactInlineSecrets(text).text : text;
  return shown.length > MAX_DESCRIPTION_CHARS
    ? `${shown.slice(0, MAX_DESCRIPTION_CHARS)}... [${shown.length - MAX_DESCRIPTION_CHARS} more chars]`
    : shown;
}

/** Compact Runtime.RemoteObject. A sensitive name hides the value and its objectId. */
function remote(object: any, sanitize: boolean, name?: string) {
  if (!object) return undefined;
  const head = {
    type: object.type,
    ...(object.subtype ? { subtype: object.subtype } : {}),
    ...(object.className ? { className: object.className } : {}),
  };
  if (sanitize && name !== undefined && isSensitiveKey(name)) {
    return { ...head, value: '<redacted>', redacted: true };
  }
  if (object.unserializableValue !== undefined) {
    return { ...head, value: object.unserializableValue };
  }
  if ('value' in object) {
    const value = object.value;
    if (typeof value === 'string') return { ...head, value: clip(value, sanitize) };
    if (value === null || typeof value !== 'object') return { ...head, value };
    const serialized = serializeResult(value, {
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      sanitizeOutput: sanitize,
    });
    return {
      ...head,
      ...('result' in serialized
        ? { value: serialized.result }
        : { valueText: serialized.resultText }),
    };
  }
  return {
    ...head,
    ...(object.description !== undefined
      ? { description: clip(String(object.description), sanitize) }
      : {}),
    ...(object.objectId ? { objectId: object.objectId } : {}),
  };
}

class CdpDebuggerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_DEBUGGER;

  // Resume and stop must work while another call waits on the paused page.
  skipsTargetLock() {
    return true;
  }

  async execute(
    args: CdpDebuggerParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_debugger requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      // Validate before any CDP IO so a bad call does not enable the debugger.
      this.validate(args);
      const session = getOwnedSession(tab.id, owner);
      if (session.ended) {
        throw new Error(
          `CDP_SESSION_ENDED: tab ${tab.id} debugger session ended (${session.ended.reason})`,
        );
      }
      if (args.sessionId && !session.targets.has(args.sessionId)) {
        throw new Error(
          `CDP_UNKNOWN_SESSION: sessionId ${args.sessionId} is not an attached child target of tab ${tab.id}`,
        );
      }
      await ensureScriptDebugger(session);
      const payload = await this.run(session, args);
      const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
      return createStructuredToolResult({
        success: true,
        tool: this.name,
        tabId: tab.id,
        ...this.fit(payload, maxBytes),
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP debugger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private validate(args: CdpDebuggerParams) {
    switch (args.action) {
      case 'setBreakpoint': {
        const targets = ['url', 'urlRegex', 'scriptId', 'xhrUrl', 'eventName'].filter(
          (key) => args[key as keyof CdpDebuggerParams] !== undefined,
        );
        if (targets.length !== 1) {
          invalid('setBreakpoint needs exactly one of url, urlRegex, scriptId, xhrUrl, eventName');
        }
        const lineKind = args.xhrUrl === undefined && args.eventName === undefined;
        if (lineKind && !(Number.isInteger(args.line) && args.line! >= 0)) {
          invalid('url/urlRegex/scriptId breakpoints need a 0-based line');
        }
        if (!lineKind && (args.line !== undefined || args.condition || args.logMessage)) {
          invalid('line, condition, and logMessage apply only to url/urlRegex/scriptId');
        }
        if (args.eventName !== undefined && !args.eventName) invalid('eventName is empty');
        if (args.urlRegex !== undefined) {
          try {
            new RegExp(args.urlRegex);
          } catch (error) {
            invalid(`urlRegex is not a valid regular expression: ${(error as Error).message}`);
          }
        }
        return;
      }
      case 'removeBreakpoint':
        if (!args.breakpointId) invalid('removeBreakpoint requires breakpointId');
        return;
      case 'continueToLocation':
        if (!args.scriptId || !(Number.isInteger(args.line) && args.line! >= 0)) {
          invalid('continueToLocation requires scriptId and a 0-based line');
        }
        return;
      case 'evaluate':
        if (!args.expression) invalid('evaluate requires a non-empty expression');
        return;
      case 'properties':
        if (!args.objectId && args.scopeIndex === undefined) {
          invalid('properties requires objectId, or frameIndex and scopeIndex of a paused frame');
        }
        return;
      case 'blackbox':
        if (!Array.isArray(args.patterns)) invalid('blackbox requires patterns (use [] to clear)');
        for (const pattern of args.patterns) {
          try {
            new RegExp(pattern);
          } catch (error) {
            invalid(
              `pattern ${pattern} is not a valid regular expression: ${(error as Error).message}`,
            );
          }
        }
        return;
      case 'status':
      case 'wait':
      case 'pause':
      case 'resume':
      case 'stepOver':
      case 'stepInto':
      case 'stepOut':
        return;
      default:
        invalid(
          'action must be status, wait, pause, resume, stepOver, stepInto, stepOut, continueToLocation, setBreakpoint, removeBreakpoint, evaluate, properties, or blackbox',
        );
    }
  }

  private run(session: HeldSession, args: CdpDebuggerParams): Promise<Record<string, unknown>> {
    switch (args.action!) {
      case 'status':
        return Promise.resolve(this.status(session, args));
      case 'wait':
        return this.wait(session, args);
      case 'pause':
        return this.pause(session, args);
      case 'resume':
        return this.resume(session, args);
      case 'stepOver':
      case 'stepInto':
      case 'stepOut':
      case 'continueToLocation':
        return this.step(session, args);
      case 'setBreakpoint':
        return this.setBreakpoint(session, args);
      case 'removeBreakpoint':
        return this.removeBreakpoint(session, args);
      case 'evaluate':
        return this.evaluate(session, args);
      case 'properties':
        return this.properties(session, args);
      case 'blackbox':
        return this.blackbox(session, args);
    }
  }
  private send(session: HeldSession, key: string, method: string, params: object = {}) {
    return cdpSessionManager.sendCommand<any>(session.tabId, method, params, key || undefined);
  }

  private sanitize(args: CdpDebuggerParams) {
    return args.sanitizeOutput !== false;
  }

  private location(session: HeldSession, key: string, location: any) {
    if (!location) return undefined;
    const record = findScript(session.scripts, location.scriptId, key || undefined);
    return {
      scriptId: location.scriptId,
      line: location.lineNumber,
      column: location.columnNumber ?? 0,
      ...(record?.url ? { url: record.url } : {}),
    };
  }

  private describePause(session: HeldSession, pause: PauseRecord, args: CdpDebuggerParams) {
    const sanitize = this.sanitize(args);
    const maxFrames = clampInt(args.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_FRAMES);
    let data: unknown;
    if (pause.data !== undefined) {
      const serialized = serializeResult(pause.data, {
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        sanitizeOutput: sanitize,
      });
      data = 'result' in serialized ? serialized.result : serialized.resultText;
    }
    return {
      seq: pause.seq,
      ...(pause.key ? { sessionId: pause.key } : {}),
      at: pause.at,
      reason: pause.reason,
      hitBreakpoints: pause.hitBreakpoints,
      ...(data !== undefined ? { data } : {}),
      totalFrames: pause.callFrames.length,
      frames: pause.callFrames.slice(0, maxFrames).map((frame, index) => ({
        index,
        functionName: frame.functionName || '(anonymous)',
        location: this.location(session, pause.key, frame.location),
        scopes: (frame.scopeChain ?? []).map((scope: any, scopeIndex: number) => ({
          index: scopeIndex,
          type: scope.type,
          ...(scope.name ? { name: scope.name } : {}),
          ...(scope.object?.objectId ? { objectId: scope.object.objectId } : {}),
          ...(scope.emptyReason ? { emptyReason: scope.emptyReason } : {}),
        })),
        ...(frame.this ? { this: remote(frame.this, sanitize) } : {}),
        ...(frame.returnValue ? { returnValue: remote(frame.returnValue, sanitize) } : {}),
      })),
    };
  }

  private pauseResult(
    session: HeldSession,
    result: Awaited<ReturnType<typeof waitForPause>['promise']>,
    args: CdpDebuggerParams,
  ) {
    if ('ended' in result) {
      throw new Error(
        `CDP_SESSION_ENDED: tab ${session.tabId} debugger session ended while waiting`,
      );
    }
    if ('timedOut' in result) {
      return { paused: false, timedOut: true, lastPauseSeq: session.debug.nextSeq - 1 };
    }
    return { paused: true, pause: this.describePause(session, result.pause, args) };
  }

  /** The paused session addressed by sessionId, or the only paused one. */
  private pausedKey(session: HeldSession, sessionId: string | undefined): string {
    const pauses = session.debug.pauses;
    if (sessionId !== undefined) {
      const key = sessionKey(sessionId);
      if (!pauses.has(key)) {
        throw new Error(
          `DEBUGGER_NOT_PAUSED: ${key ? `session ${key}` : 'the page'} is not paused`,
        );
      }
      return key;
    }
    const keys = [...pauses.keys()];
    if (keys.length === 0) {
      throw new Error(`DEBUGGER_NOT_PAUSED: no session of tab ${session.tabId} is paused`);
    }
    if (keys.length > 1) {
      throw new Error(
        `DEBUGGER_AMBIGUOUS: ${keys.length} sessions are paused (${keys.map((key) => key || 'page').join(', ')}); pass sessionId ("" for the page)`,
      );
    }
    return keys[0];
  }

  private frameAt(pause: PauseRecord, frameIndex: number | undefined) {
    const index = frameIndex ?? 0;
    const frame = pause.callFrames[index];
    if (!Number.isInteger(index) || !frame) {
      throw new Error(`FRAME_NOT_FOUND: frame ${index} of ${pause.callFrames.length}`);
    }
    return frame;
  }

  /** Cleanup after a resume; errors are reported, not thrown, because the page already resumed. */
  private async afterResume(session: HeldSession, key: string): Promise<string[]> {
    const errors: string[] = [];
    for (const [label, step] of [
      ['release objects', () => releaseObjects(session, key)],
      ['skip pauses', () => disarmIfIdle(session, key)],
    ] as const) {
      try {
        await step();
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return errors;
  }

  private status(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const pauses = [...debug.pauses.values()].sort((a, b) => a.seq - b.seq);
    const label = (key: string) => key || 'page';
    return {
      paused: pauses.length > 0,
      pauses: pauses.map((pause) => this.describePause(session, pause, args)),
      ...(debug.pending.size ? { pausePending: [...debug.pending].map(label) } : {}),
      breakpoints: [...debug.breakpoints.values()].map(describeBreakpoint),
      armed: [...debug.armed].map(label),
      ...(debug.blackbox.size
        ? {
            blackbox: [...debug.blackbox].map(([key, patterns]) => ({
              ...(key ? { sessionId: key } : {}),
              patterns,
            })),
          }
        : {}),
      lastPauseSeq: debug.nextSeq - 1,
    };
  }

  private async wait(session: HeldSession, args: CdpDebuggerParams) {
    const key = args.sessionId === undefined ? undefined : sessionKey(args.sessionId);
    const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const timeout = clampInt(args.timeoutMs, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
    const { promise } = waitForPause(session.debug, key, after, timeout);
    return this.pauseResult(session, await promise, args);
  }

  private async pause(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const key = sessionKey(args.sessionId);
    const current = debug.pauses.get(key);
    if (current) {
      return {
        paused: true,
        alreadyPaused: true,
        pause: this.describePause(session, current, args),
      };
    }
    const timeout = clampInt(args.timeoutMs, DEFAULT_STEP_WAIT_MS, 0, MAX_WAIT_MS);
    const waiter = waitForPause(debug, key, debug.nextSeq - 1, timeout);
    debug.pending.add(key);
    try {
      await arm(session, key);
      await this.send(session, key, 'Debugger.pause');
    } catch (error) {
      waiter.cancel();
      debug.pending.delete(key);
      throw await withCleanup(error, () => disarmIfIdle(session, key));
    }
    const result = this.pauseResult(session, await waiter.promise, args);
    // Debugger.pause takes effect at the next JavaScript statement; an idle page stays pending.
    return result.paused
      ? result
      : { paused: false, pending: true, lastPauseSeq: result.lastPauseSeq };
  }

  private async resume(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const requested = args.sessionId === undefined ? undefined : sessionKey(args.sessionId);
    // Not paused, but armed by a pause request that has not hit yet or by a step that ran to
    // completion: disarm instead of letting a later `debugger;` freeze the page.
    const idle = (key: string) =>
      !debug.pauses.has(key) &&
      (debug.pending.has(key) ||
        (debug.armed.has(key) &&
          ![...debug.breakpoints.values()].some((record) => record.key === key)));
    const idleKeys =
      requested === undefined
        ? debug.pauses.size === 0
          ? [...new Set([...debug.pending, ...debug.armed])].filter(idle)
          : []
        : idle(requested)
          ? [requested]
          : [];
    if (idleKeys.length) {
      const cancelled = idleKeys.some((key) => debug.pending.has(key));
      const errors: string[] = [];
      for (const key of idleKeys) {
        debug.pending.delete(key);
        errors.push(...(await this.afterResume(session, key)));
      }
      return {
        resumed: false,
        ...(cancelled ? { cancelledPause: true } : {}),
        disarmed: idleKeys.map((key) => key || 'page'),
        ...(errors.length ? { cleanupErrors: errors } : {}),
      };
    }
    const key = this.pausedKey(session, args.sessionId);
    const seq = debug.pauses.get(key)!.seq;
    await this.send(session, key, 'Debugger.resume');
    // A breakpoint may have paused again before the response; keep that newer pause.
    if (debug.pauses.get(key)?.seq === seq) debug.pauses.delete(key);
    const errors = await this.afterResume(session, key);
    return {
      resumed: true,
      ...(key ? { sessionId: key } : {}),
      ...(errors.length ? { cleanupErrors: errors } : {}),
    };
  }

  private async step(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const key = this.pausedKey(session, args.sessionId);
    const seq = debug.pauses.get(key)!.seq;
    const timeout = clampInt(args.timeoutMs, DEFAULT_STEP_WAIT_MS, 0, MAX_WAIT_MS);
    const waiter = waitForPause(debug, key, seq, timeout);
    const params =
      args.action === 'continueToLocation'
        ? {
            location: {
              scriptId: args.scriptId,
              lineNumber: args.line,
              ...(args.column !== undefined ? { columnNumber: args.column } : {}),
            },
          }
        : {};
    try {
      await this.send(
        session,
        key,
        STEP_COMMANDS[args.action as keyof typeof STEP_COMMANDS],
        params,
      );
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    if (debug.pauses.get(key)?.seq === seq) debug.pauses.delete(key);
    const result = this.pauseResult(session, await waiter.promise, args);
    // The session stays armed: a slow step still pauses when it reaches the next statement.
    return result.paused
      ? result
      : { paused: false, running: true, lastPauseSeq: result.lastPauseSeq };
  }

  private async setBreakpoint(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const key = sessionKey(args.sessionId);
    const record = await this.createBreakpoint(session, key, args);
    const mapKey = breakpointKey(key, record.id);
    debug.breakpoints.set(mapKey, record);
    try {
      await arm(session, key);
    } catch (error) {
      debug.breakpoints.delete(mapKey);
      throw await withCleanup(error, () => this.deleteBreakpoint(session, record));
    }
    return { breakpoint: describeBreakpoint(record) };
  }

  private async createBreakpoint(
    session: HeldSession,
    key: string,
    args: CdpDebuggerParams,
  ): Promise<BreakpointRecord> {
    const base = { key, locations: [], hits: 0 };
    if (args.xhrUrl !== undefined) {
      await this.send(session, key, 'DOMDebugger.setXHRBreakpoint', { url: args.xhrUrl });
      return { ...base, id: `xhr:${args.xhrUrl}`, kind: 'xhr', xhrUrl: args.xhrUrl };
    }
    if (args.eventName !== undefined) {
      await this.send(session, key, 'DOMDebugger.setEventListenerBreakpoint', {
        eventName: args.eventName,
        ...(args.targetName ? { targetName: args.targetName } : {}),
      });
      return {
        ...base,
        id: `event:${args.targetName || '*'}:${args.eventName}`,
        kind: 'event',
        eventName: args.eventName,
        ...(args.targetName ? { targetName: args.targetName } : {}),
      };
    }
    const condition = breakpointCondition(args);
    const line = {
      kind: 'line' as const,
      line: args.line,
      ...(args.column !== undefined ? { column: args.column } : {}),
      ...(args.condition ? { condition: args.condition } : {}),
      ...(args.logMessage ? { logMessage: args.logMessage } : {}),
    };
    if (args.scriptId !== undefined) {
      if (!findScript(session.scripts, args.scriptId, key || undefined)) {
        throw new Error(
          `SCRIPT_NOT_FOUND: script ${args.scriptId} is not in the script table of ${key ? `session ${key}` : 'the page'}`,
        );
      }
      const result = await this.send(session, key, 'Debugger.setBreakpoint', {
        location: {
          scriptId: args.scriptId,
          lineNumber: args.line,
          ...(args.column !== undefined ? { columnNumber: args.column } : {}),
        },
        ...(condition ? { condition } : {}),
      });
      return {
        ...base,
        ...line,
        id: result.breakpointId,
        cdpId: result.breakpointId,
        scriptId: args.scriptId,
        locations: result.actualLocation ? [result.actualLocation] : [],
      };
    }
    const result = await this.send(session, key, 'Debugger.setBreakpointByUrl', {
      lineNumber: args.line,
      ...(args.url !== undefined ? { url: args.url } : { urlRegex: args.urlRegex }),
      ...(args.column !== undefined ? { columnNumber: args.column } : {}),
      ...(condition ? { condition } : {}),
    });
    return {
      ...base,
      ...line,
      id: result.breakpointId,
      cdpId: result.breakpointId,
      ...(args.url !== undefined ? { url: args.url } : { urlRegex: args.urlRegex }),
      locations: result.locations ?? [],
    };
  }

  private async deleteBreakpoint(session: HeldSession, record: BreakpointRecord) {
    if (record.kind === 'line') {
      await this.send(session, record.key, 'Debugger.removeBreakpoint', {
        breakpointId: record.cdpId,
      });
    } else if (record.kind === 'xhr') {
      await this.send(session, record.key, 'DOMDebugger.removeXHRBreakpoint', {
        url: record.xhrUrl,
      });
    } else {
      await this.send(session, record.key, 'DOMDebugger.removeEventListenerBreakpoint', {
        eventName: record.eventName,
        ...(record.targetName ? { targetName: record.targetName } : {}),
      });
    }
  }

  private async removeBreakpoint(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const key = sessionKey(args.sessionId);
    const mapKey = breakpointKey(key, args.breakpointId!);
    const record = debug.breakpoints.get(mapKey);
    if (!record) {
      throw new Error(
        `BREAKPOINT_NOT_FOUND: breakpoint ${args.breakpointId} is not set in ${key ? `session ${key}` : 'the page'}`,
      );
    }
    await this.deleteBreakpoint(session, record);
    debug.breakpoints.delete(mapKey);
    await disarmIfIdle(session, key);
    return { removed: record.id, ...(key ? { sessionId: key } : {}) };
  }

  private async evaluate(session: HeldSession, args: CdpDebuggerParams) {
    const key = this.pausedKey(session, args.sessionId);
    const pause = session.debug.pauses.get(key)!;
    const frame = this.frameAt(pause, args.frameIndex);
    const result = await this.send(session, key, 'Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: args.expression,
      objectGroup: OBJECT_GROUP,
      silent: true,
      returnByValue: args.returnByValue === true,
    });
    session.debug.groups.add(key);
    const sanitize = this.sanitize(args);
    const details = result.exceptionDetails;
    return {
      ...(key ? { sessionId: key } : {}),
      pauseSeq: pause.seq,
      frameIndex: args.frameIndex ?? 0,
      result: remote(result.result, sanitize),
      ...(details
        ? {
            exception: clip(
              String(details.exception?.description ?? details.text ?? 'exception'),
              sanitize,
            ),
          }
        : {}),
    };
  }

  private async properties(session: HeldSession, args: CdpDebuggerParams) {
    const debug = session.debug;
    const sanitize = this.sanitize(args);
    let key: string;
    let objectId: string;
    let scope: Record<string, unknown> = {};
    if (args.objectId) {
      key =
        args.sessionId !== undefined
          ? sessionKey(args.sessionId)
          : debug.pauses.size === 1
            ? [...debug.pauses.keys()][0]
            : '';
      objectId = args.objectId;
    } else {
      key = this.pausedKey(session, args.sessionId);
      const pause = debug.pauses.get(key)!;
      const frame = this.frameAt(pause, args.frameIndex);
      const chain = frame.scopeChain ?? [];
      const entry = chain[args.scopeIndex!];
      if (!entry?.object?.objectId) {
        throw new Error(
          `SCOPE_NOT_FOUND: scope ${args.scopeIndex} of ${chain.length} in frame ${args.frameIndex ?? 0}`,
        );
      }
      objectId = entry.object.objectId;
      scope = {
        pauseSeq: pause.seq,
        frameIndex: args.frameIndex ?? 0,
        scopeIndex: args.scopeIndex,
        scopeType: entry.type,
      };
    }
    const budget = {
      left: clampInt(args.maxProperties, DEFAULT_MAX_PROPERTIES, 1, MAX_PROPERTIES),
      truncated: false,
    };
    const depth = clampInt(args.depth, 0, 0, MAX_DEPTH);
    const properties = await this.expand(session, key, objectId, depth, budget, sanitize);
    return {
      ...(key ? { sessionId: key } : {}),
      ...scope,
      objectId,
      properties,
      ...(budget.truncated ? { truncated: true } : {}),
    };
  }

  /** Own, private, and internal properties; depth > 0 expands object values depth-first. */
  private async expand(
    session: HeldSession,
    key: string,
    objectId: string,
    depth: number,
    budget: { left: number; truncated: boolean },
    sanitize: boolean,
  ): Promise<object[]> {
    const result = await this.send(session, key, 'Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: false,
    });
    const entries = [
      ...(result.result ?? []).map((prop: any) => ({ prop })),
      ...(result.privateProperties ?? []).map((prop: any) => ({ prop, kind: 'private' })),
      ...(result.internalProperties ?? []).map((prop: any) => ({ prop, kind: 'internal' })),
    ];
    const out: object[] = [];
    for (const { prop, kind } of entries) {
      if (budget.left <= 0) {
        budget.truncated = true;
        break;
      }
      budget.left -= 1;
      const value = prop.value ? remote(prop.value, sanitize, prop.name) : undefined;
      const entry: Record<string, unknown> = {
        name: prop.name,
        ...(kind ? { kind } : {}),
        ...(value ? { value } : {}),
        ...(prop.get || prop.set ? { accessor: true } : {}),
        ...(prop.wasThrown ? { threw: true } : {}),
      };
      // [[Prototype]] and other internals would drag in built-ins; expand only real members.
      if (
        depth > 0 &&
        kind !== 'internal' &&
        value &&
        'objectId' in value &&
        value.type === 'object'
      ) {
        entry.properties = await this.expand(
          session,
          key,
          value.objectId!,
          depth - 1,
          budget,
          sanitize,
        );
      }
      out.push(entry);
    }
    return out;
  }

  private async blackbox(session: HeldSession, args: CdpDebuggerParams) {
    const key = sessionKey(args.sessionId);
    const patterns = args.patterns!;
    await this.send(session, key, 'Debugger.setBlackboxPatterns', { patterns });
    if (patterns.length) session.debug.blackbox.set(key, patterns);
    else session.debug.blackbox.delete(key);
    return { ...(key ? { sessionId: key } : {}), patterns };
  }

  /** Trims frame/property/breakpoint lists from the end until the payload fits maxBytes. */
  private fit(payload: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
    if (bytesOf(payload) <= maxBytes) return payload;
    const lists: unknown[][] = [];
    const single = payload.pause as { frames?: unknown[] } | undefined;
    if (single?.frames) lists.push(single.frames);
    for (const pause of (payload.pauses as Array<{ frames: unknown[] }> | undefined) ?? []) {
      lists.push(pause.frames);
    }
    for (const name of ['properties', 'breakpoints']) {
      if (Array.isArray(payload[name])) lists.push(payload[name] as unknown[]);
    }
    while (bytesOf(payload) > maxBytes) {
      const longest = lists
        .filter((list) => list.length > 1)
        .sort((a, b) => b.length - a.length)[0];
      if (!longest) break;
      longest.pop();
    }
    if (bytesOf(payload) <= maxBytes) return { ...payload, truncatedByBytes: true };
    const text = serializeResult(payload, { maxOutputBytes: maxBytes, sanitizeOutput: false });
    return {
      truncatedByBytes: true,
      resultText: 'resultText' in text ? text.resultText : JSON.stringify(text.result),
    };
  }
}

function breakpointKey(key: string, id: string) {
  return `${key}\u0000${id}`;
}

/** A logpoint is a condition that logs and returns false, so the page never pauses on it. */
function breakpointCondition(args: CdpDebuggerParams): string | undefined {
  if (!args.logMessage) return args.condition || undefined;
  const log = `(console.log(${args.logMessage}\n), false)`;
  return args.condition ? `(${args.condition}\n) && ${log}` : log;
}

function describeBreakpoint(record: BreakpointRecord) {
  return {
    id: record.id,
    ...(record.key ? { sessionId: record.key } : {}),
    kind: record.kind,
    ...(record.url !== undefined ? { url: record.url } : {}),
    ...(record.urlRegex !== undefined ? { urlRegex: record.urlRegex } : {}),
    ...(record.scriptId !== undefined ? { scriptId: record.scriptId } : {}),
    ...(record.line !== undefined ? { line: record.line } : {}),
    ...(record.column !== undefined ? { column: record.column } : {}),
    ...(record.condition ? { condition: record.condition } : {}),
    ...(record.logMessage ? { logMessage: record.logMessage } : {}),
    ...(record.xhrUrl !== undefined ? { xhrUrl: record.xhrUrl } : {}),
    ...(record.eventName ? { eventName: record.eventName } : {}),
    ...(record.targetName ? { targetName: record.targetName } : {}),
    ...(record.kind === 'line'
      ? {
          resolved: record.locations.length > 0,
          locations: record.locations.map((location) => ({
            scriptId: location.scriptId,
            line: location.lineNumber,
            column: location.columnNumber ?? 0,
          })),
        }
      : {}),
    hits: record.hits,
  };
}

/** Runs a cleanup after a failure and folds its error into the original one. */
async function withCleanup(error: unknown, cleanup: () => Promise<unknown>): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await cleanup();
    return error instanceof Error ? error : new Error(message);
  } catch (cleanupError) {
    return new Error(
      `${message}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
    );
  }
}

export const cdpDebuggerTool = new CdpDebuggerTool();

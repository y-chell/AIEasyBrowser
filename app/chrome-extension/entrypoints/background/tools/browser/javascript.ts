/**
 * JavaScript Tool - CDP execution in a chosen context
 *
 * Execute JavaScript in the browser tab and return the result. Every path goes through CDP:
 * - Top frame, MAIN world: Runtime.evaluate on the page.
 * - frameId (any frame) and/or world ISOLATED: the frame is mapped to its CDP frame and session
 *   (cdp-frames.ts); MAIN runs on that frame's document, ISOLATED in Page.createIsolatedWorld.
 *   Cross-process frames use the task's held chrome_cdp_session child session.
 * - sessionId: a held child session (worker, service worker, OOPIF root).
 * - workerTargetId: a browser-level worker target (shared worker) attached for this call only.
 *
 * There is no chrome.scripting fallback: the extension CSP forbids building a function from a
 * string in the ISOLATED world (KI-08), so that path could never run user code. A busy debugger
 * or an unresolvable context fails explicitly instead of executing somewhere else.
 *
 * Features:
 * - Async code support (top-level await via async wrapper)
 * - Output sanitization (sensitive data redaction)
 * - Output truncation (configurable max bytes)
 * - Timeout handling
 * - Detailed error classification
 */

import { createErrorResponse, createStructuredToolResult, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { resolveChildSession } from '@/utils/cdp-event-hub';
import { browserWorkerTargets, resolveFrame, type ResolvedFrame } from '@/utils/cdp-frames';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  sanitizeAndLimitOutput,
  sanitizeText,
} from '@/utils/output-sanitizer';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_SESSION_KEY = 'javascript';
const DEBUGGER_PROTOCOL_VERSION = '1.3';
// Reused across calls, so globals set in the isolated world persist until the frame navigates.
const ISOLATED_WORLD_NAME = 'aeb-javascript';
const OBJECT_GROUP = 'aeb-javascript';

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = 'cdp';

type World = 'MAIN' | 'ISOLATED';

type ErrorKind =
  | 'debugger_conflict'
  | 'timeout'
  | 'syntax_error'
  | 'runtime_error'
  | 'cdp_error'
  | 'target_error';

interface JavaScriptToolParams {
  code: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  world?: World;
  sessionId?: string;
  workerTargetId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ExecutionError {
  kind: ErrorKind;
  message: string;
  details?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface ExecutionMetrics {
  elapsedMs: number;
}

/** Where the code ran, as reported back to the caller. */
interface ExecutionTarget {
  frameId?: number;
  /** Frames only; a worker or child session runs in its single main context. */
  world?: World;
  cdpFrameId?: string;
  sessionId?: string;
  workerTargetId?: string;
}

interface JavaScriptToolResult extends ExecutionTarget {
  success: boolean;
  tabId: number;
  engine: ExecutionEngine;
  result?: string;
  truncated?: boolean;
  redacted?: boolean;
  error?: ExecutionError;
  metrics?: ExecutionMetrics;
}

interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

// Discriminated union for execution results
type ExecutionSuccess = {
  ok: true;
  engine: ExecutionEngine;
  target: ExecutionTarget;
  output: string;
  truncated: boolean;
  redacted: boolean;
};

type ExecutionFailure = {
  ok: false;
  engine: ExecutionEngine;
  target: ExecutionTarget;
  error: ExecutionError;
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

// ============================================================================
// Timeout Error
// ============================================================================

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i.test(
    message,
  );
}

/**
 * Wrap user code in an async IIFE to support top-level await and return statements.
 */
function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

// ============================================================================
// CDP Execution
// ============================================================================

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CDPExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    className?: string;
    description?: string;
    value?: string;
  };
}

interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: CDPExceptionDetails;
}

function extractReturnValue(remoteObject?: CDPRemoteObject): unknown {
  if (!remoteObject) return undefined;

  if ('value' in remoteObject) return remoteObject.value;
  if ('unserializableValue' in remoteObject) return remoteObject.unserializableValue;
  if (typeof remoteObject.description === 'string') return remoteObject.description;

  return undefined;
}

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? '';
  const exceptionDescription = details.exception?.description ?? '';
  const exceptionValue = details.exception?.value ?? '';
  const text = details.text ?? '';

  // Determine the raw error message
  const rawMessage =
    exceptionDescription || exceptionValue || text || 'JavaScript execution failed';

  // Sanitize the message
  const message = sanitizeText(rawMessage).text;

  // Classify the error kind
  const isSyntaxError = exceptionClassName === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

  return {
    kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

// Prefixes of frame/session/worker resolution failures (cdp-frames.ts, cdp-event-hub.ts).
const TARGET_ERROR = /^(FRAME_[A-Z_]+|CDP_SESSION_[A-Z_]+|CDP_UNKNOWN_SESSION|WORKER_[A-Z_]+):/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one CDP evaluation and classifies its outcome. */
async function execute(
  target: ExecutionTarget,
  options: ExecutionOptions,
  run: () => Promise<CDPEvaluateResult>,
): Promise<ExecutionResult> {
  try {
    // 外层超时稍长，给 CDP 一点余量处理超时响应
    const response = await withTimeout(run(), options.timeoutMs + 1000);

    // Check for exception
    if (response?.exceptionDetails) {
      return {
        ok: false,
        engine: 'cdp',
        target,
        error: parseExceptionDetails(response.exceptionDetails),
      };
    }

    // Extract and sanitize the result
    const value = extractReturnValue(response?.result);
    const sanitized = sanitizeAndLimitOutput(value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'cdp',
      target,
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: 'cdp',
        target,
        error: { kind: 'timeout', message: error.message },
      };
    }

    const message = sanitizeText(errorMessage(error)).text;
    const kind: ErrorKind = isDebuggerConflictError(error)
      ? 'debugger_conflict'
      : TARGET_ERROR.test(errorMessage(error))
        ? 'target_error'
        : 'cdp_error';
    return { ok: false, engine: 'cdp', target, error: { kind, message } };
  }
}

// ============================================================================
// Execution Contexts
// ============================================================================

function evaluateParams(code: string, options: ExecutionOptions) {
  return {
    expression: wrapUserCode(code),
    returnByValue: true,
    awaitPromise: true,
    // CDP 内置超时（毫秒），与外层 withTimeout 双重保障
    timeout: options.timeoutMs,
  };
}

/** Page top frame, MAIN world. */
function executeOnPage(tabId: number, code: string, options: ExecutionOptions) {
  return execute({ frameId: 0, world: 'MAIN' }, options, () =>
    cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, () =>
      cdpSessionManager.sendCommand<CDPEvaluateResult>(
        tabId,
        'Runtime.evaluate',
        evaluateParams(code, options),
      ),
    ),
  );
}

/**
 * Main world of a frame that is not the main frame of its CDP session. Runtime.evaluate needs a
 * context ID, which only Runtime.enable reports; enabling Runtime on a shared attach would change
 * the domain state of a held session. The frame's document node instead resolves to an object in
 * that frame's main world, and callFunctionOn runs the code there.
 */
async function evaluateInSubframe(
  tabId: number,
  frame: ResolvedFrame,
  code: string,
): Promise<CDPEvaluateResult> {
  const { backendNodeId } = await cdpSessionManager.sendCommand<{ backendNodeId: number }>(
    tabId,
    'DOM.getFrameOwner',
    { frameId: frame.cdpFrameId },
    frame.sessionId,
  );
  const { node } = await cdpSessionManager.sendCommand<{
    node?: { contentDocument?: { backendNodeId: number } };
  }>(tabId, 'DOM.describeNode', { backendNodeId, depth: 1 }, frame.sessionId);
  const documentNode = node?.contentDocument?.backendNodeId;
  if (documentNode === undefined) {
    throw new Error(`FRAME_MAPPING_FAILED: frame ${frame.frameId} has no document in its session`);
  }
  const { object } = await cdpSessionManager.sendCommand<{ object: { objectId?: string } }>(
    tabId,
    'DOM.resolveNode',
    { backendNodeId: documentNode, objectGroup: OBJECT_GROUP },
    frame.sessionId,
  );
  try {
    return await cdpSessionManager.sendCommand<CDPEvaluateResult>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        // Same body position as wrapUserCode, so reported line numbers match the top frame.
        functionDeclaration: `function () { return (async function () {\n${code}\n}).call(globalThis); }`,
        returnByValue: true,
        awaitPromise: true,
      },
      frame.sessionId,
    );
  } finally {
    await cdpSessionManager
      .sendCommand(
        tabId,
        'Runtime.releaseObjectGroup',
        { objectGroup: OBJECT_GROUP },
        frame.sessionId,
      )
      .catch(() => undefined);
  }
}

/** Any frame chosen by extension frame ID, in its MAIN or a dedicated ISOLATED world. */
function executeInFrame(
  tabId: number,
  frameId: number,
  world: World,
  owner: string | undefined,
  code: string,
  options: ExecutionOptions,
) {
  const target: ExecutionTarget = { frameId, world };
  return execute(target, options, () =>
    cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
      const frame = await resolveFrame(tabId, frameId, owner);
      target.cdpFrameId = frame.cdpFrameId;
      if (frame.sessionId) target.sessionId = frame.sessionId;
      if (world === 'ISOLATED') {
        const { executionContextId } = await cdpSessionManager.sendCommand<{
          executionContextId: number;
        }>(
          tabId,
          'Page.createIsolatedWorld',
          { frameId: frame.cdpFrameId, worldName: ISOLATED_WORLD_NAME },
          frame.sessionId,
        );
        return cdpSessionManager.sendCommand<CDPEvaluateResult>(
          tabId,
          'Runtime.evaluate',
          { ...evaluateParams(code, options), contextId: executionContextId },
          frame.sessionId,
        );
      }
      if (frame.sessionRoot) {
        // Without contextId, Runtime.evaluate uses the default context of the session's main frame.
        return cdpSessionManager.sendCommand<CDPEvaluateResult>(
          tabId,
          'Runtime.evaluate',
          evaluateParams(code, options),
          frame.sessionId,
        );
      }
      return evaluateInSubframe(tabId, frame, code);
    }),
  );
}

/** Held child session of this task: dedicated/service worker or OOPIF root. */
function executeInSession(
  tabId: number,
  sessionId: string,
  owner: string | undefined,
  code: string,
  options: ExecutionOptions,
) {
  return execute({ sessionId }, options, async () => {
    if (!owner) {
      throw new Error('CDP_SESSION_NOT_STARTED: sessionId requires a named task session');
    }
    resolveChildSession(tabId, owner, sessionId);
    return cdpSessionManager.sendCommand<CDPEvaluateResult>(
      tabId,
      'Runtime.evaluate',
      evaluateParams(code, options),
      sessionId,
    );
  });
}

/**
 * A worker that is not a child of the tab (shared worker). Chrome does not auto-attach shared
 * workers to a page and Target.attachToTarget is not allowed for extensions, so the worker is
 * attached as its own debuggee for this call.
 */
function executeInWorkerTarget(
  tabId: number,
  workerTargetId: string,
  code: string,
  options: ExecutionOptions,
) {
  return execute({ workerTargetId }, options, async () => {
    const workers = await browserWorkerTargets(tabId);
    if (!workers.some((worker) => worker.id === workerTargetId)) {
      throw new Error(
        `WORKER_NOT_FOUND: ${workerTargetId} is not a worker target of an origin loaded in tab ${tabId}`,
      );
    }
    const debuggee = { targetId: workerTargetId };
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    try {
      return (await chrome.debugger.sendCommand(
        debuggee,
        'Runtime.evaluate',
        evaluateParams(code, options),
      )) as CDPEvaluateResult;
    } finally {
      // Same best-effort rule as cdpSessionManager.detach: the worker may already be gone.
      await chrome.debugger.detach(debuggee).catch(() => undefined);
    }
  });
}

// ============================================================================
// Tool Implementation
// ============================================================================

class JavaScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.JAVASCRIPT;

  async execute(
    args: JavaScriptToolParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      // Validate required parameter
      const code = typeof args?.code === 'string' ? args.code.trim() : '';
      if (!code) {
        return createErrorResponse('Parameter [code] is required');
      }
      const invalid = validateTarget(args);
      if (invalid) return createErrorResponse(`INVALID_ARGUMENT: ${invalid}`);

      // Resolve target tab
      const tab = await this.resolveTargetTab(args.tabId, args.windowId);
      if (!tab) {
        return createErrorResponse(
          typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
        );
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }
      const tabId = tab.id;

      // Normalize options
      const options: ExecutionOptions = {
        timeoutMs: normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: normalizePositiveInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      };
      const world: World = args.world ?? 'MAIN';
      const owner = executionContext?.owner;

      let result: ExecutionResult;
      if (typeof args.sessionId === 'string') {
        result = await executeInSession(tabId, args.sessionId, owner, code, options);
      } else if (typeof args.workerTargetId === 'string') {
        result = await executeInWorkerTarget(tabId, args.workerTargetId, code, options);
      } else if ((args.frameId ?? 0) === 0 && world === 'MAIN') {
        result = await executeOnPage(tabId, code, options);
      } else {
        result = await executeInFrame(tabId, args.frameId ?? 0, world, owner, code, options);
      }

      return result.ok
        ? this.buildSuccessResponse(tabId, result, startTime)
        : this.buildErrorResponse(tabId, result, startTime);
    } catch (error) {
      console.error('JavaScriptTool.execute error:', error);
      return createErrorResponse(
        `JavaScript tool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTargetTab(
    tabId?: number,
    windowId?: number,
  ): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    if (typeof windowId === 'number') {
      return this.getActiveTabInWindow(windowId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  private buildSuccessResponse(
    tabId: number,
    result: ExecutionSuccess,
    startTime: number,
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: true,
      tabId,
      ...result.target,
      engine: result.engine,
      result: result.output,
      truncated: result.truncated || undefined,
      redacted: result.redacted || undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return createStructuredToolResult(payload);
  }

  private buildErrorResponse(
    tabId: number,
    result: ExecutionFailure,
    startTime: number,
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: false,
      tabId,
      ...result.target,
      engine: result.engine,
      error: result.error,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

/** One execution context per call; workers have no isolated worlds. */
function validateTarget(args: JavaScriptToolParams): string | undefined {
  const chosen = [
    args.frameId !== undefined && 'frameId',
    args.sessionId !== undefined && 'sessionId',
    args.workerTargetId !== undefined && 'workerTargetId',
  ].filter(Boolean);
  if (chosen.length > 1) return `use only one of ${chosen.join(', ')}`;
  if (args.frameId !== undefined && !(Number.isInteger(args.frameId) && args.frameId >= 0)) {
    return 'frameId must be a non-negative integer frame ID from scan or chrome_list_frames';
  }
  if (args.world !== undefined && args.world !== 'MAIN' && args.world !== 'ISOLATED') {
    return 'world must be MAIN or ISOLATED';
  }
  if (args.world === 'ISOLATED' && chosen.length === 1 && chosen[0] !== 'frameId') {
    return 'world ISOLATED needs a frame; a child session or worker has only its main context';
  }
  for (const key of ['sessionId', 'workerTargetId'] as const) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key])) {
      return `${key} must be a non-empty string`;
    }
  }
  return undefined;
}

export const javascriptTool = new JavaScriptTool();

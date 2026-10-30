import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { getOwnedSession, type HeldSession } from '@/utils/cdp-event-hub';
import {
  attributeThread,
  buildCpuProfile,
  heapDiff,
  heapUsage,
  MAX_HEAP_SAMPLES,
  startCpu,
  startCss,
  stopCpu,
  stopCss,
  summarizeProfile,
  takeCss,
  takeHeapSample,
  usedChars,
  type SheetRecord,
} from '@/utils/cdp-profile';
import { DEFAULT_MAX_OUTPUT_BYTES, redactInlineSecrets } from '@/utils/output-sanitizer';
import { clampInt } from './cdp';
import { saveDownload } from './cdp-network';

/**
 * chrome_cdp_profile: CSS coverage, CPU profile, and heap instance counts of a held session.
 *
 * A separate tool rather than more performance_* actions: performance_start_trace/stop_trace work
 * on the active tab without a held session and keep their own one-shot attach and listener, while
 * profiling needs the B1 session (child sessions, scriptIds that match chrome_cdp_scripts, the
 * pause state, cleanup on session stop). Both use Tracing, which Chrome runs once per browser, so
 * they share one lock (cdp-tracing-lock) and fail with TRACE_BUSY instead of corrupting each other;
 * there is no second recorder state. Files go to Downloads through the same saveDownload as HAR.
 * Platform facts (no Profiler/HeapProfiler for extensions) are in utils/cdp-profile.ts.
 */

type Action =
  | 'status'
  | 'cssStart'
  | 'cssReport'
  | 'cssStop'
  | 'cpuStart'
  | 'cpuStop'
  | 'heapUsage'
  | 'heapSample'
  | 'heapDiff';

interface CdpProfileParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  url?: string;
  constructors?: string[];
  from?: number;
  to?: number;
  top?: number;
  offset?: number;
  limit?: number;
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const COMMON = ['action', 'tabId', 'windowId', 'maxOutputBytes', 'sanitizeOutput'];
// Each action takes exactly these parameters; anything else is a mistake worth reporting.
const PARAMS: Record<Action, string[]> = {
  status: [],
  cssStart: [],
  cssReport: ['url', 'sessionId', 'offset', 'limit'],
  cssStop: ['url', 'sessionId', 'offset', 'limit'],
  cpuStart: [],
  cpuStop: ['top'],
  heapUsage: [],
  heapSample: ['constructors', 'sessionId'],
  heapDiff: ['from', 'to'],
};
const ACTIONS = Object.keys(PARAMS) as Action[];
// A global path such as "Map" or "app.models.User"; it is interpolated, so nothing else passes.
const CONSTRUCTOR_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,7}$/;
const MAX_CONSTRUCTORS = 20;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function bytesOf(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function sheetView(sheet: SheetRecord, sanitize: boolean) {
  const used = Math.min(usedChars(sheet.used), sheet.length);
  return {
    styleSheetId: sheet.styleSheetId,
    ...(sheet.key ? { sessionId: sheet.key } : {}),
    url: sanitize ? redactInlineSecrets(sheet.url).text : sheet.url,
    origin: sheet.origin,
    ...(sheet.isInline
      ? { inline: true, startLine: sheet.startLine, startColumn: sheet.startColumn }
      : {}),
    ...(sheet.isConstructed ? { constructed: true } : {}),
    ...(sheet.removed ? { removed: true } : {}),
    totalChars: sheet.length,
    usedChars: used,
    unusedChars: sheet.length - used,
    usedPercent: sheet.length ? Math.round((used / sheet.length) * 1000) / 10 : 0,
    usedRanges: sheet.used.length,
  };
}

function profileLabel(kind: string, pid: number, tid: number | undefined) {
  return kind === 'unknown' ? `thread${pid}-${tid ?? 0}` : kind;
}

class CdpProfileTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_PROFILE;

  // Works on the held session alone; CSS and Tracing must still answer while the page is paused.
  skipsTargetLock() {
    return true;
  }

  async execute(
    args: CdpProfileParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_profile requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      // Validate before any CDP IO so a bad call changes nothing.
      const run = this.prepare(args, tab.id);
      const session = getOwnedSession(tab.id, owner);
      const payload = await run(session);
      const errors = session.profile.errors.splice(0);
      return createStructuredToolResult({
        success: true,
        tool: this.name,
        tabId: tab.id,
        action: args.action,
        ...payload,
        ...(errors.length ? { profileErrors: errors } : {}),
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP profile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private requireActive(session: HeldSession) {
    if (session.ended) {
      throw new Error(
        `CDP_SESSION_ENDED: tab ${session.tabId} debugger session ended (${session.ended.reason})`,
      );
    }
  }

  /** '', 'root' or omitted = the page; anything else must be an attached child session. */
  private sessionKey(session: HeldSession, sessionId: string | undefined): string {
    if (!sessionId || sessionId === 'root') return '';
    if (!session.targets.has(sessionId)) {
      throw new Error(
        `CDP_UNKNOWN_SESSION: sessionId ${sessionId} is not an attached child target of tab ${session.tabId}`,
      );
    }
    return sessionId;
  }

  /** Evaluating in a paused session would hang until resume. */
  private requireRunning(session: HeldSession, key: string) {
    if (session.debug.pauses.has(key)) {
      throw new Error(
        `PROFILE_PAGE_PAUSED: the ${key ? `session ${key}` : 'page'} is paused in the debugger; resume it first`,
      );
    }
  }

  private prepare(
    args: CdpProfileParams,
    tabId: number,
  ): (session: HeldSession) => Promise<object> {
    const action = args.action;
    if (!action || !ACTIONS.includes(action)) invalid(`action must be ${ACTIONS.join(', ')}`);
    const allowed = PARAMS[action];
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && !COMMON.includes(key) && !allowed.includes(key)) {
        invalid(
          `${key} does not apply to ${action}; it takes ${allowed.join(', ') || 'no parameters'}`,
        );
      }
    }
    const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
    const sanitize = args.sanitizeOutput !== false;

    switch (action) {
      case 'status':
        return async (session) => this.status(session);
      case 'cssStart':
        return async (session) => {
          this.requireActive(session);
          const { keys, errors } = await startCss(session);
          return {
            tracking: true,
            sessions: keys.map((key) => key || 'root'),
            ...(errors.length ? { childErrors: errors } : {}),
          };
        };
      case 'cssReport':
      case 'cssStop':
        return async (session) => {
          const css = session.profile.css;
          if (!css.active && css.startedAt === undefined) {
            throw new Error(
              'CSS_COVERAGE_NOT_STARTED: no CSS coverage was started; cssStart first',
            );
          }
          if (action === 'cssStop' && !css.active) {
            throw new Error(
              'CSS_COVERAGE_NOT_STARTED: CSS coverage is not running; cssReport reads the last result',
            );
          }
          let errors: string[] = [];
          if (css.active && !session.ended) {
            errors = action === 'cssStop' ? await stopCss(session) : await takeCss(session);
          }
          return {
            ...this.cssReport(session, args, maxBytes, sanitize),
            ...(errors.length ? { cssErrors: errors } : {}),
          };
        };
      case 'cpuStart':
        return async (session) => {
          this.requireActive(session);
          await startCpu(session);
          return { recording: true };
        };
      case 'cpuStop': {
        const top = clampInt(args.top, 20, 1, 200);
        return async (session) => this.cpuStop(session, tabId, top, sanitize);
      }
      case 'heapUsage':
        return async (session) => {
          this.requireActive(session);
          return this.heapUsage(session);
        };
      case 'heapSample': {
        const constructors = args.constructors;
        if (
          !Array.isArray(constructors) ||
          !constructors.length ||
          constructors.length > MAX_CONSTRUCTORS
        ) {
          invalid(`constructors must list 1-${MAX_CONSTRUCTORS} global constructor paths`);
        }
        for (const path of constructors) {
          if (typeof path !== 'string' || !CONSTRUCTOR_PATH.test(path)) {
            invalid(
              `constructor ${JSON.stringify(path)} must be a global path such as "Map" or "app.User"`,
            );
          }
        }
        const unique = [...new Set(constructors)];
        return async (session) => {
          this.requireActive(session);
          const key = this.sessionKey(session, args.sessionId);
          this.requireRunning(session, key);
          const sample = await takeHeapSample(session, key, unique);
          return {
            sample: sample.id,
            ...(key ? { sessionId: key } : {}),
            usage: sample.usage,
            counts: sample.counts,
            kept: session.profile.heap.map((item) => item.id),
          };
        };
      }
      case 'heapDiff': {
        for (const name of ['from', 'to'] as const) {
          if (!Number.isInteger(args[name]) || args[name]! < 1) {
            invalid(`heapDiff requires ${name}, a sample id from heapSample`);
          }
        }
        return async (session) => ({ diff: heapDiff(session, args.from!, args.to!) });
      }
    }
  }

  private status(session: HeldSession) {
    const { css, cpu, heap } = session.profile;
    return {
      active: !session.ended,
      css: {
        tracking: css.active,
        ...(css.startedAt !== undefined ? { startedAt: css.startedAt } : {}),
        ...(css.stoppedAt !== undefined ? { stoppedAt: css.stoppedAt } : {}),
        sessions: css.keys.map((key) => key || 'root'),
        sheets: css.sheets.size,
      },
      cpu: cpu
        ? { recording: true, startedAt: cpu.startedAt, samples: cpu.samples }
        : { recording: false },
      heapSamples: heap.map((sample) => ({
        sample: sample.id,
        ...(sample.key ? { sessionId: sample.key } : {}),
        at: sample.at,
        constructors: Object.keys(sample.counts),
      })),
      maxHeapSamples: MAX_HEAP_SAMPLES,
    };
  }

  /** Sheets with the most unused text first, paged and cut to the byte budget. */
  private cssReport(
    session: HeldSession,
    args: CdpProfileParams,
    maxBytes: number,
    sanitize: boolean,
  ) {
    const css = session.profile.css;
    const url = args.url?.toLowerCase();
    // Sheets of a detached iframe stay in the report, so the id is not checked against targets.
    const key = args.sessionId === 'root' ? '' : args.sessionId;
    const all = [...css.sheets.values()]
      .filter(
        (sheet) =>
          (!url || sheet.url.toLowerCase().includes(url)) &&
          (key === undefined || sheet.key === key),
      )
      .map((sheet) => sheetView(sheet, sanitize))
      .sort((a, b) => b.unusedChars - a.unusedChars || a.url.localeCompare(b.url));
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, 50, 1, 500);
    const sheets: typeof all = [];
    let used = 0;
    let truncated = false;
    for (const sheet of all.slice(offset, offset + limit)) {
      const size = bytesOf(sheet);
      if (sheets.length && used + size > maxBytes - 1000) {
        truncated = true;
        break;
      }
      sheets.push(sheet);
      used += size;
    }
    const totals = all.reduce(
      (sum, sheet) => ({
        totalChars: sum.totalChars + sheet.totalChars,
        usedChars: sum.usedChars + sheet.usedChars,
      }),
      { totalChars: 0, usedChars: 0 },
    );
    const nextOffset = offset + sheets.length;
    return {
      tracking: css.active,
      unit: 'UTF-16 code units of the style sheet text; unused includes whitespace and comments',
      totals: {
        sheets: all.length,
        ...totals,
        unusedChars: totals.totalChars - totals.usedChars,
        usedPercent: totals.totalChars
          ? Math.round((totals.usedChars / totals.totalChars) * 1000) / 10
          : 0,
      },
      offset,
      sheets,
      ...(nextOffset < all.length ? { nextOffset, hasMore: true } : { hasMore: false }),
      ...(truncated ? { pageTruncatedByBytes: true } : {}),
      ...(css.unknownRules ? { unknownSheetRules: css.unknownRules } : {}),
      sanitizeOutput: sanitize,
    };
  }

  private async cpuStop(session: HeldSession, tabId: number, top: number, sanitize: boolean) {
    const cpu = await stopCpu(session);
    const text = (value: string) => (sanitize ? redactInlineSecrets(value).text : value);
    const stamp = new Date(cpu.startedAt).toISOString().replace(/[:.]/g, '-');
    const profiles: object[] = [];
    let empty = 0;
    const threads = [...cpu.profiles.values()].sort(
      (a, b) => a.pid - b.pid || (a.tid ?? 0) - (b.tid ?? 0),
    );
    for (const thread of threads) {
      if (!thread.samples.length) {
        empty += 1;
        continue;
      }
      const { attribution, otherFrames } = attributeThread(session, cpu, thread);
      const profile = buildCpuProfile(thread, text);
      const label = profileLabel(attribution.kind, thread.pid, thread.tid);
      const saved = await saveDownload(
        JSON.stringify(profile),
        `cpu_tab${tabId}_${stamp}_${label}.cpuprofile`,
        'PROFILE_WRITE_FAILED',
      );
      const summary = summarizeProfile(profile, top);
      profiles.push({
        target: attribution.kind,
        ...(attribution.sessionId ? { sessionId: attribution.sessionId } : {}),
        ...('targetId' in attribution ? { targetId: attribution.targetId } : {}),
        ...('url' in attribution && attribution.url ? { url: text(attribution.url) } : {}),
        pid: thread.pid,
        tid: thread.tid,
        thread: cpu.threadNames.get(`${thread.pid}:${thread.tid}`) ?? '',
        ...(otherFrames ? { otherFrames } : {}),
        path: saved.path,
        bytes: saved.bytes,
        ...summary,
      });
    }
    return {
      recording: false,
      durationMs: Date.now() - cpu.startedAt,
      // Chrome's fixed interval under Tracing (measured ~0.53 ms); there is no way to set it.
      samplingIntervalMs: 0.5,
      profiles,
      ...(empty ? { threadsWithoutSamples: empty } : {}),
      ...(cpu.truncated ? { truncated: `sampling stopped at ${cpu.samples} samples` } : {}),
      sanitizeOutput: sanitize,
    };
  }

  /** Page heap and every attached child; a child that fails is reported, not dropped. */
  private async heapUsage(session: HeldSession) {
    const sessions: object[] = [];
    const errors: string[] = [];
    const children = [...session.targets.values()];
    sessions.push({ sessionId: 'root', type: 'page', ...(await heapUsage(session, '')) });
    for (const target of children) {
      try {
        sessions.push({
          sessionId: target.sessionId,
          type: target.type,
          ...(await heapUsage(session, target.sessionId)),
        });
      } catch (error) {
        errors.push(`${target.sessionId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { unit: 'bytes', sessions, ...(errors.length ? { childErrors: errors } : {}) };
  }
}

export const cdpProfileTool = new CdpProfileTool();

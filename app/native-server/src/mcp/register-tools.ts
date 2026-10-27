import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance, {
  type ExtensionRequestOptions,
  type NativeToolProgress,
} from '../native-messaging-host';
import { BRIDGE_VERSION } from '../constant';
import { dispatchBrowserTool } from '../browser/tool-dispatch';
import type { McpServerContext } from './mcp-server';
import { getExposedToolSchemas, handleProfileMetaTool, resolveToolProfile } from './tool-profile';

const HEALTH_TOOL_NAME = 'chrome_health';

type ToolCallContext = McpServerContext & {
  requestId?: string;
};

type ToolCallExecution = ExtensionRequestOptions & {
  reportProgress?: (progress: NativeToolProgress) => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildToolCallContext(
  baseContext: McpServerContext,
  extra: { sessionId?: string; requestId?: string | number },
): ToolCallContext {
  return {
    transport: baseContext.transport,
    sessionId: extra.sessionId || baseContext.sessionId,
    requestId:
      typeof extra.requestId === 'string' || typeof extra.requestId === 'number'
        ? String(extra.requestId)
        : undefined,
  };
}

function normalizeProgress(progress: NativeToolProgress): NativeToolProgress {
  const total = Number.isFinite(progress.total) && progress.total! > 0 ? progress.total! : 100;
  const value = Number.isFinite(progress.progress) ? progress.progress : 0;
  return {
    progress: Math.max(0, Math.min(100, (value / total) * 100)),
    total: 100,
    message: progress.message,
  };
}

function createProgressReporter(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: any) => Promise<void>;
}): ToolCallExecution['reportProgress'] {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || !extra.sendNotification) return undefined;

  let lastProgress = 0;
  let notificationQueue = Promise.resolve();
  return (progress) => {
    const normalized = normalizeProgress(progress);
    normalized.progress = Math.max(lastProgress, normalized.progress);
    lastProgress = normalized.progress;

    notificationQueue = notificationQueue
      .then(() =>
        extra.sendNotification!({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: normalized.progress,
            total: 100,
            ...(normalized.message ? { message: normalized.message } : {}),
          },
        }),
      )
      .catch(() => undefined);
    return notificationQueue;
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  throw error;
}

function appendNativeHealthMetadata(result: CallToolResult, context: ToolCallContext) {
  if (result.isError) return result;

  const basePayload = isPlainObject(result.structuredContent) ? result.structuredContent : null;
  const first = result.content?.[0];
  const firstText =
    first && first.type === 'text' && typeof first.text === 'string' ? first : undefined;
  if (!basePayload && !firstText) {
    return result;
  }

  try {
    const parsed = basePayload ?? (firstText ? JSON.parse(firstText.text) : null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;

    const enriched = {
      ...parsed,
      bridge: {
        name: 'aieasybrowser-bridge',
        version: BRIDGE_VERSION,
        transport: context.transport,
        sessionId: context.sessionId,
        requestId: context.requestId,
      },
    };

    return {
      ...result,
      structuredContent: enriched,
      content: [
        {
          ...(firstText ?? { type: 'text' as const }),
          text: JSON.stringify(enriched),
        },
        ...(result.content || []).slice(1),
      ],
    };
  } catch {
    return result;
  }
}

// Older extensions and dynamic flows may still return JSON only through text content.
// New stable browser tools populate structuredContent in the extension itself.
function appendLegacyStructuredContent(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  if (result.structuredContent !== undefined) return result;
  const first = result.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;

  try {
    const parsed = JSON.parse(first.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    return { ...result, structuredContent: parsed };
  } catch {
    return result;
  }
}

export const setupTools = (server: Server, context: McpServerContext = {}) => {
  server.registerCapabilities({ tools: { listChanged: true } });
  const toolProfile = context.toolProfile ?? resolveToolProfile().profile;
  const exposedToolSchemas = getExposedToolSchemas(toolProfile);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: exposedToolSchemas };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reportProgress = createProgressReporter(extra);
    const execution: ToolCallExecution = {
      signal: extra.signal,
      reportProgress,
      onProgress: reportProgress,
    };

    // Don't block dispatch on the client acknowledging a progress notification.
    void reportProgress?.({ progress: 0, total: 100, message: 'Dispatching browser tool' });
    const callContext = buildToolCallContext(context, extra);
    const invokeBrowserTool = (toolName: string, toolArgs: Record<string, unknown>) =>
      handleToolCall(toolName, toolArgs, callContext, execution);
    const name = request.params.name;
    const args = request.params.arguments || {};
    // Hidden tools stay callable by name; meta tools let the model discover them on demand.
    const result =
      (await handleProfileMetaTool(name, args, toolProfile, invokeBrowserTool)) ??
      (await invokeBrowserTool(name, args));
    if (!result.isError) {
      await reportProgress?.({ progress: 100, total: 100, message: 'Browser tool completed' });
    }
    return result;
  });
};

const handleToolCall = async (
  name: string,
  args: any,
  context: ToolCallContext,
  execution: ToolCallExecution,
): Promise<CallToolResult> => {
  try {
    throwIfAborted(execution.signal);
    let result = await dispatchBrowserTool(
      nativeMessagingHostInstance,
      name,
      args,
      context,
      execution,
    );
    if (name === HEALTH_TOOL_NAME) {
      result = appendNativeHealthMetadata(result, context);
    }
    return appendLegacyStructuredContent(result);
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

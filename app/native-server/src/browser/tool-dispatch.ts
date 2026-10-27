import { NativeMessageType, TOOL_SCHEMAS, type BrowserToolResult } from 'aieasybrowser-shared';
import type { NativeMessagingHost, ExtensionRequestOptions } from '../native-messaging-host';
import { getToolCallTimeoutMs } from './tool-timeouts';

export interface BrowserDispatchContext {
  transport?: string;
  sessionId?: string;
  requestId?: string;
  documentId?: string;
}

export class ToolInputError extends Error {}

export function validateBrowserToolArguments(name: string, args: unknown) {
  const tool = TOOL_SCHEMAS.find((item) => item.name === name);
  if (!tool) throw new ToolInputError(`Unknown browser tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolInputError(`Arguments for ${name} must be an object`);
  }
  if (tool.inputSchema.additionalProperties === false) {
    const properties = tool.inputSchema.properties ?? {};
    const unexpected = Object.keys(args).filter(
      (key) => !Object.prototype.hasOwnProperty.call(properties, key),
    );
    if (unexpected.length > 0) {
      throw new ToolInputError(`Unknown parameter(s) for ${name}: ${unexpected.join(', ')}`);
    }
  }
  return tool;
}

export async function dispatchBrowserTool(
  host: NativeMessagingHost,
  name: string,
  args: Record<string, unknown>,
  context: BrowserDispatchContext,
  execution: ExtensionRequestOptions = {},
): Promise<BrowserToolResult> {
  execution.signal?.throwIfAborted();
  validateBrowserToolArguments(name, args);
  const response = await host.sendRequestToExtensionAndWait(
    { name, args, context },
    NativeMessageType.CALL_TOOL,
    getToolCallTimeoutMs(name, args),
    execution,
  );
  execution.signal?.throwIfAborted();
  if (response.status !== 'success') {
    throw new Error(response.error || 'Browser tool dispatch failed');
  }
  return response.data;
}

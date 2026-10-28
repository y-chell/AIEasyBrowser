import { NativeMessageType, TOOL_SCHEMAS, type BrowserToolResult } from 'aieasybrowser-shared';
import Ajv from 'ajv';
import type { NativeMessagingHost, ExtensionRequestOptions } from '../native-messaging-host';
import { getToolCallTimeoutMs } from './tool-timeouts';

export interface BrowserDispatchContext {
  transport?: string;
  sessionId?: string;
  requestId?: string;
  documentId?: string;
}

export class ToolInputError extends Error {}

const ajv = new Ajv({
  strict: true,
  allowUnionTypes: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

// Compile trusted contracts once. Invalid/unsupported schemas fail at startup, not
// by silently skipping a constraint while processing a browser command.
const contracts = new Map(
  TOOL_SCHEMAS.map((tool) => [tool.name, { tool, validate: ajv.compile(tool.inputSchema) }]),
);

export function getBrowserToolDefinition(name: string) {
  const contract = contracts.get(name);
  if (!contract) throw new ToolInputError(`Unknown browser tool: ${name}`);
  return contract.tool;
}

export function validateBrowserToolArguments(name: string, args: unknown) {
  const tool = getBrowserToolDefinition(name);
  const validate = contracts.get(name)!.validate;
  if (!validate(args)) {
    const issue = validate.errors![0];
    let pointer = issue.instancePath;
    const property = issue.params.missingProperty ?? issue.params.additionalProperty;
    if (typeof property === 'string') {
      pointer += '/' + property.replace(/~/g, '~0').replace(/\//g, '~1');
    }
    throw new ToolInputError(`Invalid arguments for ${name} at args${pointer}: ${issue.message}`);
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

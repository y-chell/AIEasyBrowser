import type { BrowserToolResult } from 'aieasybrowser-shared';

export interface ToolResult extends BrowserToolResult {
  isError: boolean;
}

export interface ToolExecutor {
  execute(args: any): Promise<ToolResult>;
}

export const createErrorResponse = (
  message: string = 'Unknown error, please try again',
): ToolResult => {
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
};

export function createStructuredToolResult(
  payload: object,
  text = JSON.stringify(payload),
): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  CALL_TOOL_CANCEL = 'call_tool_cancel',
  CALL_TOOL_PROGRESS = 'call_tool_progress',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  requestId?: string;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

export interface NativeToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface BrowserTextContent {
  type: 'text';
  text: string;
}

export interface BrowserImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface BrowserToolResult {
  content: (BrowserTextContent | BrowserImageContent)[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface BrowserToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
}

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NativeMessageType } from 'aieasybrowser-shared';
import nativeMessagingHostInstance from '../native-messaging-host';
import { setupTools } from './register-tools';

jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: { sendRequestToExtensionAndWait: jest.fn() },
}));

type RequestHandler = (request?: any, extra?: any) => Promise<any>;
const sendRequest = nativeMessagingHostInstance.sendRequestToExtensionAndWait as jest.Mock;

function createServerHarness(toolProfile: 'full' | 'core' | 'search' = 'full') {
  const handlers: RequestHandler[] = [];
  const server = {
    registerCapabilities: jest.fn(),
    setRequestHandler: jest.fn((_schema: unknown, handler: RequestHandler) =>
      handlers.push(handler),
    ),
  };
  setupTools(server as any, { toolProfile });
  return { server, listTools: handlers[0], callTool: handlers[1] };
}

beforeEach(() => sendRequest.mockReset());

describe('browser tool dispatch', () => {
  test('publishes the static browser catalog without workflow refreshes', async () => {
    const { listTools } = createServerHarness();
    const result = await listTools();
    const names = result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('chrome_health');
    expect(names).toContain('chrome_click_element');
    expect(names.some((name: string) => name.startsWith('flow.'))).toBe(false);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('forwards a browser call and preserves structured results', async () => {
    sendRequest.mockResolvedValueOnce({
      status: 'success',
      data: {
        content: [{ type: 'text', text: '{"success":true,"title":"Example"}' }],
      },
    });
    const { callTool } = createServerHarness();

    const result = await callTool({ params: { name: 'chrome_read_page', arguments: {} } }, {});

    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'chrome_read_page', args: {} }),
      NativeMessageType.CALL_TOOL,
      expect.any(Number),
      expect.any(Object),
    );
    expect(result.structuredContent).toEqual({ success: true, title: 'Example' });
  });

  test('passes MCP cancellation through to the extension request', async () => {
    sendRequest.mockResolvedValueOnce({
      status: 'success',
      data: { content: [{ type: 'text', text: 'done' }] },
    });
    const { callTool } = createServerHarness();
    const controller = new AbortController();

    await callTool(
      { params: { name: 'chrome_wait_for', arguments: {} } },
      { signal: controller.signal },
    );

    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Object),
      NativeMessageType.CALL_TOOL,
      expect.any(Number),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  test.each(['start', 'stop'])(
    'rejects undeclared network %s parameters before browser dispatch',
    async (action) => {
      const { callTool } = createServerHarness();
      const failed = await callTool(
        {
          params: { name: 'chrome_network_capture', arguments: { action, tabId: 7 } },
        },
        {},
      );
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain(
        'Unknown parameter(s) for chrome_network_capture: tabId',
      );
      expect(sendRequest).not.toHaveBeenCalled();
    },
  );

  test('allows the documented network arguments without changing them', async () => {
    sendRequest.mockResolvedValueOnce({ status: 'success', data: { content: [] } });
    const { callTool } = createServerHarness();
    const args = {
      action: 'start',
      url: 'https://fixture.test/*',
      includeStatic: false,
      inactivityTimeout: 0,
    };
    const result = await callTool(
      { params: { name: 'chrome_network_capture', arguments: args } },
      {},
    );
    expect(result.isError).not.toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'chrome_network_capture', args }),
      NativeMessageType.CALL_TOOL,
      expect.any(Number),
      expect.any(Object),
    );
  });

  test('also rejects undeclared arguments when invoked through the search profile', async () => {
    const { callTool } = createServerHarness('search');
    const failed = await callTool(
      {
        params: {
          name: 'chrome_call_tool',
          arguments: {
            name: 'chrome_network_capture',
            args: { action: 'start', tabId: 7 },
          },
        },
      },
      {},
    );
    expect(failed.isError).toBe(true);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('rejects an unknown browser tool before extension IO', async () => {
    const { callTool } = createServerHarness();
    const failed = await callTool(
      { params: { name: 'chrome_nonexistent_tool', arguments: {} } },
      {},
    );
    expect(failed.content[0].text).toContain('Unknown browser tool: chrome_nonexistent_tool');
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

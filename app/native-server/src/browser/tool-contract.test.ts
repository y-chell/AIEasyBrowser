import { describe, expect, jest, test } from '@jest/globals';
import { NativeMessageType, TOOL_SCHEMAS } from 'aieasybrowser-shared';
import type { NativeMessagingHost } from '../native-messaging-host';
import { dispatchBrowserTool, validateBrowserToolArguments } from './tool-dispatch';

const EXPECTED_TOOLS = [
  'chrome_health',
  'get_windows_and_tabs',
  'chrome_list_frames',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'chrome_scan_compact',
  'chrome_read_page',
  'chrome_query_elements',
  'chrome_get_element_html',
  'chrome_computer',
  'chrome_clipboard',
  'chrome_wait_for_tab',
  'chrome_wait_for',
  'chrome_assert',
  'chrome_navigate',
  'chrome_screenshot',
  'chrome_close_tabs',
  'chrome_switch_tab',
  'chrome_tab_group',
  'chrome_get_web_content',
  'chrome_network_request',
  'chrome_network_capture',
  'chrome_handle_download',
  'chrome_history',
  'chrome_bookmark_search',
  'chrome_bookmark_add',
  'chrome_bookmark_delete',
  'chrome_javascript',
  'chrome_cdp_command',
  'chrome_cdp_batch',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_console',
  'chrome_collect_debug_evidence',
  'chrome_upload_file',
  'chrome_get_upload_status',
  'chrome_handle_dialog',
];

function expectDeclaredObjectsClosed(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(expectDeclaredObjectsClosed);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' && Object.prototype.hasOwnProperty.call(schema, 'properties')) {
    expect(schema.additionalProperties).toBe(false);
  }
  Object.values(schema).forEach(expectDeclaredObjectsClosed);
}

describe('direct browser capability contracts', () => {
  test('keeps all 39 browser capabilities unique and discoverable', () => {
    expect(TOOL_SCHEMAS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(new Set(EXPECTED_TOOLS).size).toBe(39);
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
      expectDeclaredObjectsClosed(tool.inputSchema);
      expect(tool).not.toHaveProperty('annotations');
      expect(tool).not.toHaveProperty('outputSchema');
    }
  });

  test('keeps intentional free-form headers and CDP params open', () => {
    for (const [name, key] of [
      ['chrome_network_request', 'headers'],
      ['chrome_cdp_command', 'params'],
    ]) {
      const properties = TOOL_SCHEMAS.find((tool) => tool.name === name)?.inputSchema.properties;
      expect(properties?.[key]).toMatchObject({ type: 'object' });
      expect(properties?.[key]).not.toHaveProperty('properties');
      expect(properties?.[key]).not.toHaveProperty('additionalProperties', false);
    }
    expect(() =>
      validateBrowserToolArguments('chrome_network_request', {
        url: 'https://fixture.test/',
        headers: { 'X-Fixture': 'value' },
      }),
    ).not.toThrow();
  });

  test.each(EXPECTED_TOOLS)('dispatches %s directly through Native Messaging', async (name) => {
    const data = { content: [{ type: 'text', text: 'fixture' }] };
    const send = jest
      .fn<NativeMessagingHost['sendRequestToExtensionAndWait']>()
      .mockResolvedValue({ status: 'success', data });
    const controller = new AbortController();
    const execution = { signal: controller.signal };
    const context = { transport: 'cli', sessionId: 'task', requestId: 'request' };
    expect(
      await dispatchBrowserTool(
        {
          sendRequestToExtensionAndWait: send,
        } as unknown as NativeMessagingHost,
        name,
        {},
        context,
        execution,
      ),
    ).toEqual(data);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { name, args: {}, context },
      NativeMessageType.CALL_TOOL,
      expect.any(Number),
      execution,
    );
  });

  test.each([
    ['chrome_network_capture', { tabId: 7 }],
    ['chrome_health', { unknown: true }],
    ['chrome_unknown', {}],
  ])(
    'rejects an invalid tool or undeclared argument %s/%j without browser IO',
    async (name, args) => {
      const send = jest.fn<NativeMessagingHost['sendRequestToExtensionAndWait']>();
      await expect(
        dispatchBrowserTool(
          {
            sendRequestToExtensionAndWait: send,
          } as unknown as NativeMessagingHost,
          name as string,
          args as Record<string, unknown>,
          {},
        ),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );

  test.each([null, [], 'text'])('rejects non-object tool arguments %j', (args) => {
    expect(() => validateBrowserToolArguments('chrome_health', args)).toThrow('must be an object');
  });

  test('reports native transport failure instead of hiding it', async () => {
    const send = jest
      .fn<NativeMessagingHost['sendRequestToExtensionAndWait']>()
      .mockResolvedValue({ status: 'error', error: 'Disconnected fixture' });
    await expect(
      dispatchBrowserTool(
        {
          sendRequestToExtensionAndWait: send,
        } as unknown as NativeMessagingHost,
        'chrome_health',
        {},
        {},
      ),
    ).rejects.toThrow('Disconnected fixture');
  });
});

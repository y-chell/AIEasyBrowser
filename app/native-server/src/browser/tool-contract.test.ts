import { describe, expect, jest, test } from '@jest/globals';
import { NativeMessageType, TOOL_SCHEMAS } from 'aieasybrowser-shared';
import type { NativeMessagingHost } from '../native-messaging-host';
import {
  dispatchBrowserTool,
  getBrowserToolDefinition,
  validateBrowserToolArguments,
} from './tool-dispatch';

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
  'chrome_cdp_session',
  'chrome_cdp_scripts',
  'chrome_cdp_debugger',
  'chrome_cdp_inject',
  'chrome_cdp_network',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_console',
  'chrome_collect_debug_evidence',
  'chrome_upload_file',
  'chrome_get_upload_status',
  'chrome_handle_dialog',
];

const VALID_REQUIRED_ARGS: Record<string, Record<string, unknown>> = {
  chrome_query_elements: { selector: '#fixture' },
  chrome_computer: { action: 'fill_form', elements: [{ selector: '#fixture', value: false }] },
  chrome_clipboard: { action: 'read_text' },
  chrome_wait_for: { condition: { kind: 'text', text: 'fixture' } },
  chrome_assert: { condition: { kind: 'text', text: 'fixture' } },
  chrome_switch_tab: { tabId: 7 },
  chrome_tab_group: { action: 'list' },
  chrome_network_request: { url: 'https://fixture.test/' },
  chrome_network_capture: { action: 'stop' },
  chrome_javascript: { code: 'return 1' },
  chrome_cdp_command: { method: 'Page.getFrameTree' },
  chrome_cdp_batch: { commands: [{ method: 'Page.getFrameTree' }] },
  chrome_cdp_session: { action: 'status' },
  chrome_cdp_scripts: { action: 'list' },
  chrome_cdp_debugger: { action: 'status' },
  chrome_cdp_inject: { action: 'list' },
  chrome_cdp_network: { action: 'list' },
  chrome_fill_or_select: { value: false },
  chrome_keyboard: { keys: 'Enter' },
  chrome_upload_file: { selector: '#fixture' },
  chrome_handle_dialog: { action: 'dismiss' },
};

const INVALID_ARGS: Array<[string, Record<string, unknown>, string]> = [
  ['chrome_javascript', {}, 'args/code'],
  ['chrome_javascript', { code: false }, 'args/code'],
  ['chrome_javascript', { code: 'return 1', world: 'main' }, 'args/world'],
  ['chrome_javascript', { code: 'return 1', sessionId: 3 }, 'args/sessionId'],
  ['chrome_javascript', { code: 'return 1', workerTargetId: false }, 'args/workerTargetId'],
  ['chrome_cdp_session', { action: 'worker' }, 'args/action'],
  ['chrome_switch_tab', { tabId: '7' }, 'args/tabId'],
  ['chrome_list_frames', { includeDetails: 'false' }, 'args/includeDetails'],
  ['chrome_list_frames', { tabId: null }, 'args/tabId'],
  ['chrome_clipboard', { action: 'delete' }, 'args/action'],
  ['chrome_wait_for', { condition: {} }, 'args/condition/kind'],
  ['chrome_wait_for', { condition: 'text' }, 'args/condition'],
  ['chrome_wait_for', { condition: { kind: 'invalid' } }, 'args/condition/kind'],
  ['chrome_wait_for', { condition: { kind: 'text', text: 1 } }, 'args/condition/text'],
  ['chrome_wait_for', { condition: { kind: 'text', extra: true } }, 'args/condition/extra'],
  ['chrome_click_element', { coordinates: { x: 0 } }, 'args/coordinates/y'],
  ['chrome_click_element', { coordinates: { x: 0, y: '1' } }, 'args/coordinates/y'],
  ['chrome_click_element', { modifiers: { ctrlKey: 1 } }, 'args/modifiers/ctrlKey'],
  ['chrome_close_tabs', { tabIds: '7' }, 'args/tabIds'],
  ['chrome_close_tabs', { tabIds: [7, '8'] }, 'args/tabIds/1'],
  ['chrome_cdp_batch', { commands: [null] }, 'args/commands/0'],
  ['chrome_cdp_batch', { commands: [{}] }, 'args/commands/0/method'],
  [
    'chrome_cdp_batch',
    { commands: [{ method: 'Page.getFrameTree', extra: true }] },
    'args/commands/0/extra',
  ],
  [
    'chrome_cdp_batch',
    { commands: [{ method: 'Page.getFrameTree', params: [] }] },
    'args/commands/0/params',
  ],
  [
    'chrome_computer',
    { action: 'fill_form', elements: [{ selector: '#fixture' }] },
    'args/elements/0/value',
  ],
  [
    'chrome_computer',
    { action: 'fill_form', elements: [{ value: null }] },
    'args/elements/0/value',
  ],
  ['chrome_computer', { action: 'fill', value: {} }, 'args/value'],
  ['chrome_fill_or_select', { value: [] }, 'args/value'],
  ['chrome_fill_or_select', { value: null }, 'args/value'],
  ['chrome_network_request', { url: 'https://fixture.test/', headers: [] }, 'args/headers'],
  [
    'chrome_network_request',
    { url: 'https://fixture.test/', formData: 'field=value' },
    'args/formData',
  ],
  ['chrome_cdp_session', {}, 'args/action'],
  ['chrome_cdp_session', { action: 'pause' }, 'args/action'],
  ['chrome_cdp_session', { action: 'start', events: 'Network' }, 'args/events'],
  ['chrome_cdp_session', { action: 'start', events: ['Network', 1] }, 'args/events/1'],
  ['chrome_cdp_session', { action: 'events', after: '3' }, 'args/after'],
  ['chrome_cdp_scripts', {}, 'args/action'],
  ['chrome_cdp_scripts', { action: 'read' }, 'args/action'],
  ['chrome_cdp_scripts', { action: 'list', kind: 'worker' }, 'args/kind'],
  ['chrome_cdp_scripts', { action: 'source', scriptId: 10 }, 'args/scriptId'],
  ['chrome_cdp_scripts', { action: 'source', scriptId: '10', offset: '0' }, 'args/offset'],
  ['chrome_cdp_scripts', { action: 'search', query: 'x', isRegex: 'yes' }, 'args/isRegex'],
  ['chrome_cdp_debugger', {}, 'args/action'],
  ['chrome_cdp_debugger', { action: 'step' }, 'args/action'],
  ['chrome_cdp_debugger', { action: 'setBreakpoint', url: 'x', line: '3' }, 'args/line'],
  ['chrome_cdp_debugger', { action: 'blackbox', patterns: 'x' }, 'args/patterns'],
  ['chrome_cdp_debugger', { action: 'blackbox', patterns: [1] }, 'args/patterns/0'],
  ['chrome_cdp_debugger', { action: 'evaluate', returnByValue: 'yes' }, 'args/returnByValue'],
  ['chrome_cdp_inject', {}, 'args/action'],
  ['chrome_cdp_inject', { action: 'inject' }, 'args/action'],
  ['chrome_cdp_inject', { action: 'hook', hook: 'websocket' }, 'args/hook'],
  ['chrome_cdp_inject', { action: 'hook', hook: 'property', access: 'read' }, 'args/access'],
  ['chrome_cdp_inject', { action: 'add', source: 1 }, 'args/source'],
  ['chrome_cdp_inject', { action: 'hook', hook: 'fetch', maxRecords: '9' }, 'args/maxRecords'],
  ['chrome_cdp_network', {}, 'args/action'],
  ['chrome_cdp_network', { action: 'resend' }, 'args/action'],
  ['chrome_cdp_network', { action: 'intercept', rule: { action: 'log' } }, 'args/rule/urlPattern'],
  [
    'chrome_cdp_network',
    { action: 'intercept', rule: { urlPattern: '*', action: 'block' } },
    'args/rule/action',
  ],
  [
    'chrome_cdp_network',
    { action: 'intercept', rule: { urlPattern: '*', action: 'log', delay: 1 } },
    'args/rule/delay',
  ],
  [
    'chrome_cdp_network',
    { action: 'intercept', rule: { urlPattern: '*', action: 'fail', errorReason: 'Nope' } },
    'args/rule/errorReason',
  ],
  ['chrome_cdp_network', { action: 'replay', seq: 1, replay: {} }, 'args/replay/method'],
  [
    'chrome_cdp_network',
    { action: 'replay', seq: 1, replay: { method: 'GET', credentials: 'all' } },
    'args/replay/credentials',
  ],
  ['chrome_cdp_network', { action: 'start', bodies: 'some' }, 'args/bodies'],
  ['chrome_cdp_network', { action: 'body', seq: '1' }, 'args/seq'],
  ['chrome_cdp_network', { action: 'body', seq: 1, part: 'both' }, 'args/part'],
  ['chrome_cdp_network', { action: 'list', types: 'XHR' }, 'args/types'],
  ['chrome_cdp_network', { action: 'list', state: 'done' }, 'args/state'],
  ['chrome_network_capture', { action: 'start', needResponseBody: true }, 'args/needResponseBody'],
  ['chrome_cdp_command', { method: 'Runtime.evaluate', sessionId: 7 }, 'args/sessionId'],
  [
    'chrome_cdp_batch',
    { commands: [{ method: 'Runtime.enable' }], sessionId: null },
    'args/sessionId',
  ],
  ['chrome_health', { 'a/b~c': true }, 'args/a~1b~0c'],
  ['chrome_scan_compact', { maxElements: NaN }, 'args/maxElements'],
  ['chrome_scan_compact', { maxElements: Infinity }, 'args/maxElements'],
  ['chrome_scan_compact', { maxElements: -Infinity }, 'args/maxElements'],
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
  test('inventories every schema keyword without treating property names or descriptions as schemas', () => {
    const counts: Record<string, number> = {};
    const visit = (schema: Record<string, any>) => {
      for (const keyword of Object.keys(schema)) counts[keyword] = (counts[keyword] || 0) + 1;
      for (const child of Object.values(schema.properties || {}))
        visit(child as Record<string, any>);
      if (schema.items) visit(schema.items);
      for (const child of schema.oneOf || []) visit(child);
    };
    for (const tool of TOOL_SCHEMAS) visit(tool.inputSchema);
    expect(counts).toEqual({
      type: 516,
      properties: 56,
      required: 52,
      additionalProperties: 56,
      description: 425,
      enum: 45,
      oneOf: 2,
      items: 10,
    });
  });

  test('fails compilation rather than ignoring an unknown schema constraint', () => {
    const shared = jest.requireActual(
      'aieasybrowser-shared',
    ) as typeof import('aieasybrowser-shared');
    jest.doMock('aieasybrowser-shared', () => ({
      ...shared,
      TOOL_SCHEMAS: [
        { ...shared.TOOL_SCHEMAS[0], inputSchema: { type: 'object', misspelledConstraint: true } },
      ],
    }));
    try {
      expect(() =>
        jest.isolateModules(() => {
          require('./tool-dispatch');
        }),
      ).toThrow('unknown keyword');
    } finally {
      jest.dontMock('aieasybrowser-shared');
    }
  });

  test('keeps all 44 browser capabilities unique and discoverable', () => {
    expect(TOOL_SCHEMAS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(new Set(EXPECTED_TOOLS).size).toBe(44);
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
    const args = VALID_REQUIRED_ARGS[name] ?? {};
    expect(
      await dispatchBrowserTool(
        {
          sendRequestToExtensionAndWait: send,
        } as unknown as NativeMessagingHost,
        name,
        args,
        context,
        execution,
      ),
    ).toEqual(data);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { name, args, context },
      NativeMessageType.CALL_TOOL,
      expect.any(Number),
      execution,
    );
  });

  test.each(EXPECTED_TOOLS)('describes %s without requiring call arguments', (name) => {
    expect(getBrowserToolDefinition(name)).toBe(TOOL_SCHEMAS.find((tool) => tool.name === name));
  });

  test.each(TOOL_SCHEMAS.filter((tool) => tool.inputSchema.required?.length))(
    'rejects missing required arguments for $name',
    (tool) => {
      expect(() => validateBrowserToolArguments(tool.name, {})).toThrow(
        'args/' + tool.inputSchema.required![0],
      );
    },
  );

  test.each(INVALID_ARGS)(
    'rejects %s %j at %s without browser IO or input mutation',
    async (name, args, pointer) => {
      const original = structuredClone(args);
      const send = jest.fn<NativeMessagingHost['sendRequestToExtensionAndWait']>();
      await expect(
        dispatchBrowserTool(
          { sendRequestToExtensionAndWait: send } as unknown as NativeMessagingHost,
          name,
          args,
          {},
        ),
      ).rejects.toThrow(pointer);
      expect(send).not.toHaveBeenCalled();
      expect(args).toEqual(original);
    },
  );

  test.each(['text', false, 0])('preserves declared union and oneOf value %j', (value) => {
    for (const [name, args] of [
      ['chrome_fill_or_select', { value }],
      ['chrome_computer', { action: 'fill', value }],
      ['chrome_computer', { action: 'fill_form', elements: [{ value }] }],
    ] as const)
      expect(() => validateBrowserToolArguments(name, args)).not.toThrow();
  });

  test('preserves open maps and omitted defaults without inventing constraints from prose', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'chrome_network_request',
        {
          url: 'https://fixture.test/',
          headers: { 'X-Custom': 'value' },
          formData: { fields: { enabled: false }, files: [] },
        },
      ],
      [
        'chrome_cdp_command',
        {
          method: 'Runtime.evaluate',
          params: { expression: '1', nested: { value: [1, true, null] } },
        },
      ],
      [
        'chrome_network_request',
        {
          url: 'https://fixture.test/',
          method: 'POST',
          formData: [
            ['fixture', 'value'],
            ['file', 'base64:SGk=', 'fixture.txt'],
          ],
        },
      ],
      [
        'chrome_cdp_batch',
        {
          commands: [
            { method: 'Runtime.evaluate', params: { expression: '1', arbitrary: { value: true } } },
          ],
        },
      ],
      ['chrome_close_tabs', { tabIds: [] }],
      ['chrome_cdp_batch', { commands: [] }],
      ['chrome_scan_compact', { maxElements: 0, maxTextBlocks: -1 }],
      ['chrome_scan_compact', { maxElements: 200.5, frameId: Number.MAX_SAFE_INTEGER }],
      ['chrome_screenshot', { quality: 0.3 }],
      ['chrome_screenshot', { quality: 0.95 }],
      ['chrome_list_frames', {}],
    ];
    for (const [name, args] of cases) {
      const original = structuredClone(args);
      validateBrowserToolArguments(name, args);
      expect(args).toEqual(original);
    }
  });

  test('does not accept inherited properties as required input', () => {
    const inherited = Object.create({ code: 'return 1' });
    expect(() => validateBrowserToolArguments('chrome_javascript', inherited)).toThrow('args/code');
    expect(() =>
      validateBrowserToolArguments('chrome_javascript', { code: 'return 1' }),
    ).not.toThrow();
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
    expect(() => validateBrowserToolArguments('chrome_health', args)).toThrow(
      'at args: must be object',
    );
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

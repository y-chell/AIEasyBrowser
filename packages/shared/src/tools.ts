import type { BrowserToolDefinition } from './types';

export const TOOL_NAMES = {
  BROWSER: {
    HEALTH: 'chrome_health',
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    LIST_FRAMES: 'chrome_list_frames',
    SCAN_COMPACT: 'chrome_scan_compact',
    SEARCH_TABS_CONTENT: 'search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    TAB_GROUP: 'chrome_tab_group',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE: 'chrome_network_capture',
    // Legacy tool names (kept for internal use, not exposed in TOOL_SCHEMAS)
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    JAVASCRIPT: 'chrome_javascript',
    CDP_COMMAND: 'chrome_cdp_command',
    CDP_BATCH: 'chrome_cdp_batch',
    CDP_SESSION: 'chrome_cdp_session',
    CDP_SCRIPTS: 'chrome_cdp_scripts',
    CDP_DEBUGGER: 'chrome_cdp_debugger',
    CDP_INJECT: 'chrome_cdp_inject',
    CDP_NETWORK: 'chrome_cdp_network',
    CDP_STORAGE: 'chrome_cdp_storage',
    CONSOLE: 'chrome_console',
    COLLECT_DEBUG_EVIDENCE: 'chrome_collect_debug_evidence',
    FILE_UPLOAD: 'chrome_upload_file',
    GET_UPLOAD_STATUS: 'chrome_get_upload_status',
    READ_PAGE: 'chrome_read_page',
    QUERY_ELEMENTS: 'chrome_query_elements',
    GET_ELEMENT_HTML: 'chrome_get_element_html',
    COMPUTER: 'chrome_computer',
    CLIPBOARD: 'chrome_clipboard',
    WAIT_FOR_TAB: 'chrome_wait_for_tab',
    WAIT_FOR: 'chrome_wait_for',
    ASSERT: 'chrome_assert',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
  },
};

const RAW_TOOL_SCHEMAS: BrowserToolDefinition[] = [
  {
    name: TOOL_NAMES.BROWSER.HEALTH,
    description:
      'Return extension/bridge health metadata, schema hash, tool count, extension ID, and current browser tab/window counts. Use this after upgrades to confirm the client is not using a stale tool list.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description: 'Get all currently open browser windows and tabs',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.LIST_FRAMES,
    description:
      'List frames in a tab, including frame hierarchy, URLs, titles, and lightweight readiness/interactive signals. Use returned frameId values with tools that accept frameId.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        includeDetails: {
          type: 'boolean',
          description:
            'Include per-frame title, readyState, and interactive-element signals (default: true).',
        },
      },
      required: [],
    },
  },
  // {
  //   name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
  //   description:
  //     'Run a recorded flow by ID with optional variables and run options. Returns a standardized run result.',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       flowId: { type: 'string', description: 'ID of the flow to run' },
  //       args: {
  //         type: 'object',
  //         description: 'Variable values for the flow (flat object of key/value)',
  //       },
  //       tabTarget: {
  //         type: 'string',
  //         description: "Target tab: 'current' or 'new' (default: current)",
  //         enum: ['current', 'new'],
  //       },
  //       refresh: { type: 'boolean', description: 'Refresh before running (default false)' },
  //       captureNetwork: {
  //         type: 'boolean',
  //         description: 'Capture network snippets for debugging (default false)',
  //       },
  //       returnLogs: { type: 'boolean', description: 'Return run logs (default false)' },
  //       timeoutMs: { type: 'number', description: 'Global timeout in ms (optional)' },
  //       startUrl: { type: 'string', description: 'Optional start URL to open before running' },
  //     },
  //     required: ['flowId'],
  //   },
  // },
  // {
  //   name: TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED,
  //   description: 'List published flows available as dynamic tools (for discovery).',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {},
  //     required: [],
  //   },
  // },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    description:
      'Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description:
            'Determines if, once tracing has started, the page should be automatically reloaded (ignore cache).',
        },
        autoStop: {
          type: 'boolean',
          description: 'Determines if the trace should be automatically stopped (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in milliseconds when autoStop is true (default 5000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    description: 'Stops the active performance trace recording on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        saveToDownloads: {
          type: 'boolean',
          description: 'Whether to save the trace as a JSON file in Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional filename prefix for the downloaded trace JSON.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    description:
      'Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        insightName: {
          type: 'string',
          description:
            'Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCAN_COMPACT,
    description:
      'Return a compact page scan for agents: title, URL, important text blocks, forms, buttons, inputs, selects, dialogs/overlays, iframes, and stable element refs. Use this before chrome_read_page when you need a low-token overview of what can be operated on.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description:
            'Optional frame ID. When omitted, scans all readable frames and includes frameId on each result.',
        },
        maxElements: {
          type: 'number',
          description:
            'Maximum interactive/form/dialog/iframe elements to return (default 80, max 200).',
        },
        maxTextBlocks: {
          type: 'number',
          description: 'Maximum heading/paragraph text blocks to return (default 20, max 80).',
        },
        includeTextBlocks: {
          type: 'boolean',
          description: 'Include compact heading/paragraph text blocks (default true).',
        },
        includeIframes: {
          type: 'boolean',
          description: 'Include iframe summaries (default true).',
        },
        includeCoordinates: {
          type: 'boolean',
          description: 'Include viewport center coordinates for returned elements (default true).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.\nTip: If the returned elements do not include the specific element you need, use the computer tool\'s screenshot (action="screenshot") to capture the element\'s on-screen coordinates, then operate by coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Filter elements: "interactive" for such as  buttons/links/inputs only (default: all visible elements)',
        },
        depth: {
          type: 'number',
          description:
            'Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance.',
        },
        refId: {
          type: 'string',
          description:
            'Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire).',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.QUERY_ELEMENTS,
    description:
      'Query DOM elements directly and return a structured element list, including hidden elements when requested. Useful when chrome_read_page is too high-level and you need refs, attributes, visibility, enabled state, exact DOM matches, or frame-aware results. CSS queries traverse open shadow roots; XPath does not cross shadow roots.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS or XPath selector to query.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Selector syntax (default: css). XPath does not cross shadow roots.',
        },
        refId: {
          type: 'string',
          description:
            'Optional root ref from chrome_read_page. When provided, only query inside that element subtree.',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame ID. When omitted, searches all readable frames in the tab.',
        },
        includeHidden: {
          type: 'boolean',
          description: 'Include hidden elements in the result (default: false).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of returned elements (default: 25, max: 200).',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_ELEMENT_HTML,
    description:
      'Get the real DOM HTML for a specific element, including hidden elements. Accepts a ref from chrome_read_page or a selector, and returns outerHTML by default.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page or chrome_query_elements.',
        },
        refId: {
          type: 'string',
          description: 'Alias of ref for compatibility with read_page-style naming.',
        },
        selector: {
          type: 'string',
          description: 'CSS or XPath selector for the target element.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Selector syntax (default: css). XPath does not cross shadow roots.',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description:
            'Optional frame ID. When omitted, refs use remembered frame routing and selectors search all readable frames.',
        },
        includeOuterHtml: {
          type: 'boolean',
          description: 'Return outerHTML when true, innerHTML when false (default: true).',
        },
        maxLength: {
          type: 'number',
          description: 'Maximum returned HTML length in characters (default: 20000, max: 200000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    description:
      'Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Prefer chrome_scan_compact, chrome_read_page, refs, or selectors before using coordinates. If you use coordinates, capture the current viewport first and click the element center.\n* Coordinates are always viewport CSS pixels for the current tab, independent of previous screenshots. Convert image pixels to current viewport CSS pixels yourself. Chrome debugger attach/infobar or layout changes can shift the page, so remeasure before precise clicks.\n* Coordinate clicks use trusted CDP input; ref/selector left/right clicks use synthetic DOM events. Use coordinates or chrome_cdp_command/chrome_cdp_batch when event.isTrusted is required.\n* Verify the effect after clicking; failed checks and unknown outcomes must not automatically replay an action.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        background: {
          type: 'boolean',
          description:
            'Avoid focusing/activating tab/window for certain operations (best-effort). Default: false',
        },
        action: {
          type: 'string',
          description:
            'Action to perform: left_click | right_click | double_click | triple_click | left_click_drag | scroll | scroll_to | type | key | fill | fill_form | hover | wait | resize_page | zoom | screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          description:
            'Current top-level viewport CSS pixel coordinates, never screenshot pixels. Required for click/scroll and as end point for drag.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag action',
        },
        startRef: {
          type: 'string',
          description: 'Drag start ref from chrome_read_page (alternative to startCoordinates).',
        },
        startSelector: {
          type: 'string',
          description: 'CSS/XPath selector for the drag start element.',
        },
        endSelector: {
          type: 'string',
          description:
            'CSS/XPath selector for the drag end element. If omitted, selector is treated as the end selector.',
        },
        dragSteps: {
          type: 'number',
          description: 'For action=left_click_drag: number of intermediate mouse moves (2-60).',
        },
        dragDurationMs: {
          type: 'number',
          description:
            'For action=left_click_drag: total time spent moving between points in milliseconds (0-5000).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        repeat: {
          type: 'number',
          description:
            'For action=key: number of times to repeat the key sequence (integer 1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description:
            'Modifier keys for click actions (left_click/right_click/double_click/triple_click).',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          type: 'object',
          description:
            'For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels (or screenshot-space if a recent screenshot context exists).',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
        },
        // For action=fill
        selector: {
          type: 'string',
          description:
            'CSS/XPath selector for fill, hover, click, or wait actions (use selectorType to choose).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description:
            'For action=fill_form: list of elements to fill. Each item may use ref or selector.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref from chrome_read_page' },
              selector: { type: 'string', description: 'CSS/XPath selector for this field' },
              selectorType: {
                type: 'string',
                enum: ['css', 'xpath'],
                description: 'Selector syntax for this field (default: css)',
              },
              frameId: { type: 'number', description: 'Optional target frame ID' },
              value: {
                oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
                description: 'Value to set',
              },
            },
            required: ['value'],
          },
        },
        continueOnError: {
          type: 'boolean',
          description: 'For action=fill_form: continue filling remaining fields after an error.',
        },
        width: { type: 'number', description: 'For action=resize_page: viewport width' },
        height: { type: 'number', description: 'For action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        visible: {
          type: 'boolean',
          description:
            'For action=wait with selector: whether to wait for the selector to be visible (true, default) or hidden/missing (false).',
        },
        clickable: {
          type: 'boolean',
          description:
            'For action=wait with ref/selector: wait until the target is clickable (visible, enabled, pointer-events active).',
        },
        download: {
          type: 'boolean',
          description: 'For action=wait: wait for a browser download started after this call.',
        },
        filenameContains: {
          type: 'string',
          description: 'For action=wait with download: match filename or URL substring.',
        },
        waitForComplete: {
          type: 'boolean',
          description:
            'For action=wait with download: whether to wait for completion (default true).',
        },
        network: {
          type: 'boolean',
          description: 'For action=wait: wait for any matching network request to finish.',
        },
        urlPattern: {
          type: 'string',
          description: 'For action=wait with network: URL substring to match.',
        },
        method: {
          type: 'string',
          description: 'For action=wait with network: HTTP method to match.',
        },
        status: {
          type: 'number',
          description: 'For action=wait with network: HTTP status code to match.',
        },
        includeStatic: {
          type: 'boolean',
          description:
            'For action=wait with network: whether to include static resources while capturing.',
        },
        timeout: {
          type: 'number',
          description:
            'For action=wait with text/selector/ref/download/network: timeout in milliseconds (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLIPBOARD,
    description:
      'Read and write the system clipboard through the extension offscreen document, without website clipboard permission prompts. Copy or paste text in a target page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read_text', 'write_text', 'paste_text', 'copy_selection'],
          description:
            'read_text reads the clipboard, write_text writes text, paste_text inserts text into a page target, copy_selection returns selected/target text and marks partialSuccess if system clipboard write is blocked.',
        },
        text: {
          type: 'string',
          description:
            'Text for write_text or paste_text. paste_text reads clipboard when omitted.',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page for paste_text/copy_selection target.',
        },
        selector: {
          type: 'string',
          description: 'CSS/XPath selector for paste_text/copy_selection target.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Selector syntax (default: css).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID for page-aware copy/paste (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for page-aware copy/paste.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR_TAB,
    description:
      'Wait for a newly opened tab (or a specifically matched tab) and return its identity. Useful after clicks that open a payment/login/OAuth tab or pop a new browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        openerTabId: {
          type: 'number',
          description:
            'Optional opener/source tab ID. Helps identify tabs opened by the current workflow, including ones that already opened just before this tool call.',
        },
        windowId: {
          type: 'number',
          description: 'Optional window ID filter. When omitted, tabs from any window can match.',
        },
        urlPattern: {
          type: 'string',
          description: 'Optional URL matcher string.',
        },
        titlePattern: {
          type: 'string',
          description: 'Optional title matcher string.',
        },
        match: {
          type: 'string',
          enum: ['contains', 'equals', 'regex'],
          description: 'String match mode for urlPattern/titlePattern (default: contains).',
        },
        status: {
          type: 'string',
          enum: ['any', 'loading', 'complete'],
          description: 'Desired tab load status (default: complete).',
        },
        active: {
          type: 'boolean',
          description: 'Optional active-tab filter.',
        },
        includeExisting: {
          type: 'boolean',
          description:
            'Allow an already-open matching tab to be returned immediately. Best used together with openerTabId or a strong matcher.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Overall timeout in milliseconds (default: 10000, max: 120000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR,
    description:
      'Wait for a browser condition to become true. Prefer this over ad-hoc polling JS for common checks such as element visibility, text changes, URL/title changes, JS predicates, network requests, network idle, and downloads. Synchronous JavaScript predicates reuse chrome_javascript (CDP, the frame MAIN world; a cross-process frame needs the task held chrome_cdp_session) and may show Chrome debugger notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick the active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame ID for selector/javascript waits.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Overall timeout in milliseconds (default: 10000, max: 120000).',
        },
        pollIntervalMs: {
          type: 'number',
          description:
            'Polling interval in milliseconds for url/title/javascript/exists waits (default: 200).',
        },
        includeStatic: {
          type: 'boolean',
          description:
            'For condition.kind="network": whether to include document/static responses while capturing.',
        },
        condition: {
          type: 'object',
          description:
            'Condition descriptor. Supported kinds: element, text, url, title, javascript, network, networkIdle, download, sleep.',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'element',
                'text',
                'url',
                'title',
                'javascript',
                'network',
                'networkIdle',
                'download',
                'sleep',
              ],
            },
            selector: { type: 'string', description: 'For kind="element": CSS/XPath selector.' },
            ref: {
              type: 'string',
              description:
                'For kind="element" with state="clickable": element ref from chrome_read_page.',
            },
            selectorType: {
              type: 'string',
              enum: ['css', 'xpath'],
              description: 'For kind="element": selector syntax (default: css).',
            },
            state: {
              type: 'string',
              enum: ['exists', 'visible', 'hidden', 'clickable'],
              description: 'For kind="element": desired state (default: visible).',
            },
            text: { type: 'string', description: 'For kind="text": target text.' },
            present: {
              type: 'boolean',
              description:
                'For kind="text": whether the text should be present/appear (true, default) or disappear (false).',
            },
            value: {
              type: 'string',
              description:
                'For kind="url" or kind="title": expected string/pattern. Omit when match="changed".',
            },
            match: {
              type: 'string',
              enum: ['contains', 'equals', 'regex', 'changed'],
              description:
                'For kind="url" or kind="title": matching mode (default: contains, or changed when value is omitted).',
            },
            predicate: {
              type: 'string',
              description:
                'For kind="javascript": JS expression or function that should evaluate to a truthy value in page context.',
            },
            urlPattern: {
              type: 'string',
              description: 'For kind="network": URL substring to match.',
            },
            method: { type: 'string', description: 'For kind="network": HTTP method to match.' },
            status: {
              type: 'number',
              description: 'For kind="network": HTTP status code to match.',
            },
            idleMs: {
              type: 'number',
              description: 'For kind="networkIdle": idle threshold in milliseconds.',
            },
            filenameContains: {
              type: 'string',
              description: 'For kind="download": filename or URL substring to match.',
            },
            waitForComplete: {
              type: 'boolean',
              description: 'For kind="download": whether to wait for completion (default: true).',
            },
            durationMs: {
              type: 'number',
              description: 'For kind="sleep": how long to wait in milliseconds (max: 30000).',
            },
          },
          required: ['kind'],
        },
      },
      required: ['condition'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ASSERT,
    description:
      'Assert that a browser condition becomes true within the timeout. Uses the same condition schema as chrome_wait_for, but returns an assertion-style result and fails clearly when the condition is not met.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick the active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame ID for selector/javascript assertions.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Overall timeout in milliseconds (default: 10000, max: 120000).',
        },
        pollIntervalMs: {
          type: 'number',
          description:
            'Polling interval in milliseconds for url/title/javascript/exists assertions (default: 200).',
        },
        includeStatic: {
          type: 'boolean',
          description:
            'For condition.kind="network": whether to include document/static responses while capturing.',
        },
        condition: {
          type: 'object',
          description: 'Same condition schema as chrome_wait_for. sleep is not allowed.',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'element',
                'text',
                'url',
                'title',
                'javascript',
                'network',
                'networkIdle',
                'download',
              ],
            },
            selector: { type: 'string' },
            ref: { type: 'string' },
            selectorType: { type: 'string', enum: ['css', 'xpath'] },
            state: { type: 'string', enum: ['exists', 'visible', 'hidden', 'clickable'] },
            text: { type: 'string' },
            present: { type: 'boolean' },
            value: { type: 'string' },
            match: { type: 'string', enum: ['contains', 'equals', 'regex', 'changed'] },
            predicate: { type: 'string' },
            urlPattern: { type: 'string' },
            method: { type: 'string' },
            status: { type: 'number' },
            idleMs: { type: 'number' },
            filenameContains: { type: 'string' },
            waitForComplete: { type: 'boolean' },
          },
          required: ['kind'],
        },
      },
      required: ['condition'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description:
      'Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab.',
        },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        tabId: {
          type: 'number',
          description:
            'Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab).',
        },
        windowId: {
          type: 'number',
          description:
            'Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided).',
        },
        background: {
          type: 'boolean',
          description:
            'Perform the operation without stealing focus (do not activate the tab or focus the window). Default: false',
        },
        width: {
          type: 'number',
          description:
            'Window width in pixels (default: 1280). When width or height is provided, a new window will be created.',
        },
        height: {
          type: 'number',
          description:
            'Window height in pixels (default: 720). When width or height is provided, a new window will be created.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      '[Prefer read_page over taking a screenshot and Prefer chrome_computer] Take a screenshot of the current page or a specific element. For new usage, use chrome_computer with action="screenshot". Use this tool if you need advanced options. Screenshot output can be resized when storeBase64/maxOutputWidth/maxOutputHeight are used; recapture the current viewport before reusing coordinates for clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        tabId: {
          type: 'number',
          description: 'Target tab ID to capture from (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab from when tabId is not provided.',
        },
        background: {
          type: 'boolean',
          description:
            'Attempt capture without bringing tab/window to foreground. CDP-based capture is used for viewport captures and default full-page captures. Full-page captures with custom width/height/maxHeight, and element captures, fall back to helper-based capture. Default: false',
        },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'Return screenshot data inline as compressed base64 (default: false). When true and savePng is omitted, the tool avoids saving a file by default to stay agent-friendly.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the entire page instead of just the viewport (default: false).',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save screenshot as a PNG file in Downloads. Default: true, except when storeBase64=true and savePng is omitted, in which case it defaults to false.',
        },
        imageFormat: {
          type: 'string',
          enum: ['image/jpeg', 'image/webp'],
          description: 'Inline base64 image format when storeBase64=true (default: image/jpeg).',
        },
        quality: {
          type: 'number',
          description:
            'Inline base64 compression quality from 0.3 to 0.95. Lower means smaller output.',
        },
        maxOutputWidth: {
          type: 'number',
          description:
            'Inline base64 max width in pixels. Helps keep screenshots small for model input.',
        },
        maxOutputHeight: {
          type: 'number',
          description:
            'Inline base64 max height in pixels. Full-page captures are downscaled by default unless overridden.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to close. If not provided, will close the active tab.',
        },
        url: {
          type: 'string',
          description:
            'Close tabs with this exact URL, including query and hash. A value containing "*" is a Chrome URL match pattern. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP,
    description:
      'Manage Chrome tab groups. Use it to group related tabs, rename/color groups, collapse groups, list groups, move groups, or ungroup tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'move', 'ungroup'],
          description:
            'list returns groups and their tabs; create groups tabIds; update changes title/color/collapsed; move reorders a group; ungroup removes tabs from a group.',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Tab IDs for create or ungroup.',
        },
        groupId: {
          type: 'number',
          description: 'Chrome tab group ID for update/move/ungroup, or to filter list.',
        },
        title: {
          type: 'string',
          description: 'Group title for create/update.',
        },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description: 'Group color for create/update.',
        },
        collapsed: {
          type: 'boolean',
          description: 'Whether the group is collapsed for create/update.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID for list/create/move.',
        },
        index: {
          type: 'number',
          description: 'Target group index for move.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window while fetching (default: false)',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: ['object', 'array'],
          description:
            'Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    description:
      'Lightweight network capture through the webRequest API: action="start" begins capturing, action="stop" ends it and returns method, url, status, type, and headers per request. No debugger is attached and no bodies are captured. For request/response bodies, wire headers with cookies, initiator stacks, WebSocket/SSE messages, or a HAR file, start chrome_cdp_session and use chrome_cdp_network.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description: 'Action to perform: "start" begins capture, "stop" ends and returns results',
        },
        url: {
          type: 'string',
          description:
            'For action="start": a concrete http(s) URL opens a fresh tab and captures from the first navigation; a Chrome match pattern (for example https://example.com/*) attaches to an already-open tab. If omitted, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in milliseconds (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description: 'Stop after inactivity in milliseconds (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description:
            'Include document/static responses such as HTML, images, scripts, and stylesheets (default: false). When false, top-level page documents and static assets are filtered, but XHR/fetch responses are still kept even if they return text/html; navigation-only pages may still produce 0 captured requests.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    description:
      'Wait for a browser download, get the latest matching download status, or list recent downloads with normalized status fields and final file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['wait', 'status', 'list'],
          description:
            'wait (default), status for latest matching download, or list for recent matches.',
        },
        id: { type: 'number', description: 'Filter by download ID.' },
        filenameContains: {
          type: 'string',
          description: 'Filter by substring in filename, full path, URL, or final URL.',
        },
        timeoutMs: {
          type: 'number',
          description: 'For action="wait": timeout in ms (default 60000, max 300000).',
        },
        waitForComplete: {
          type: 'boolean',
          description: 'For action="wait": wait until completed/interrupted (default true).',
        },
        startedAfter: {
          type: 'number',
          description:
            'Only include downloads whose startTime is on/after this Unix timestamp in ms.',
        },
        allowInterrupted: {
          type: 'boolean',
          description: 'For action="wait": treat interrupted downloads as a valid terminal result.',
        },
        state: {
          type: 'string',
          enum: ['in_progress', 'complete', 'interrupted'],
          description: 'Filter by raw Chrome download state.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed'],
          description: 'Filter by normalized status.',
        },
        limit: {
          type: 'number',
          description: 'For action="list": maximum returned items (default 20, max 200).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  // {
  //   name: TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
  //   description:
  //     'search for related content from the currently open tab and return the corresponding web pages.',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       query: {
  //         type: 'string',
  //         description: 'the query to search for related content.',
  //       },
  //     },
  //     required: ['query'],
  //   },
  // },
  {
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    description:
      'Execute JavaScript code in a browser tab and return the result. Always runs through CDP (awaitPromise, returnByValue), unaffected by the page CSP; there is no fallback, so a debugger held by DevTools or another extension fails with error.kind debugger_conflict. Choose at most one context: frameId (any frame from scan or chrome_list_frames, in world MAIN or ISOLATED), sessionId (a held child session: dedicated/service worker or OOPIF root), or workerTargetId (a shared worker from chrome_cdp_session workers). Frames in a cross-process (cross-site) iframe need an active chrome_cdp_session started by the same task on the tab; without one the call fails with CDP_SESSION_NOT_STARTED instead of running elsewhere. The result reports the frameId, world, cdpFrameId and sessionId it ran in. DOM events created here are synthetic (event.isTrusted=false); if a site ignores them, use chrome_computer or CDP Input events. Output is sanitized (sensitive data redacted) and truncated by default.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        frameId: {
          type: 'number',
          description:
            'Extension frame ID (0 = top frame) from scan or chrome_list_frames. Mapped to its CDP frame; unknown or unmappable frames fail (FRAME_NOT_FOUND, FRAME_MAPPING_FAILED).',
        },
        world: {
          type: 'string',
          enum: ['MAIN', 'ISOLATED'],
          description:
            'MAIN (default) is the page JavaScript context. ISOLATED is a separate AEB world in the frame that shares the DOM but not page globals; its globals persist until the frame navigates. Frames only.',
        },
        sessionId: {
          type: 'string',
          description:
            'Child CDP session (worker, service_worker, or iframe root) from chrome_cdp_session status or workers. Requires an active chrome_cdp_session on this tab started by the same task.',
        },
        workerTargetId: {
          type: 'string',
          description:
            'Browser-level worker target (shared worker) from chrome_cdp_session workers browserTargets; its URL origin must be loaded in the tab. Attached only for this call.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 15000).',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit will be truncated.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_COMMAND,
    description:
      'Send one raw Chrome DevTools Protocol command to a tab through chrome.debugger. Useful for advanced browser automation such as Runtime.evaluate, DOM.getDocument, DOM.querySelector, DOM.getBoxModel, Input.dispatchMouseEvent, Input.insertText, Page.captureScreenshot, Page.getFrameTree, and Page.createIsolatedWorld. For trusted clicks, get center coordinates with DOM.getBoxModel and dispatch mouseMoved -> mousePressed -> mouseReleased. Use bringToFront for throttled background tabs, and recapture coordinates after first debugger attach or Chrome infobar changes. Prefer higher-level tools when they fit.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: 'CDP method name, for example "Runtime.evaluate" or "Page.getFrameTree".',
        },
        params: {
          type: 'object',
          description: 'CDP command parameters object.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        sessionId: {
          type: 'string',
          description:
            'Child CDP session (OOPIF iframe or worker) from chrome_cdp_session status targets. Requires an active chrome_cdp_session on this tab started by the same task; unknown IDs fail before reaching Chrome.',
        },
        bringToFront: {
          type: 'boolean',
          description: 'Send Page.bringToFront before the command (default false).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Command timeout in milliseconds (default 15000, max 120000).',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Maximum serialized result size in bytes (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact cookies/tokens/password-like data from the CDP result (default true). Set false only when you need raw CDP output such as screenshot base64.',
        },
      },
      required: ['method'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_BATCH,
    description:
      'Send multiple Chrome DevTools Protocol commands to a tab using one shared debugger session. Use this to reduce browser round trips for flows like DOM.getDocument -> DOM.querySelector -> DOM.getBoxModel -> Input.dispatchMouseEvent. Good for trusted click sequences: mouseMoved -> mousePressed -> mouseReleased. Use bringToFront before actions on throttled background tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description:
            'Commands to run in order. Each item supports method, params, label, and continueOnError.',
          items: {
            type: 'object',
            properties: {
              method: {
                type: 'string',
                description: 'CDP method name.',
              },
              params: {
                type: 'object',
                description: 'CDP command parameters object.',
              },
              label: {
                type: 'string',
                description: 'Optional label copied into the result for easier matching.',
              },
              continueOnError: {
                type: 'boolean',
                description:
                  'Continue with following commands if this command fails (default false).',
              },
            },
            required: ['method'],
          },
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        sessionId: {
          type: 'string',
          description:
            'Child CDP session (OOPIF iframe or worker) from chrome_cdp_session status targets. Requires an active chrome_cdp_session on this tab started by the same task; all commands go to this session; unknown IDs fail before reaching Chrome.',
        },
        bringToFront: {
          type: 'boolean',
          description: 'Send Page.bringToFront before the batch (default false).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout for each command in milliseconds (default 15000, max 120000).',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Maximum serialized result size per command in bytes (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact cookies/tokens/password-like data from command results (default true). Set false only when raw CDP output is required.',
        },
      },
      required: ['commands'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_SESSION,
    description:
      'Hold a Chrome DevTools Protocol session on a tab across calls and buffer its events. start attaches, records the listed event domains/methods (for example "Runtime", "Network.requestWillBeSent", or "*"), and by default auto-attaches OOPIF iframes and workers as child sessions. While held, CDP domain state enabled with chrome_cdp_command/batch (Runtime.enable, Network.enable, Debugger.enable) persists between calls, and child targets can be addressed with their sessionId. events reads buffered events after a cursor with byte limits; missed/dropped report ring-buffer loss. workers lists worker child sessions (dedicated workers, service workers in scope; use sessionId) and browser-level worker targets of the tab origins that are not children of the page (shared workers; use workerTargetId with chrome_javascript). stop detaches. One session per tab, owned by the starting task. State is lost on extension reload. A detach while the tab stays open (user cancels the debugging banner, renderer crash) ends the session but keeps buffered events readable until stop; closing the tab discards the session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'events', 'workers', 'stop'],
          description: 'start | status | events | workers | stop.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description:
            'start: domain ("Network") or exact method ("Debugger.paused") names to buffer, or "*" for all. Default none; child target attach/detach is tracked regardless.',
        },
        autoAttach: {
          type: 'boolean',
          description:
            'start: auto-attach OOPIF iframes and workers as flattened child sessions (default true).',
        },
        maxEvents: {
          type: 'number',
          description:
            'start: ring-buffer size (default 1000, max 10000). Oldest events are dropped.',
        },
        after: {
          type: 'number',
          description: 'events: return events with seq greater than this cursor (default 0).',
        },
        limit: {
          type: 'number',
          description: 'events: maximum events per page (default 100, max 1000).',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'events: maximum page size in bytes (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'events: redact cookies/tokens/password-like data (default true). Set false only when raw values are required.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_SCRIPTS,
    description:
      'List, read, and search JavaScript loaded in a tab held by chrome_cdp_session (start it first). The first call enables the Debugger domain on the tab and its child sessions with skipAllPauses (existing `debugger;` statements do not freeze the page) and Chrome replays every live script. The table tracks scripts from Debugger.scriptParsed: kind external | inline | eval (no url) | sourceURL, target page | iframe | worker, and drops scripts of navigated frames. Lines/columns are 0-based and resource-relative like CDP locations (an inline script starts at its startLine inside the HTML), so search hits work as Debugger.setBreakpointByUrl locations. offset/length count UTF-16 code units like scriptParsed length. source returns one slice (never a whole large bundle by default); continue with offset=endOffset while hasMore. search scans each script locally and returns scriptId:line:column, offset, and a snippet; continue with cursor. Scripts in a child session need its sessionId. Output redacts embedded tokens by default.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'source', 'search'],
          description: 'list | source | search.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        scriptId: {
          type: 'string',
          description: 'source: required. list/search: restrict to this script.',
        },
        sessionId: {
          type: 'string',
          description:
            'Child session (OOPIF or worker) owning the script, from list or chrome_cdp_session status. Omit for the root page session. list/search: restrict to this session; "" selects the root session only.',
        },
        url: {
          type: 'string',
          description: 'list/search: case-insensitive substring of the script url.',
        },
        kind: {
          type: 'string',
          enum: ['external', 'inline', 'eval', 'sourceURL'],
          description: 'list/search: restrict to one script kind.',
        },
        includeIsolated: {
          type: 'boolean',
          description:
            'list/search: include isolated-world scripts (extension content scripts). Default false.',
        },
        after: {
          type: 'number',
          description: 'list: return scripts with seq greater than this cursor (default 0).',
        },
        limit: {
          type: 'number',
          description: 'list: maximum scripts per page (default 100, max 1000).',
        },
        offset: {
          type: 'number',
          description: 'source: start offset in UTF-16 code units (default 0).',
        },
        length: {
          type: 'number',
          description: 'source: code units to read from offset (default 20000).',
        },
        line: {
          type: 'number',
          description:
            'source: first resource-relative line to read, instead of offset. Must be within startLine..endLine of the script.',
        },
        lineCount: {
          type: 'number',
          description: 'source: number of lines to read from line (default 200).',
        },
        query: {
          type: 'string',
          description: 'search: text to find, or a JavaScript regular expression with isRegex.',
        },
        isRegex: {
          type: 'boolean',
          description: 'search: treat query as a JavaScript regular expression (default false).',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'search: case-sensitive matching (default false).',
        },
        maxMatches: {
          type: 'number',
          description: 'search: maximum matches per page (default 50, max 500).',
        },
        contextChars: {
          type: 'number',
          description:
            'search: characters of context before and after each match (default 80, max 500).',
        },
        cursor: {
          type: 'string',
          description: 'search: resume after a previous page, using its cursor value.',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum UTF-8 bytes of source text, or of list/search entries, per call (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact embedded tokens, JWTs, and long base64/hex strings in source text and snippets (default true). Offsets always refer to the raw source.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_DEBUGGER,
    description:
      'JavaScript debugger for a tab held by chrome_cdp_session (start it first; shares the Debugger domain of chrome_cdp_scripts). Pausing freezes the page: other tools that run page JavaScript wait until resume. A session (page or child sessionId) only pauses while it is "armed": it has a breakpoint, a requested pause, or a current pause; otherwise skipAllPauses stays on and `debugger;` statements are ignored. While armed, `debugger;` statements in that session also pause. setBreakpoint: url/urlRegex (survives reloads) or scriptId (this script only) with a 0-based resource-relative line (use chrome_cdp_scripts search locations), optional condition, or logMessage (logpoint: console.log(logMessage) without pausing; read it with Runtime.enable and Runtime.consoleAPICalled events); or xhrUrl (substring, "" = every request) or eventName (DOM event listener). wait blocks until a pause with seq > after (any session unless sessionId). status lists pauses with frames and scopes, breakpoints with hit counts, and armed sessions. resume/step*/continueToLocation/evaluate/properties act on the paused session (pass sessionId when several are paused); steps return the next pause or running:true; resume while not paused cancels a pending pause and disarms a session without breakpoints. properties lists a scope (frameIndex+scopeIndex) or objectId, depth expands nested objects. objectIds are valid only until resume. stop of chrome_cdp_session resumes and disables everything. Breakpoints in a child session apply to that session only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'wait',
            'pause',
            'resume',
            'stepOver',
            'stepInto',
            'stepOut',
            'continueToLocation',
            'setBreakpoint',
            'removeBreakpoint',
            'evaluate',
            'properties',
            'blackbox',
          ],
          description: 'Debugger action.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        sessionId: {
          type: 'string',
          description:
            'Child session (OOPIF or worker) from chrome_cdp_session status; "" or omitted = the page. wait without sessionId waits for any session; resume/step/evaluate/properties without it use the only paused session.',
        },
        url: {
          type: 'string',
          description: 'setBreakpoint: exact script URL.',
        },
        urlRegex: {
          type: 'string',
          description: 'setBreakpoint: regular expression for script URLs.',
        },
        scriptId: {
          type: 'string',
          description:
            'setBreakpoint: script from chrome_cdp_scripts (only this script instance). continueToLocation: target script.',
        },
        line: {
          type: 'number',
          description:
            'setBreakpoint/continueToLocation: 0-based resource-relative line (inline scripts count from the top of the HTML).',
        },
        column: {
          type: 'number',
          description:
            'setBreakpoint/continueToLocation: 0-based column (one-line bundles need it).',
        },
        condition: {
          type: 'string',
          description: 'setBreakpoint: JavaScript expression; pauses only when truthy.',
        },
        logMessage: {
          type: 'string',
          description:
            'setBreakpoint: console.log arguments as JavaScript, e.g. "\'sig\', s"; logs instead of pausing (combined with condition when both are given).',
        },
        xhrUrl: {
          type: 'string',
          description:
            'setBreakpoint: pause when an XHR/fetch URL contains this text ("" for every request). Page and iframe sessions only.',
        },
        eventName: {
          type: 'string',
          description: 'setBreakpoint: DOM event name such as "click"; pauses in its listeners.',
        },
        targetName: {
          type: 'string',
          description: 'setBreakpoint with eventName: EventTarget interface name, e.g. "Window".',
        },
        breakpointId: {
          type: 'string',
          description: 'removeBreakpoint: id from setBreakpoint or status (with its sessionId).',
        },
        after: {
          type: 'number',
          description: 'wait: return the first pause with seq greater than this (default 0).',
        },
        timeoutMs: {
          type: 'number',
          description:
            'wait: maximum wait (default 10000, max 60000). pause/step*: wait for the resulting pause (default 3000).',
        },
        frameIndex: {
          type: 'number',
          description: 'evaluate/properties: call frame index from the pause (default 0, top).',
        },
        scopeIndex: {
          type: 'number',
          description: 'properties: scope index in the frame (from pause frames[].scopes).',
        },
        objectId: {
          type: 'string',
          description: 'properties: RemoteObject id from a scope, property, or evaluate result.',
        },
        expression: {
          type: 'string',
          description: 'evaluate: JavaScript evaluated in the paused call frame (sees its locals).',
        },
        returnByValue: {
          type: 'boolean',
          description: 'evaluate: return a JSON value instead of a RemoteObject (default false).',
        },
        depth: {
          type: 'number',
          description: 'properties: nested object levels to expand (default 0, max 3).',
        },
        maxProperties: {
          type: 'number',
          description: 'properties: total properties across all levels (default 100, max 1000).',
        },
        maxFrames: {
          type: 'number',
          description: 'Call frames per pause in the output (default 20, max 200).',
        },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'blackbox: script URL regular expressions to skip while stepping; replaces the previous list, [] clears.',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum UTF-8 bytes of the result; frame/property lists are trimmed first (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact values of sensitive names (token, password, cookie, ...) and embedded tokens (default true).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_INJECT,
    description:
      'Run scripts at document start and record page activity in a tab held by chrome_cdp_session (start it first; stop removes everything). add registers source with Page.addScriptToEvaluateOnNewDocument for every later document of the tab: the top frame, same-process iframes, and cross-site iframes auto-attached by the session (a re-created iframe is paused until it is registered). worldName runs it in a named isolated world instead of the page main world; runImmediately also runs it in the current documents. hook installs a recorder in the page main world: function wraps the function at path (calls with argument/return/this previews and a short stack), property observes get/set of path (accessors such as document.cookie are wrapped where they are defined), fetch and xhr record method, url, request header names (values never), a body preview, status and duration. Hooks retry at DOMContentLoaded and load when path does not exist yet, and run in the current documents unless runImmediately is false. Records arrive in chrome_cdp_session events as method AEB.hook with hookId, whatever the start filter, under the same ring buffer, byte limits, and redaction; each document stops after maxRecords. Records come from page context: the page can see the binding and forge or suppress them, so treat them as page data. list shows injections with record/install counts and failures; remove unregisters one id (a hook already running in a loaded document stays until it navigates; its later records are dropped). Workers and iframes nested inside a cross-site iframe are not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'hook', 'list', 'remove'],
          description: 'add | hook | list | remove.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        source: {
          type: 'string',
          description: 'add: JavaScript source evaluated before any page script (max 1 MB).',
        },
        worldName: {
          type: 'string',
          description:
            'add: run in this isolated world (1-64 letters, digits, "_", ".", "-") instead of the page main world.',
        },
        runImmediately: {
          type: 'boolean',
          description:
            'Also run in the documents already loaded. add: default false. hook: default true.',
        },
        hook: {
          type: 'string',
          enum: ['function', 'property', 'fetch', 'xhr'],
          description: 'hook: what to record.',
        },
        path: {
          type: 'string',
          description:
            'hook function/property: dotted path from globalThis, up to 10 identifiers, e.g. "crypto.subtle.sign" or "document.cookie".',
        },
        access: {
          type: 'string',
          enum: ['get', 'set', 'both'],
          description: 'hook property: which accesses to record (default both).',
        },
        maxRecords: {
          type: 'number',
          description: 'hook: records per document before it stops (default 200, max 10000).',
        },
        stackDepth: {
          type: 'number',
          description: 'hook: caller stack frames per record (default 5, max 20, 0 for none).',
        },
        id: {
          type: 'string',
          description: 'remove: injection id from add, hook, or list.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_NETWORK,
    description:
      'Request table of a tab held by chrome_cdp_session (start it first; its stop ends everything). start enables the Network domain on the tab and on every cross-site iframe and worker the session auto-attaches (a re-created iframe is paused until it is enabled), and records every request from then on, whatever the session event filter: method, url, type, status, timing, initiator with stack, the renderer headers and the wire headers (Cookie, Set-Cookie), redirects as linked rows, WebSocket frames, and EventSource messages. Bodies are read when a request finishes, because Chrome drops them once the document navigates: bodies="api" (default) keeps Document/XHR/Fetch/Other responses, "all" also scripts, styles, images, and fonts, "none" none; request bodies are kept whenever the page sends one. Each body keeps up to maxBodyBytes and all bodies share 32 MB (oldest evicted first); a body that was not kept is read from Chrome on demand while it still exists. list pages rows by seq (filter by url substring, method, types, status, state, sessionId); get returns one row in full with headers, auth (names of credential headers and cookies, never values), body previews, and timings; body pages the full request or response body (text by chars, binary as base64 by bytes); messages pages WebSocket/EventSource messages; har writes a HAR 1.2 file of the filtered rows into the Downloads folder and returns only its path; clear empties the table and keeps recording; stop disables Network and Fetch and keeps the table readable. intercept (needs recording on) adds a rule: requests whose url matches rule.urlPattern (Chrome glob: * any run, ? one char), optionally only of rule.resourceTypes, pause at rule.stage request (default) or response in the tab, every cross-site iframe and service worker (dedicated worker requests pause in their page) and are answered at once by the first matching rule: continue (at the request stage optionally changing url, method, headers merged over the originals, removeHeaders, postData), fulfill (status, headers, body, bodyBase64), fail (errorReason), or log (continue unchanged and record). Each row lists the rule and action that touched it (intercepted; get shows intercepts with the changes). A request is never left paused: on a rule error it is continued unchanged, and unintercept, stop, and the session stop disable Fetch, which releases anything still paused. rules lists rules with hit counts and the last 50 paused requests. replay sends row seq again with fetch from the frame or worker that sent it (its cookies, Origin, and Referer, in an isolated world the page cannot patch); replay.method is required and the body must be given (replay.body) or the original confirmed (replay.useOriginalBody), never implied; the new rows carry replayOf=seq. Forbidden headers (Cookie, Origin, Host, Sec-*) are dropped by fetch and reported. Credential header, cookie, and query values and embedded tokens are redacted unless sanitizeOutput is false. Iframes nested inside a cross-site iframe are not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'start',
            'list',
            'get',
            'body',
            'messages',
            'har',
            'clear',
            'stop',
            'intercept',
            'rules',
            'unintercept',
            'replay',
          ],
          description:
            'start | list | get | body | messages | har | clear | stop | intercept | rules | unintercept | replay.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        bodies: {
          type: 'string',
          enum: ['api', 'all', 'none'],
          description: 'start: which response bodies to keep (default api).',
        },
        maxBodyBytes: {
          type: 'number',
          description: 'start: bytes kept per body (default 1048576, max 10485760).',
        },
        maxRequests: {
          type: 'number',
          description: 'start: rows kept, oldest dropped first (default 2000, max 10000).',
        },
        seq: {
          type: 'number',
          description: 'get, body, messages, replay: row seq from list.',
        },
        part: {
          type: 'string',
          enum: ['request', 'response'],
          description: 'body: which body (default response).',
        },
        url: {
          type: 'string',
          description: 'list, har: case-insensitive url substring.',
        },
        method: {
          type: 'string',
          description: 'list, har: HTTP method.',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'list, har: CDP resource types, e.g. ["XHR","Fetch"], Document, Script, WebSocket, EventSource.',
        },
        status: {
          type: 'number',
          description: 'list, har: HTTP status.',
        },
        state: {
          type: 'string',
          enum: ['pending', 'complete', 'failed', 'open', 'closed'],
          description: 'list, har: row state (open/closed are WebSocket states).',
        },
        sessionId: {
          type: 'string',
          description: 'list, har: child sessionId, or "root" for the tab itself.',
        },
        after: {
          type: 'number',
          description:
            'list: rows with seq greater than this. messages: messages after this index.',
        },
        limit: {
          type: 'number',
          description: 'list, messages: page size (default 100, max 1000).',
        },
        offset: {
          type: 'number',
          description: 'body: start offset (chars for text, bytes for base64; default 0).',
        },
        length: {
          type: 'number',
          description: 'body: chars or bytes to return (default as much as maxOutputBytes allows).',
        },
        includeBodies: {
          type: 'boolean',
          description: 'har: include stored bodies and messages (default true).',
        },
        filename: {
          type: 'string',
          description:
            'har: file name in the Downloads folder (letters, digits, "_", ".", "-"; .har is added). An existing name gets a number.',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'list, body, messages: maximum output bytes (default 51200).',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact credential header, cookie, and query values and embedded tokens in output and HAR (default true).',
        },
        rule: {
          type: 'object',
          description:
            'intercept: the rule. Only the fields of its action are accepted; continue at the response stage takes no changes.',
          properties: {
            urlPattern: {
              type: 'string',
              description:
                'Chrome glob on the full url, e.g. "*://*/api/*" (* any run, ? one char).',
            },
            resourceTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Only these CDP resource types, e.g. ["XHR","Fetch"] (default all).',
            },
            stage: {
              type: 'string',
              enum: ['request', 'response'],
              description: 'Pause before sending (default) or after response headers arrive.',
            },
            action: {
              type: 'string',
              enum: ['continue', 'fulfill', 'fail', 'log'],
              description: 'What to do with a matching paused request.',
            },
            url: { type: 'string', description: 'continue: send to this absolute url instead.' },
            method: { type: 'string', description: 'continue: HTTP method to send.' },
            headers: {
              type: 'object',
              description:
                'continue: headers set over the original ones. fulfill: the response headers.',
            },
            removeHeaders: {
              type: 'array',
              items: { type: 'string' },
              description: 'continue: header names to drop.',
            },
            postData: { type: 'string', description: 'continue: request body text to send.' },
            status: { type: 'number', description: 'fulfill: status code (default 200).' },
            body: {
              type: 'string',
              description: 'fulfill: response body text, or base64 with bodyBase64 (max 2 MB).',
            },
            bodyBase64: { type: 'boolean', description: 'fulfill: body is base64.' },
            errorReason: {
              type: 'string',
              enum: [
                'Failed',
                'Aborted',
                'TimedOut',
                'AccessDenied',
                'ConnectionClosed',
                'ConnectionReset',
                'ConnectionRefused',
                'ConnectionAborted',
                'ConnectionFailed',
                'NameNotResolved',
                'InternetDisconnected',
                'AddressUnreachable',
                'BlockedByClient',
                'BlockedByResponse',
              ],
              description: 'fail: network error to report (default Failed).',
            },
          },
          required: ['urlPattern', 'action'],
        },
        ruleId: {
          type: 'string',
          description: 'unintercept: rule id from intercept or rules, or "all".',
        },
        replay: {
          type: 'object',
          description: 'replay: how to send row seq again.',
          properties: {
            method: {
              type: 'string',
              description: 'Required HTTP method; it is not copied from the row.',
            },
            body: {
              type: 'string',
              description: 'Body text to send (may be ""); not allowed with GET or HEAD.',
            },
            useOriginalBody: {
              type: 'boolean',
              description: 'true sends the recorded request body; use instead of body.',
            },
            url: { type: 'string', description: 'Absolute url to send to (default the row url).' },
            headers: {
              type: 'object',
              description: 'Headers set over the recorded renderer headers.',
            },
            removeHeaders: {
              type: 'array',
              items: { type: 'string' },
              description: 'Recorded header names to leave out.',
            },
            credentials: {
              type: 'string',
              enum: ['include', 'same-origin', 'omit'],
              description: 'fetch credentials mode (default include).',
            },
            timeoutMs: {
              type: 'number',
              description: 'Abort after this many ms (default 30000, max 60000).',
            },
          },
          required: ['method'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_STORAGE,
    description:
      'Cookies, localStorage/sessionStorage, IndexedDB, and Cache Storage of a tab held by chrome_cdp_session (start it first). Every call names one target; there is no operation across sites. origins lists the http(s) origins of the tab (top frame and attached cross-site iframes) with their storage key; storage actions take one of them as origin and fail with STORAGE_ORIGIN_NOT_FOUND or STORAGE_ORIGIN_AMBIGUOUS otherwise. cookies lists the cookies Chrome would send to url (or of every frame of the tab when url is omitted), including httpOnly and partitioned (CHIPS) cookies with their partitionKey; setCookie sets one cookie for url, a url of the tab (domain must cover its host; partitioned cookies need secure:true) and reads it back; deleteCookie deletes the cookies named name for url, unpartitioned only unless partitionKey is given (pass it as listed), narrowed by domain and path, and verifies they are gone. items pages keys and values of one area of origin (filter by exact key or prefix); setItem, removeItem, and clearItems change only that origin and area. databases lists IndexedDB databases with stores, key paths, counts, and indexes; readStore pages records of one store or index (range: only, or lower/upper with lowerOpen/upperOpen; direction prev for newest keys first); IndexedDB is read-only. caches lists Cache Storage names, cacheEntries pages the requests in one cache (pathFilter substring), and cacheResponse returns the cached response body of url (text by chars, binary as base64 by bytes). Values are read in an isolated world the page cannot patch; storage, IndexedDB, and Cache Storage actions fail with STORAGE_PAGE_PAUSED while that frame is paused in the debugger (cookies still work). Cookie values are redacted, and storage values under sensitive names or holding tokens are redacted, unless sanitizeOutput is false. Iframes nested inside a cross-site iframe are not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'origins',
            'cookies',
            'setCookie',
            'deleteCookie',
            'items',
            'setItem',
            'removeItem',
            'clearItems',
            'databases',
            'readStore',
            'caches',
            'cacheEntries',
            'cacheResponse',
          ],
          description:
            'origins | cookies | setCookie | deleteCookie | items | setItem | removeItem | clearItems | databases | readStore | caches | cacheEntries | cacheResponse. Each action rejects parameters it does not use.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        origin: {
          type: 'string',
          description:
            'Storage, IndexedDB, and cache actions: origin from origins, e.g. "https://example.com".',
        },
        area: {
          type: 'string',
          enum: ['local', 'session'],
          description: 'items, setItem, removeItem, clearItems: localStorage or sessionStorage.',
        },
        key: {
          type: 'string',
          description: 'items: only this key. setItem, removeItem: the key.',
        },
        prefix: { type: 'string', description: 'items: keys starting with this.' },
        value: {
          type: 'string',
          description: 'setItem: value to store. setCookie: cookie value.',
        },
        name: {
          type: 'string',
          description: 'cookies: only this name. setCookie, deleteCookie: cookie name.',
        },
        url: {
          type: 'string',
          description:
            'cookies, setCookie, deleteCookie: absolute url of a frame origin in the tab. cacheResponse: request url of the entry.',
        },
        domain: {
          type: 'string',
          description:
            'setCookie: cookie domain covering the url host (omit for a host-only cookie). deleteCookie: only this domain.',
        },
        path: {
          type: 'string',
          description: 'setCookie: cookie path (default from url). deleteCookie: only this path.',
        },
        secure: { type: 'boolean', description: 'setCookie: Secure attribute.' },
        httpOnly: { type: 'boolean', description: 'setCookie: HttpOnly attribute.' },
        sameSite: {
          type: 'string',
          enum: ['Strict', 'Lax', 'None'],
          description: 'setCookie: SameSite attribute (None needs secure:true).',
        },
        expires: {
          type: 'number',
          description:
            'setCookie: future expiry in seconds since the epoch (omit for a session cookie).',
        },
        partitionKey: {
          type: 'object',
          description:
            'setCookie, deleteCookie: CHIPS partition as listed by cookies; setCookie needs secure:true with it.',
          properties: {
            topLevelSite: {
              type: 'string',
              description:
                'Scheme and registrable host of the top-level site, e.g. "https://a.com".',
            },
            hasCrossSiteAncestor: {
              type: 'boolean',
              description: 'Whether the cookie was set in a cross-site context.',
            },
          },
          required: ['topLevelSite', 'hasCrossSiteAncestor'],
        },
        database: { type: 'string', description: 'readStore: IndexedDB database name.' },
        store: { type: 'string', description: 'readStore: object store name.' },
        index: { type: 'string', description: 'readStore: read through this index of the store.' },
        range: {
          type: 'object',
          description:
            'readStore: key range on the store or index. Keys are strings, numbers, or arrays of keys.',
          properties: {
            only: {
              oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array' }],
              description: 'Exactly this key; not combined with bounds.',
            },
            lower: {
              oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array' }],
              description: 'Lower bound.',
            },
            upper: {
              oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array' }],
              description: 'Upper bound.',
            },
            lowerOpen: { type: 'boolean', description: 'Exclude the lower bound.' },
            upperOpen: { type: 'boolean', description: 'Exclude the upper bound.' },
          },
        },
        direction: {
          type: 'string',
          enum: ['next', 'prev'],
          description: 'readStore: ascending (default) or descending key order.',
        },
        cache: {
          type: 'string',
          description: 'cacheEntries, cacheResponse: cache name from caches.',
        },
        pathFilter: {
          type: 'string',
          description: 'cacheEntries: only requests whose url contains this.',
        },
        offset: {
          type: 'number',
          description:
            'cookies, items, readStore, cacheEntries: entries to skip (use nextOffset). cacheResponse: body start (chars for text, bytes for base64).',
        },
        limit: {
          type: 'number',
          description:
            'Page size: cookies, items (default 100, max 1000), readStore (default 20, max 500), cacheEntries (default 50, max 500).',
        },
        length: {
          type: 'number',
          description:
            'cacheResponse: chars or bytes to return (default as much as maxOutputBytes allows).',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output bytes (default 51200); long values are cut and pages end early.',
        },
        sanitizeOutput: {
          type: 'boolean',
          description:
            'Redact cookie values and sensitive storage values and embedded tokens (default true).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    description:
      'Click on an element in a web page. Supports multiple targeting methods: CSS selector, XPath, element ref (from chrome_read_page), or viewport coordinates. More focused than chrome_computer for simple click operations. This uses page-side DOM interaction; if the target requires trusted user input or precise coordinates, switch to chrome_computer or CDP Input.dispatchMouseEvent.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the element to click.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        coordinates: {
          type: 'object',
          description: 'Viewport coordinates to click at.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        double: {
          type: 'boolean',
          description: 'Perform double click when true (default: false).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click (default: "left").',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys to hold during click.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for navigation to complete after click (default: false).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds for waiting (default: 5000).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL,
    description:
      'Fill or select a form element on a web page. Supports input, textarea, select, checkbox, and radio elements. Use CSS selector, XPath, or element ref to target the element. For autofill/password-protected fields that only accept input after foreground focus, click/focus first and use chrome_keyboard or CDP Input.insertText if synthetic fill is ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the form element.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: ['value'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description:
      'Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), and text input. Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description:
            'Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World".',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for target element to receive keyboard events.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in milliseconds (default: 50).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window when capturing via CDP. Default: false',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description:
            'Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence.',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly).',
        },
        buffer: {
          type: 'boolean',
          description: 'Alias for mode="buffer" (default: false).',
        },
        clear: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading.',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false).',
        },
        pattern: {
          type: 'string',
          description:
            'Optional regex filter applied to message/exception text. Supports /pattern/flags syntax.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only return error-level console messages (and exceptions when includeExceptions=true). Default: false.',
        },
        limit: {
          type: 'number',
          description:
            'Limit returned console messages. In snapshot mode this is an alias for maxMessages; in buffer mode it limits returned messages from the buffer.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COLLECT_DEBUG_EVIDENCE,
    description:
      'Collect a compact debugging bundle for a tab: page context, optional screenshot, recent console logs, runtime exceptions, and a recent network-capture summary when available.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        includeScreenshot: {
          type: 'boolean',
          description: 'Include a compressed screenshot as base64 data (default: true).',
        },
        background: {
          type: 'boolean',
          description:
            'Prefer background-friendly screenshot capture when possible (default: true).',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture a full-page screenshot instead of the current viewport.',
        },
        includeConsole: {
          type: 'boolean',
          description: 'Include console and runtime exception evidence (default: true).',
        },
        consoleMode: {
          type: 'string',
          enum: ['auto', 'buffer', 'snapshot'],
          description:
            'Console collection mode. auto prefers buffer and falls back to snapshot when needed (default: auto).',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught runtime exceptions in console evidence (default: true).',
        },
        onlyErrors: {
          type: 'boolean',
          description: 'Only include error-level console messages (default: false).',
        },
        consoleLimit: {
          type: 'number',
          description: 'Maximum number of console messages to return (default: 20, max: 200).',
        },
        includeExtensionConsole: {
          type: 'boolean',
          description:
            'Include chrome-extension:// / moz-extension:// console entries. Defaults to false so page-origin evidence is shown first.',
        },
        clearConsole: {
          type: 'boolean',
          description: 'Buffer mode only: clear buffered console entries before reading.',
        },
        clearConsoleAfterRead: {
          type: 'boolean',
          description: 'Buffer mode only: clear buffered console entries after reading.',
        },
        includeNetworkSummary: {
          type: 'boolean',
          description:
            'Include a recent network-capture summary for this tab when available (default: true).',
        },
        networkLimit: {
          type: 'number',
          description: 'Maximum number of recent requests to include in the network summary.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to web forms using Chrome DevTools Protocol. Default mode targets input[type="file"] with DOM.setFileInputFiles, checks disabled/multiple/accept state where possible, dispatches input/change/blur events, checks browser-side selection state, and returns an uploadId. Set mode="dragDrop" to dispatch dragenter/dragover/drop with DataTransfer files to a drop zone selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the file input element, or for the drop zone when mode="dragDrop".',
        },
        mode: {
          type: 'string',
          enum: ['fileInput', 'dragDrop'],
          description:
            'Upload mode. fileInput uses DOM.setFileInputFiles on selector (default). dragDrop creates a temporary file input, attaches files with CDP, then dispatches drag/drop events to selector.',
        },
        triggerSelector: {
          type: 'string',
          description:
            'Optional selector for a button/control to click before looking for the file input. Useful when the page creates input[type="file"] only after clicking an upload button. Only used in fileInput mode.',
        },
        waitForInputMs: {
          type: 'number',
          description:
            'How long to wait for selector to become a file input after triggerSelector is clicked (default 3000, max 10000).',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description: 'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description:
            'Whether the input accepts multiple files (default: false). The tool will fail clearly when multiple files are requested but the target input does not allow them.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_UPLOAD_STATUS,
    description:
      'Get the latest browser-side status for a file upload attempt. Can look up by uploadId or inspect the current file input selection by selector.',
    inputSchema: {
      type: 'object',
      properties: {
        uploadId: {
          type: 'string',
          description: 'Upload session id returned by chrome_upload_file.',
        },
        selector: {
          type: 'string',
          description:
            'File input selector to inspect when uploadId is omitted or for a live re-check.',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab ID for live inspection (default: active tab or the session tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
      },
      required: ['action'],
    },
  },
];

type JsonSchemaObject = Record<string, unknown>;

function closeDeclaredObjectSchemas(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closeDeclaredObjectSchemas);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const schema = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, closeDeclaredObjectSchemas(child)]),
  ) as JsonSchemaObject;

  // Objects with declared properties are records with a fixed shape. Objects without
  // properties (for example HTTP headers and CDP params) intentionally remain free maps.
  if (
    schema.type === 'object' &&
    Object.prototype.hasOwnProperty.call(schema, 'properties') &&
    !Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')
  ) {
    schema.additionalProperties = false;
  }

  return schema;
}

export const TOOL_SCHEMAS: BrowserToolDefinition[] = RAW_TOOL_SCHEMAS.map((tool) => ({
  ...tool,
  inputSchema: closeDeclaredObjectSchemas(tool.inputSchema) as BrowserToolDefinition['inputSchema'],
}));

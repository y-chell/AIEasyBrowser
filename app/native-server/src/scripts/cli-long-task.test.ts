import { describe, expect, test } from '@jest/globals';

const runner = require('./cli-long-task.cjs') as {
  summarize: (rows: any[], records: any[], sessions: string[], since: string) => any;
  compare: (baseline: any, batched: any) => any;
  runLongTask: (samples: number) => Promise<any>;
  pngDimensions: (base64: string) => { width: number; height: number };
  frameInputOutcome: (attributes: Record<string, string>, events: any[]) => any;
};

describe('long task measurement', () => {
  test('distinguishes trusted child delivery from an observed container-only limitation', () => {
    expect(runner.frameInputOutcome({ 'data-count': '1', 'data-trusted': 'true' }, [])).toEqual({
      status: 'delivered',
      count: 1,
      trusted: true,
    });
    expect(
      runner.frameInputOutcome({ 'data-count': '0', 'data-trusted': 'false' }, [
        { target: 'cross', trusted: true },
      ]),
    ).toEqual({
      status: 'container_only',
      count: 0,
      trusted: false,
    });
    expect(() =>
      runner.frameInputOutcome({ 'data-count': '0', 'data-trusted': 'false' }, []),
    ).toThrow('without container hit evidence');
    expect(() =>
      runner.frameInputOutcome({ 'data-count': '2', 'data-trusted': 'true' }, []),
    ).toThrow('duplicate or invalid');
    expect(() =>
      runner.frameInputOutcome({ 'data-count': '1', 'data-trusted': 'false' }, []),
    ).toThrow();
  });
  test('reads actual PNG dimensions and rejects invalid screenshot bytes', () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1200, 16);
    bytes.writeUInt32BE(900, 20);
    expect(runner.pngDimensions(bytes.toString('base64'))).toEqual({ width: 1200, height: 900 });
    expect(() => runner.pngDimensions('not-png')).toThrow('invalid PNG');
  });
  test('counts only the measured tasks and one terminal transport duration per request', () => {
    const rows = [
      { command: 'fill', wallMs: 100, bytes: 200, ok: true },
      {
        command: 'click',
        wallMs: 50,
        bytes: 80,
        ok: false,
        code: 'STALE_DOCUMENT',
        phase: 'action',
        actionStatus: 'not_started',
      },
    ];
    const records = [
      {
        ts: '2026-01-01T00:00:01Z',
        event: 'tool.start',
        session: 'task',
        tool: 'chrome_fill_or_select',
        nativeRequestId: 'r1',
      },
      {
        ts: '2026-01-01T00:00:02Z',
        event: 'tool.start',
        session: 'task',
        tool: 'chrome_click_element',
        nativeRequestId: 'r2',
      },
      {
        ts: '2026-01-01T00:00:02Z',
        event: 'tool.start',
        session: 'unrelated',
        tool: 'chrome_click_element',
        nativeRequestId: 'other',
      },
      { event: 'extension.ok', nativeRequestId: 'r1', durationMs: 20 },
      { event: 'tool.ok', nativeRequestId: 'r1', durationMs: 21 },
      { event: 'extension.error', nativeRequestId: 'r2', durationMs: 5 },
      { event: 'extension.ok', nativeRequestId: 'other', durationMs: 1000 },
    ];
    expect(runner.summarize(rows, records, ['task'], '2026-01-01T00:00:00Z')).toMatchObject({
      agentEquivalentCalls: 2,
      browserToolCalls: 2,
      dispatchedActions: 2,
      confirmedActions: 1,
      jsonBytes: 280,
      coldCliWallMs: 150,
      browserRoundTripMs: 25,
      failures: [{ code: 'STALE_DOCUMENT', actionStatus: 'not_started' }],
    });
    expect(() => runner.summarize(rows, [], ['task'], '')).toThrow(
      'missing browser timing evidence',
    );
    expect(() => runner.summarize(rows, [...records, records[3]], ['task'], '')).toThrow(
      'incomplete or duplicate browser timing evidence',
    );
    expect(() =>
      runner.summarize(
        rows,
        records.filter((record) => record.event !== 'extension.error'),
        ['task'],
        '',
      ),
    ).toThrow('incomplete or duplicate browser timing evidence');
  });

  test('reports deltas without treating a changed task as an optimization', () => {
    const baseline = {
      agentEquivalentCalls: 10,
      jsonBytes: 1000,
      coldCliWallMs: 500,
      browserRoundTripMs: 100,
      confirmedActions: 7,
    };
    const batched = { ...baseline, agentEquivalentCalls: 5, jsonBytes: 500, coldCliWallMs: 300 };
    expect(runner.compare(baseline, batched).agentEquivalentCalls.delta).toBe(-5);
    expect(() => runner.compare(baseline, { ...batched, confirmedActions: 6 })).toThrow(
      'changed the number',
    );
    expect(() => runner.compare({ ...baseline, jsonBytes: 0 }, batched)).toThrow(
      'invalid comparison metric',
    );
  });

  test.each([0, -1, 1.5, 11, NaN])(
    'rejects invalid sample count %s before browser IO',
    async (count) => {
      await expect(runner.runLongTask(count)).rejects.toThrow('samples must be an integer');
    },
  );
});

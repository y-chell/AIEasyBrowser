import { z } from 'zod';

const common = {
  session: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
    .default('default'),
  timeoutMs: z.number().int().min(1).max(120_000).default(60_000),
};
const frameId = z.number().int().nonnegative();
const scanOptions = {
  limit: z.number().int().min(1).max(200).default(40),
  text: z.number().int().min(0).max(80).default(10),
  frameId: frameId.optional(),
};
const stringCondition = {
  value: z.string().min(1),
  match: z.enum(['contains', 'equals', 'regex']).default('contains'),
};

export const browserConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('element'),
      selector: z.string().min(1),
      selectorType: z.enum(['css', 'xpath']).default('css'),
      state: z.enum(['exists', 'visible', 'hidden', 'clickable']).default('visible'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z.string().min(1),
      present: z.boolean().default(true),
    })
    .strict(),
  z.object({ kind: z.literal('url'), ...stringCondition }).strict(),
  z.object({ kind: z.literal('title'), ...stringCondition }).strict(),
  z.object({ kind: z.literal('javascript'), predicate: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('networkIdle'),
      idleMs: z.number().int().min(1).max(120_000).optional(),
    })
    .strict(),
]);

export const browserActionSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('click'), ref: z.string().min(1), double: z.boolean().optional() })
    .strict(),
  z
    .object({
      op: z.literal('fill'),
      ref: z.string().min(1),
      value: z.union([z.string(), z.number().finite(), z.boolean()]),
    })
    .strict(),
  z
    .object({ op: z.literal('press'), keys: z.string().min(1), frameId: frameId.optional() })
    .strict(),
]);

export const browserCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('health'), ...common }).strict(),
  z.object({ command: z.literal('tabs'), ...common, match: z.string().optional() }).strict(),
  z
    .object({
      command: z.literal('use'),
      ...common,
      tabId: z.number().int().positive(),
      focus: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      command: z.literal('open'),
      ...common,
      url: z.string().url(),
      current: z.boolean().default(false),
      background: z.boolean().default(false),
    })
    .strict(),
  z.object({ command: z.literal('scan'), ...common, ...scanOptions }).strict(),
  z
    .object({
      command: z.literal('act'),
      ...common,
      actions: z.array(browserActionSchema).min(1).max(20),
      expect: browserConditionSchema.optional(),
      scan: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      command: z.literal('wait'),
      ...common,
      condition: browserConditionSchema,
      frameId: frameId.optional(),
      scan: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      command: z.literal('eval'),
      ...common,
      code: z.string().min(1),
      frameId: frameId.optional(),
    })
    .strict(),
  z.object({ command: z.literal('tools'), ...common, query: z.string().optional() }).strict(),
  z.object({ command: z.literal('describe'), ...common, tool: z.string().min(1) }).strict(),
  z
    .object({
      command: z.literal('call'),
      ...common,
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      command: z.literal('session'),
      ...common,
      mode: z.enum(['show', 'list', 'forget']).default('show'),
    })
    .strict(),
]);

export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type ScanOptions = Pick<
  Extract<BrowserCommand, { command: 'scan' }>,
  'limit' | 'text' | 'frameId'
>;
export type ActionStatus = 'not_started' | 'completed' | 'partial' | 'unknown';

export interface BrowserCommandResponse {
  ok: boolean;
  session?: string;
  result?: unknown;
  error?: { code: string; message: string };
  phase?: string;
  actionStatus?: ActionStatus;
  completed?: number;
  failedAction?: number;
}

export class BrowserCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function browserFailure(code: string, message: string): BrowserCommandResponse {
  return { ok: false, error: { code, message }, actionStatus: 'not_started' };
}

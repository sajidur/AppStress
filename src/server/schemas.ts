import { z } from 'zod';

const url = z
  .string()
  .trim()
  .url('Must be a valid http(s) URL')
  .refine((u) => /^https?:\/\//i.test(u), 'Must start with http:// or https://');

export const thresholdSchema = z.object({
  metric: z.enum(['avg', 'p50', 'p90', 'p95', 'p99', 'max', 'errorRate', 'rps']),
  op: z.enum(['<', '<=', '>', '>=']),
  value: z.number().finite().min(0),
  step: z.string().min(1).optional(),
});

export const settingsSchema = z
  .object({
    vus: z.number().int().min(1).max(100_000),
    rampUpSec: z.number().int().min(0).max(24 * 3600),
    mode: z.enum(['duration', 'iterations']),
    durationSec: z.number().int().min(1).max(7 * 24 * 3600),
    iterations: z.number().int().min(1).max(1_000_000),
    usersMode: z.enum(['per-vu', 'unique', 'per-iteration']),
    thinkTimeScale: z.number().min(0).max(100),
    requestTimeoutMs: z.number().int().min(100).max(600_000),
    baseUrl: z.union([url, z.literal('')]).optional(),
    variables: z.record(z.string().regex(/^[A-Za-z_][\w.]*$/, 'Invalid variable name'), z.string()).default({}),
    thresholds: z.array(thresholdSchema).max(50).default([]),
    capture: z
      .object({
        okSamples: z.number().int().min(0).max(50),
        errorSamples: z.number().int().min(0).max(200),
        bodyKb: z.number().int().min(1).max(512),
        maskSecrets: z.boolean(),
      })
      .optional(),
  })
  .strict();

export const createTestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  startUrl: url,
});

export const updateTestSchema = createTestSchema.partial();

export const buildOptionsSchema = z.object({
  userFields: z.record(z.string().min(1), z.string()).default({}),
  includeDocuments: z.boolean().default(true),
  resourceTypes: z.array(z.string().trim().toLowerCase().min(1)).min(1, 'Select at least one request type').optional(),
  domains: z.array(z.string().trim().min(1)).default([]),
  exclude: z
    .array(z.string().min(1))
    .default([])
    .refine((list) => list.every((r) => { try { new RegExp(r); return true; } catch { return false; } }), 'Invalid exclude regex'),
  minThinkMs: z.number().int().min(0).default(500),
  maxThinkMs: z.number().int().min(0).default(10_000),
  correlate: z.boolean().default(true),
  cacheLoginTtlSec: z.number().int().min(1).optional(),
  keepTracking: z.boolean().default(false),
});

const extractorSchema = z.object({
  var: z.string().regex(/^[A-Za-z_$][\w.$]*$/, 'Invalid variable name'),
  from: z.enum(['body', 'header', 'cookie', 'regex', 'status']),
  path: z.string().optional(),
  name: z.string().optional(),
  regex: z.string().optional(),
  group: z.number().int().min(0).optional(),
  optional: z.boolean().optional(),
});

const stepSchema = z.object({
  name: z.string().min(1).max(300),
  group: z.string().optional(),
  resourceType: z.string().optional(),
  sourceId: z.number().int().optional(),
  skipAuth: z.boolean().optional(),
  request: z.object({
    method: z.string().regex(/^[A-Za-z]+$/),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }),
  extract: z.array(extractorSchema).optional(),
  expect: z
    .object({
      status: z.array(z.number().int().min(100).max(599)).optional(),
      bodyContains: z.string().optional(),
    })
    .optional(),
  thinkTimeMs: z.number().min(0).optional(),
  cache: z.object({ key: z.string().min(1), ttlSec: z.number().int().min(1), vars: z.array(z.string()) }).optional(),
});

const authSchema = z
  .object({
    type: z.enum(['bearer', 'basic', 'header', 'query']),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (a.type === 'bearer') need(!!a.token?.trim(), 'Authentication: the bearer token is required');
    if (a.type === 'basic') need(!!a.username?.trim(), 'Authentication: the username is required');
    if (a.type === 'header' || a.type === 'query') {
      need(!!a.name?.trim(), 'Authentication: the header/parameter name is required');
      need(!!a.value?.trim(), 'Authentication: the value is required');
    }
  });

export const workflowSchema = z
  .object({
    name: z.string().min(1),
    variables: z.record(z.string()),
    defaults: z.object({ headers: z.record(z.string()).optional() }).optional(),
    auth: authSchema.optional(),
    setup: z.array(stepSchema),
    steps: z.array(stepSchema),
    onError: z.enum(['abortIteration', 'continue']).optional(),
  })
  .superRefine((wf, ctx) => {
    const seen = new Set<string>();
    for (const s of [...wf.setup, ...wf.steps]) {
      if (seen.has(s.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step name "${s.name}"` });
      seen.add(s.name);
    }
    for (const s of [...wf.setup, ...wf.steps]) {
      for (const e of s.extract ?? []) {
        if (e.from === 'body' && !e.path) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.name}: extractor "${e.var}" needs a JSON path` });
        if ((e.from === 'header' || e.from === 'cookie') && !e.name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.name}: extractor "${e.var}" needs a name` });
        if (e.from === 'regex') {
          try {
            new RegExp(e.regex ?? '');
          } catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.name}: extractor "${e.var}" has an invalid regex` });
          }
        }
      }
    }
  });

export const usersUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1),
});

export const harUploadSchema = z.object({ content: z.string().min(1) });

export const startRecordingSchema = z.object({
  url: url.optional(),
  timeoutSec: z.number().int().min(5).max(3600).optional(),
});

export const validateSchema = z.object({
  userIndex: z.number().int().min(0).default(0),
  iterations: z.number().int().min(1).max(5).default(1),
});

export const startRunSchema = z.object({
  triggeredBy: z.string().max(100).default('ui'),
  settings: settingsSchema.partial().optional(),
});

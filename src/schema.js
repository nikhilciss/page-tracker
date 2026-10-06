import { sanitizePageEvents } from '../shared/page-events.js';
import { z } from 'zod';

const text = z.string().max(2000);
const point = z.number().finite().min(-100000).max(100000);
const rect = z
  .object({
    x: point,
    y: point,
    width: z.number().min(0).max(100000),
    height: z.number().min(0).max(100000),
  })
  .strict();
const field = z
  .object({
    key: z.string().max(160),
    name: z.string().max(160),
    type: z.string().max(40),
    value: z.union([text, z.array(text).max(100), z.boolean()]),
    masked: z.boolean(),
  })
  .strict();
const control = field.extend({ label: z.string().max(160), rect });
const base = { t: z.number().finite().min(0).max(86400000) };
const event = z.discriminatedUnion('type', [
  z
    .object({ ...base, type: z.literal('snapshot'), rect, controls: z.array(control).max(100) })
    .strict(),
  z.object({ ...base, type: z.enum(['move', 'click']), x: point, y: point }).strict(),
  z.object({ ...base, type: z.literal('scroll'), x: point, y: point }).strict(),
  z
    .object({
      ...base,
      type: z.literal('resize'),
      width: z.number().min(0).max(100000),
      height: z.number().min(0).max(100000),
    })
    .strict(),
  z.object({ ...base, type: z.literal('input'), field }).strict(),
  z.object({ ...base, type: z.literal('submit') }).strict(),
]);
export const initSchema = z
  .object({
    page_url: z.url().max(2048),
    authorization: z.string().max(12000).optional(),
    user_name: z.string().max(160).nullable().optional(),
    user_id: z.string().max(160).nullable().optional(),
    language: z.string().max(40).optional(),
    timezone: z.string().max(80).optional(),
    referrer: z.string().max(2048).optional(),
    viewport_width: z.number().int().min(0).max(20000).optional(),
    viewport_height: z.number().int().min(0).max(20000).optional(),
  })
  .strict();
const pageEvent = z
  .object({
    type: z.number().int().min(0).max(5),
    timestamp: z.number().finite().min(0),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine(
    (event) => event.type !== 3 || [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13].includes(event.data.source),
    'Unsupported page event',
  );
export const pageSchema = z
  .object({
    format: z.literal('rrweb'),
    duration_ms: z.number().int().min(0).max(86400000),
    truncated: z.boolean(),
    events: z.array(pageEvent).min(2).max(15000),
  })
  .strict()
  .refine((page) => {
    const full = page.events.find((event) => event.type === 2);
    const meta = page.events.find((event) => event.type === 4);
    return (
      full?.data?.node?.type === 0 &&
      typeof meta?.data?.href === 'string' &&
      page.events.every(
        (event, i) =>
          i === 0 ||
          (event.timestamp >= page.events[i - 1].timestamp &&
            event.timestamp - page.events[0].timestamp <= 86400000),
      )
    );
  }, 'Invalid page timeline');
export const submissionSchema = z
  .object({
    token: z.string().max(12000),
    form_key: z.string().min(1).max(160),
    form_id: z.string().max(160),
    user_id: z.string().max(160).nullable(),
    user_name: z.string().max(160).nullable().optional(),
    duration_ms: z.number().int().min(0).max(86400000),
    page: pageSchema.optional(),
    truncated: z.boolean(),
    fields: z.array(field).max(100),
    events: z.array(event).min(1).max(2002),
  })
  .strict()
  .superRefine((value, ctx) => {
    let previous = -1;
    for (const item of value.events) {
      if (item.t < previous || item.t > value.duration_ms)
        ctx.addIssue({ code: 'custom', message: 'Invalid event order' });
      previous = item.t;
    }
    if (value.events[0]?.type !== 'snapshot' || value.events.at(-1)?.type !== 'submit') {
      ctx.addIssue({ code: 'custom', message: 'Missing lifecycle events' });
    }
  });
export const sensitivePattern =
  /pass(word|code)?|secret|token|csrf|api.?key|authorization|credit|card|cvv|cvc|ssn|social.?security|iban|routing|account.?number|one.?time|otp/i;
export function scrubField(field) {
  const masked =
    field.masked ||
    ['password', 'hidden', 'file'].includes(field.type) ||
    sensitivePattern.test(field.name);
  return { ...field, masked, value: masked ? '[REDACTED]' : field.value };
}
export function scrubSubmission(body) {
  return {
    ...body,
    ...(body.page ? { page: { ...body.page, events: sanitizePageEvents(body.page.events) } } : {}),
    fields: body.fields.map(scrubField),
    events: body.events.map((event) => {
      if (event.type === 'input') return { ...event, field: scrubField(event.field) };
      if (event.type === 'snapshot') return { ...event, controls: event.controls.map(scrubField) };
      return event;
    }),
  };
}

export const checkpointSchema = z
  .object({
    token: z.string().max(12000),
    offset: z.number().int().min(0).max(15000),
    events: z.array(pageEvent).max(15000),
    duration_ms: z.number().int().min(0).max(86400000),
    truncated: z.boolean(),
    page_title: z.string().max(300),
    user_id: z.string().max(160).nullable(),
    user_name: z.string().max(160).nullable().optional(),
    fields: z.array(field).max(100),
  })
  .strict();
export const finishSchema = z
  .object({
    token: z.string().max(12000),
    reason: z.enum(['manual', 'link', 'form', 'reload', 'pagehide', 'success']),
    previous: z
      .array(
        z
          .object({
            token: z.string().max(12000),
            expected_count: z.number().int().min(0).max(15000),
          })
          .strict(),
      )
      .max(19)
      .optional(),
    expected_count: z.number().int().min(0).max(15000),
  })
  .strict();

export const identitySchema = z
  .object({
    token: z.string().max(12000),
    user_id: z.string().max(160).nullable(),
    user_name: z.string().max(160).nullable(),
  })
  .strict();

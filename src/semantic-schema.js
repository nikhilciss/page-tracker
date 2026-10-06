import { z } from 'zod';
const id = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z0-9_:-]*$/);
const meta = z
  .object({
    tag: z
      .string()
      .max(24)
      .regex(/^[a-z0-9-]*$/)
      .optional(),
    id: id.optional(),
    classes: z.array(id).max(4).optional(),
    role: id.optional(),
    text: z.string().max(100).optional(),
    route: z
      .string()
      .max(164)
      .regex(/^#!?\/[a-zA-Z_/-]*$/)
      .optional(),
    url: z.string().max(2048).optional(),
    x: z.number().finite().min(-10000).max(100000).optional(),
    y: z.number().finite().min(-10000).max(100000).optional(),
    form: id.optional(),
    field: id.optional(),
    field_type: id.optional(),
    action: z
      .enum([
        'focus',
        'blur',
        'input_started',
        'input_completed',
        'submit_button',
        'invalid',
        'host_confirmed',
      ])
      .optional(),
    input_method: z
      .enum(['typing', 'paste', 'drop', 'replacement', 'selection', 'unknown'])
      .optional(),
    sensitive: z.boolean().optional(),
    milestone: z
      .number()
      .int()
      .refine((n) => [25, 50, 75, 90, 100].includes(n))
      .optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
    navigation: z
      .enum(['pushState', 'replaceState', 'popstate', 'hashchange', 'initial', 'resume'])
      .optional(),
    engaged_ms: z.number().int().min(0).max(15000).optional(),
    depth: z.number().min(0).max(100).optional(),
    elapsed_ms: z.number().int().min(0).max(86400000).optional(),
    partial: z.boolean().optional(),
  })
  .strict();
export const semanticBatch = z
  .object({
    token: z.string().max(12000),
    events: z
      .array(
        z
          .object({
            id: z.uuid(),
            sequence: z.number().int().min(0).max(1000000),
            timestamp_ms: z.number().int().min(0).max(9007199254740991).optional(),
            offset_ms: z.number().int().min(0).max(86400000),
            type: z.enum([
              'page_view',
              'navigation',
              'click',
              'scroll_milestone',
              'form_view',
              'form_start',
              'form_field_interaction',
              'form_submit',
              'form_validation_attempt',
              'form_success',
              'visibility_change',
              'engagement',
              'page_exit',
            ]),
            metadata: meta,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const secret =
  /pass(word|code)?|secret|token|authorization|credit|card|cvv|cvc|ssn|otp|email|phone/i;
export function safeSemanticMetadata(input, origin) {
  const result = { ...input };
  if (result.url) {
    try {
      const u = new URL(result.url, origin);
      result.url = ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : '';
    } catch {
      result.url = '';
    }
  }
  for (const key of ['id', 'form', 'field', 'role'])
    if (result[key] && secret.test(result[key])) result[key] = 'redacted';
  if (result.classes) result.classes = result.classes.filter((x) => !secret.test(x));
  // Text is never trusted merely because the browser marked it safe.
  if (
    result.text &&
    (result.sensitive || /@|\d{4}|https?:|bearer|password|secret|token/i.test(result.text))
  )
    delete result.text;
  if (result.sensitive)
    for (const key of ['text', 'id', 'classes', 'role', 'url']) delete result[key];
  return result;
}

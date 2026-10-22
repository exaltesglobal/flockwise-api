import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { ApiError } from './core/errors.js';

export { ApiError };

/** Matches the error shape in docs/API.md: { error: { code, message, fields? } }. */
export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, fields: err.fields } }, err.status as ContentfulStatusCode);
  console.error(err);
  return c.json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } }, 500);
}

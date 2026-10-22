import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Matches the error shape in docs/API.md: { error: { code, message, fields? } }. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, fields: err.fields } }, err.status);
  console.error(err);
  return c.json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } }, 500);
}

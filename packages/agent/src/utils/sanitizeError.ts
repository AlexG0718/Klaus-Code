// Sanitizes error messages before sending to clients.
// Strips internal filesystem paths and stack traces that could leak
// implementation details. Server-side logs retain the raw error.

const INTERNAL_PATHS = /\/home\/[^\s"']+|\/tmp\/[^\s"']+|\/var\/[^\s"']+/g;
const STACK_LINES = /\s+at\s+.+\(.+:\d+:\d+\)/g;

export function sanitizeErrorMessage(message: string | undefined): string {
  if (!message) return 'An internal error occurred';
  return message
    .replace(INTERNAL_PATHS, '[internal path]')
    .replace(STACK_LINES, '')
    .trim() || 'An internal error occurred';
}

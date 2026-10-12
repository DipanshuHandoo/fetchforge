/** Values available to message templates as `{name}` placeholders. */
export interface MessageContext {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  detail?: string;
  timeout?: number;
  attempts?: number;
  key?: string;
  retryAfter?: number;
  responseType?: string;
  reason?: string;
}

/** A string with `{placeholders}` or a function returning the final message. */
export type MessageTemplate = string | ((context: MessageContext) => string);

export interface Messages {
  http: MessageTemplate;
  timeout: MessageTemplate;
  totalTimeout: MessageTemplate;
  network: MessageTemplate;
  aborted: MessageTemplate;
  circuitOpen: MessageTemplate;
  parse: MessageTemplate;
  invalidUrl: MessageTemplate;
  request: MessageTemplate;
}

export const DEFAULT_MESSAGES: Readonly<Record<keyof Messages, string>> = Object.freeze({
  http: 'HTTP {status}: {detail}',
  timeout: 'Request timed out after {timeout}ms ({method} {url})',
  totalTimeout: 'Request exceeded the total time limit of {timeout}ms ({method} {url})',
  network: 'No response received from server ({method} {url}): {reason}',
  aborted: 'Request was aborted ({method} {url})',
  circuitOpen: 'Circuit breaker is open for "{key}"; retry in {retryAfter}ms ({method} {url})',
  parse: 'Failed to parse response body as {responseType} ({method} {url}): {reason}',
  invalidUrl: 'Invalid URL: {url}',
  request: 'Request failed ({method} {url}): {reason}',
});

export function formatMessage(template: MessageTemplate, context: MessageContext): string {
  if (typeof template === 'function') {
    return String(template(context));
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in context)) return match;
    const value = (context as unknown as Record<string, unknown>)[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Uses the caller's custom message when valid, otherwise the built-in default. */
export function resolveMessage(
  custom: Partial<Messages> | undefined,
  key: keyof Messages,
  context: MessageContext,
): string {
  const template = custom?.[key];
  if (template !== undefined) {
    try {
      return formatMessage(template, context);
    } catch {
      // A broken custom message must never mask the real error.
    }
  }
  return formatMessage(DEFAULT_MESSAGES[key], context);
}

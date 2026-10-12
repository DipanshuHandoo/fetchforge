import { FetchClient } from './client.ts';
import type { ClientConfig } from './types.ts';

export { FetchClient } from './client.ts';
export type { BulkItem, BulkOptions, BulkRequest, BulkResult } from './client.ts';
export {
  AbortError,
  CircuitOpenError,
  FetchForgeError,
  HttpError,
  NetworkError,
  ParseError,
  RequestError,
  TimeoutError,
  isAbortError,
  isCircuitOpenError,
  isFetchForgeError,
  isHttpError,
  isNetworkError,
  isParseError,
  isTimeoutError,
} from './errors.ts';
export type { ErrorCode, TimeoutScope } from './errors.ts';
export { DEFAULT_MESSAGES } from './messages.ts';
export type { MessageContext, MessageTemplate, Messages } from './messages.ts';
export { bearerAuth } from './plugins.ts';
export type { BearerAuthOptions } from './plugins.ts';
export type * from './types.ts';

/** Creates an independent client with its own circuits, deduplication and metrics. */
export function createClient(config: ClientConfig = {}): FetchClient {
  return new FetchClient(config);
}

/** A ready-to-use client with default settings. Use `createClient()` or `.extend()` to customise. */
export const fetchforge: FetchClient = createClient();

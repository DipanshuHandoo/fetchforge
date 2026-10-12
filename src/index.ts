import { FetchClient } from './client.ts';
import type { ClientConfig } from './types.ts';

export { FetchClient } from './client.ts';
export type { BulkItem, BulkOptions, BulkRequest, BulkResult } from './client.ts';
export {
  AbortError,
  AuthError,
  CircuitOpenError,
  FetchForgeError,
  HttpError,
  NetworkError,
  ParseError,
  QueuedError,
  RateLimitError,
  RequestError,
  TimeoutError,
  ValidationError,
  isAbortError,
  isAuthError,
  isCircuitOpenError,
  isFetchForgeError,
  isHttpError,
  isNetworkError,
  isParseError,
  isQueuedError,
  isRateLimitError,
  isTimeoutError,
  isValidationError,
} from './errors.ts';
export type { ErrorCode, TimeoutScope, ValidationIssue } from './errors.ts';
export { DEFAULT_MESSAGES } from './messages.ts';
export type { MessageContext, MessageTemplate, Messages } from './messages.ts';
export { bearerAuth } from './plugins.ts';
export type { BearerAuthOptions } from './plugins.ts';
export { logger } from './logger.ts';
export type { LoggerLike, LoggerOptions, LogLevel } from './logger.ts';
export { monitor } from './monitor.ts';
export type {
  FlushReport,
  GroupStats,
  MeterLike,
  MonitorEvent,
  MonitorOptions,
  MonitorPlugin,
  MonitorSnapshot,
} from './monitor.ts';
export { cache } from './cache.ts';
export type {
  CacheEvent,
  CacheOptions,
  CachePlugin,
  CacheSkipReason,
  CacheStats,
  RequestCacheOptions,
} from './cache.ts';
export { authRefresh } from './auth-refresh.ts';
export type { AuthRefreshContext, AuthRefreshOptions, AuthRefreshPlugin } from './auth-refresh.ts';
export { rateLimit } from './rate-limit.ts';
export type { RateLimitBucketState, RateLimitOptions, RateLimitPlugin } from './rate-limit.ts';
export { idempotency } from './idempotency.ts';
export type { IdempotencyOptions } from './idempotency.ts';
export { offlineQueue } from './offline.ts';
export type {
  OfflineDropReason,
  OfflineFlushResult,
  OfflineQueueOptions,
  OfflineQueuePlugin,
  QueuedRequest,
} from './offline.ts';
export { iterateLines, iterateNdjson, iterateSse } from './streaming.ts';
export type { ServerSentEvent, StreamSource } from './streaming.ts';
export type { Store } from './store.ts';
export type * from './types.ts';

/** Creates an independent client with its own circuits, deduplication and metrics. */
export function createClient(config: ClientConfig = {}): FetchClient {
  return new FetchClient(config);
}

/** A ready-to-use client with default settings. Use `createClient()` or `.extend()` to customise. */
export const fetchforge: FetchClient = createClient();

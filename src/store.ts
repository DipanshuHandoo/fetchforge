import type { Awaitable } from './types.ts';

/**
 * Key-value storage used by `cache()` and `offlineQueue()`. Methods may be sync or async.
 * `ttlMs` is the retention time in ms; `undefined` or `0` means keep until deleted or evicted.
 * Implementations should treat expired entries as missing.
 */
export interface Store<V = unknown> {
  get(key: string): Awaitable<V | undefined | null>;
  set(key: string, value: V, ttlMs?: number): Awaitable<unknown>;
  delete(key: string): Awaitable<unknown>;
  /** Removes every entry this store owns (scoped by its prefix/namespace). */
  clear?(): Awaitable<unknown>;
  /** Lists live keys. Needed for `cache().invalidate(RegExp | function)` and prefix invalidation. */
  keys?(): Awaitable<Iterable<string>>;
}

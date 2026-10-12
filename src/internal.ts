import type { Awaitable, HookRequest } from './types.ts';

/** Set on a HookRequest by the cache plugin: a 304 answer to this request is a result, not an HttpError. */
export const REVALIDATING: unique symbol = Symbol.for('fetchforge.revalidating');

type CachePartitionProvider = (request: HookRequest) => Awaitable<string | undefined>;
const cachePartitionProviders = new WeakMap<object, Set<CachePartitionProvider>>();
const requestResponseTypes = new WeakMap<HookRequest, string>();

export function isRevalidating(request: HookRequest): boolean {
  return (request as unknown as Record<symbol, unknown>)[REVALIDATING] === true;
}

export function setRevalidating(request: HookRequest, value: boolean): void {
  (request as unknown as Record<symbol, unknown>)[REVALIDATING] = value;
}

// Built-in beforeRequest hooks that never change who the response is for (rate limiting, request IDs,
// idempotency keys). The cache ignores them when deciding whether unknown hooks might add credentials.
const cacheNeutralHooks = new WeakSet<object>();

export function markCacheNeutral<T extends object>(hook: T): T {
  cacheNeutralHooks.add(hook);
  return hook;
}

export function isCacheNeutral(hook: unknown): boolean {
  return typeof hook === 'function' && cacheNeutralHooks.has(hook);
}

export function registerCachePartition(client: object, provider: CachePartitionProvider): void {
  let providers = cachePartitionProviders.get(client);
  if (!providers) {
    providers = new Set();
    cachePartitionProviders.set(client, providers);
  }
  providers.add(provider);
}

export function copyCachePartitions(source: object, target: object): void {
  const providers = cachePartitionProviders.get(source);
  if (providers) cachePartitionProviders.set(target, new Set(providers));
}

export function cachePartitionProviderCount(client: object): number {
  return cachePartitionProviders.get(client)?.size ?? 0;
}

export async function getCachePartitions(client: object, request: HookRequest): Promise<string[]> {
  return Promise.all(
    [...(cachePartitionProviders.get(client) ?? [])].map(async (provider) => (await provider(request)) ?? ''),
  );
}

export function setRequestResponseType(request: HookRequest, responseType: string): void {
  requestResponseTypes.set(request, responseType);
}

export function getRequestResponseType(request: HookRequest): string {
  return requestResponseTypes.get(request) ?? 'auto';
}

/** RFC 4122 v4 id; `crypto.randomUUID` needs a secure context in browsers, `getRandomValues` does not. */
export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // Insecure browser context: fall through.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Resolves with `fallback` if `promise` takes longer than `ms` (0 disables the limit). */
export function withTimeout<T>(promise: PromiseLike<T> | T, ms: number, onTimeout: () => T): Promise<T> {
  if (!ms) return Promise.resolve(promise);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

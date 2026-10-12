import {
  type BulkResult,
  type FetchResult,
  HttpError,
  type Plugin,
  createClient,
  fetchforge,
  isHttpError,
} from '@dipanshuhandoo/fetchforge';

interface User {
  id: number;
}

const plugin: Plugin = { name: 'demo', hooks: { onComplete: ({ attempts }) => void attempts } };
const client = createClient({ retry: { retries: 2, backoff: 'linear' }, circuitBreaker: true }).use(plugin);

export async function run(): Promise<number> {
  const result: FetchResult<User> = await client.get<User>('https://example.com/u');
  const id: number = result.data.id;
  const bulk: BulkResult<User> = await client.bulk<User>(['https://example.com/a'], { concurrency: 2 });
  const total: number = bulk.total;
  try {
    await fetchforge.head('https://example.com');
  } catch (error) {
    if (isHttpError(error)) return error.status;
    if (error instanceof HttpError) return error.status;
  }
  return id + total;
}

// 1.2.0 surface: plugins, schema inference and subpaths.
import {
  type CacheEvent,
  type StandardSchemaLike,
  authRefresh,
  cache,
  iterateSse,
  rateLimit,
} from '@dipanshuhandoo/fetchforge';
import { type RedisStore, memoryStore, redisStore } from '@dipanshuhandoo/fetchforge/stores';
import { type FileStore, fileStore } from '@dipanshuhandoo/fetchforge/stores/file';
import { type MockFetch, mockFetch } from '@dipanshuhandoo/fetchforge/testing';

const userSchema: StandardSchemaLike<User> = {
  '~standard': { version: 1, vendor: 'demo', validate: (value) => ({ value: value as User }) },
};
const redis: RedisStore = redisStore({ call: async () => null });
const files: FileStore<string> = fileStore<string>({ dir: '.cache' });
const mock: MockFetch = mockFetch().get('/u', { json: { id: 1 } });
const cached = cache({
  store: memoryStore({ maxEntries: 10 }),
  onEvent: (event: CacheEvent) => void event.type,
});
const typed = createClient({ fetch: mock, plugins: [cached, rateLimit({ limit: 5, interval: 1000 })] });
typed.use(authRefresh({ getToken: () => 't', refreshToken: async () => 'u' }));

export async function run2(): Promise<number> {
  const result = await typed.get('/u', { schema: userSchema });
  const id: number = result.data.id;
  const status: 'hit' | 'stale' | 'revalidated' | 'miss' | undefined = result.cache;
  for await (const event of iterateSse(await typed.get('/events', { responseType: 'stream' }))) {
    const data: string = event.data;
    void data;
  }
  await Promise.all([redis.keys(), files.keys(), cached.invalidateTag('users')]);
  return id + (status ? 1 : 0);
}

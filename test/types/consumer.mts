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

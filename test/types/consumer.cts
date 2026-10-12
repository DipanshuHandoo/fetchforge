import fetchforgeModule = require('@dipanshuhandoo/fetchforge');

const client = fetchforgeModule.createClient({ timeout: 1000 });
export const promise: Promise<fetchforgeModule.FetchResult<string>> =
  client.get<string>('https://example.com');
export const guard: boolean = fetchforgeModule.isFetchForgeError(new Error('x'));
import storesModule = require('@dipanshuhandoo/fetchforge/stores');
import testingModule = require('@dipanshuhandoo/fetchforge/testing');

export const store: storesModule.MemoryStore<number> = storesModule.memoryStore<number>();
export const mock: testingModule.MockFetch = testingModule.mockFetch();

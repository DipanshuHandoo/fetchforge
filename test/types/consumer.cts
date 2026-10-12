import fetchforgeModule = require('@dipanshuhandoo/fetchforge');

const client = fetchforgeModule.createClient({ timeout: 1000 });
export const promise: Promise<fetchforgeModule.FetchResult<string>> =
  client.get<string>('https://example.com');
export const guard: boolean = fetchforgeModule.isFetchForgeError(new Error('x'));

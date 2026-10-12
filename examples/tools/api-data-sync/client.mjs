import {
  authRefresh,
  createClient,
  idempotency,
  logger,
  monitor,
  rateLimit,
} from '@dipanshuhandoo/fetchforge';
import { httpUrl, positiveInteger } from '../_shared/runtime.mjs';

export function createSyncClients(input, signal) {
  positiveInteger(input.requestsPerSecond, 'requestsPerSecond');
  const resources = [];
  const make = (baseUrl, credentials, writes) => {
    httpUrl(baseUrl);
    const limiter = rateLimit({
      limit: input.requestsPerSecond,
      interval: 1000,
      onDelay: ({ waitMs }) => console.log('[rateLimit] wait', waitMs, 'ms'),
    });
    const stats = monitor({ retainMs: 0, onEvent: (event) => console.log('[monitor]', event.type) });
    const tokenClient = createClient({ timeout: input.timeout, retry: false });
    let token = credentials?.token;
    const auth = authRefresh({
      getToken: () => token,
      refreshToken: async ({ request }) => {
        if (!credentials?.refreshUrl || !credentials.refreshToken)
          throw new Error('Configure refresh credentials');
        console.log('[authRefresh] renewing token');
        const result = await tokenClient.post(
          httpUrl(credentials.refreshUrl),
          { refresh_token: credentials.refreshToken },
          { signal: signal ?? request.signal },
        );
        if (typeof result.data?.access_token !== 'string' || !result.data.access_token) {
          throw new Error('Token endpoint did not return access_token');
        }
        token = result.data.access_token;
      },
      onRefreshFailed: () => console.error('[authRefresh] renewal failed'),
    });
    const client = createClient({
      baseUrl,
      timeout: input.timeout,
      retry: { retries: 2, delay: 100 },
      plugins: [
        ...(token || credentials?.refreshUrl ? [auth] : []),
        limiter,
        ...(writes ? [idempotency()] : []),
        logger({ level: 'info' }),
        stats,
      ],
      hooks: {
        beforeRequest: (request) =>
          console.log('[beforeRequest]', request.method, new URL(request.url).pathname),
        beforeRetry: ({ delay }) => console.log('[beforeRetry] wait', delay, 'ms'),
        onComplete: ({ attempts }) => console.log('[onComplete] attempts', attempts),
        onHookError: (error, hook) => console.error('[hook error]', hook, error),
      },
    });
    resources.push({ client, limiter, stats, tokenClient });
    return client;
  };
  try {
    const source = make(input.sourceUrl, input.sourceAuth, false);
    const destination = make(input.destinationUrl, input.destinationAuth, true);
    return {
      source,
      destination,
      close() {
        for (const resource of resources) {
          resource.client.abortAll();
          resource.tokenClient.abortAll();
          resource.limiter.stop();
          resource.stats.stop();
        }
      },
    };
  } catch (error) {
    for (const resource of resources) {
      resource.limiter.stop();
      resource.stats.stop();
    }
    throw error;
  }
}

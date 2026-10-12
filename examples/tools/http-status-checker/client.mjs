import { cache, createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';

export function createStatusClient({ timeout = 5000 } = {}) {
  const stats = monitor({
    groupBy: 'origin',
    retainMs: 0,
    onEvent: (event) => console.log('[monitor]', event.type, event),
  });
  const responses = cache({
    methods: ['HEAD'],
    ttl: 60_000,
    respectCacheControl: false,
    // Our beforeRequest hook only logs; this public-URL example has no authentication.
    key: (request) => `${request.method} ${request.url}`,
    onEvent: (event) => console.log('[cache]', event.type, event.url),
  });
  const client = createClient({
    redirect: 'manual',
    throwHttpErrors: false,
    timeout,
    retry: { retries: 2, delay: 100, backoff: 'exponential' },
    plugins: [responses, logger({ sink: console, level: 'debug' }), stats],
    hooks: {
      beforeRequest: (request) => console.log('[beforeRequest]', request.url, 'attempt', request.attempt),
      afterResponse: (response, request) => console.log('[afterResponse]', request.url, response.status),
      beforeRetry: ({ request, delay }) => console.log('[beforeRetry]', request.url, 'wait', delay, 'ms'),
      onComplete: ({ request, attempts }) => console.log('[onComplete]', request.url, 'attempts', attempts),
      onHookError: (error, hook) => console.error('[hook error]', hook, error),
    },
  });
  return { client, stats, responses };
}

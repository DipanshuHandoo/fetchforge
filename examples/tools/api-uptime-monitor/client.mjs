import { createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';

export function createMonitorClients(input) {
  const stats = monitor({
    groupBy: ({ url }) => new URL(url).origin + new URL(url).pathname,
    retainMs: input.windowMs,
    onEvent: (event) => console.log('[monitor]', event.type),
  });
  const client = createClient({
    timeout: input.timeout,
    throwHttpErrors: false,
    retry: { retries: 1, delay: 100 },
    circuitBreaker: {
      key: ({ url }) => url,
      failureThreshold: 3,
      resetTimeout: 30_000,
    },
    plugins: [logger({ level: 'info' }), stats],
    hooks: {
      beforeRequest: (request) => console.log('[beforeRequest]', new URL(request.url).pathname),
      beforeRetry: ({ delay }) => console.log('[beforeRetry] wait', delay, 'ms'),
      onCircuitStateChange: ({ from, to }) => console.log('[circuit]', from, '->', to),
      onHookError: (error, hook) => console.error('[hook error]', hook, error),
    },
  });
  const alerts = createClient({
    timeout: input.timeout,
    retry: { retries: 1, delay: 100, methods: ['POST'] },
  });
  return {
    client,
    alerts,
    stats,
    close() {
      client.abortAll();
      alerts.abortAll();
      stats.stop();
    },
  };
}

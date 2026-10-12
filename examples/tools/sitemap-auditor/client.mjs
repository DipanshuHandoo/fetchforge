import { createClient, logger } from '@dipanshuhandoo/fetchforge';
import { createStatusClient } from '../http-status-checker/client.mjs';
import { readResponse } from './reader.mjs';

export function createAuditClients(input, signal) {
  const status = createStatusClient(input);
  const documents = createClient({
    timeout: input.timeout,
    throwHttpErrors: false,
    responseType: 'stream',
    retry: { retries: 2, delay: 100 },
    plugins: [logger({ level: 'info' })],
    middleware: async (_context, next) => {
      const result = await next();
      const data = await readResponse(result, { ...input, signal });
      if (!result.ok) throw result.error;
      return { ...result, data };
    },
    hooks: {
      beforeRetry: ({ delay }) => console.log('[beforeRetry] document, wait', delay, 'ms'),
      onHookError: (error, hook) => console.error('[hook error]', hook, error),
    },
  });
  return {
    client: status.client,
    documents,
    close() {
      documents.abortAll();
      status.client.abortAll();
      status.stats.stop();
    },
  };
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { httpUrl, positiveInteger } from '../_shared/runtime.mjs';
import { lockCheckpoint, readCheckpoint, saveCheckpoint } from './checkpoint.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function readPage(value) {
  if (
    !Array.isArray(value?.items) ||
    !('nextCursor' in value) ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor))
  ) {
    throw new Error('Expected { items: [], nextCursor: string | null }');
  }
  return value;
}

export function validateInput(input) {
  httpUrl(input.sourceUrl);
  httpUrl(input.destinationUrl);
  if (typeof input.jobId !== 'string' || !input.jobId.trim()) throw new Error('Configure a stable jobId');
  for (const key of ['pageSize', 'concurrency', 'maxPages', 'timeout', 'requestsPerSecond']) {
    positiveInteger(input[key], key);
  }
  if (typeof input.recordId !== 'function' || typeof input.transform !== 'function') {
    throw new Error('recordId and transform must be functions');
  }
  for (const [base, route] of [
    [input.sourceUrl, input.sourcePath],
    [input.destinationUrl, input.destinationPath],
  ]) {
    if (typeof route !== 'string' || !route) throw new Error('Configure sourcePath and destinationPath');
    if (new URL(httpUrl(new URL(route, base).href)).origin !== new URL(base).origin) {
      throw new Error('API routes must stay on their configured origin');
    }
  }
}

export function jobFingerprint(input) {
  return hash(
    JSON.stringify([
      input.jobId,
      input.sourceUrl,
      input.destinationUrl,
      input.sourcePath,
      input.destinationPath,
      input.pageSize,
      input.recordId.toString(),
      input.transform.toString(),
      (input.readPage ?? readPage).toString(),
    ]),
  );
}

export function prepareRecords(items, input, knownIds) {
  return items.map((record) => {
    const id = input.recordId(record);
    if (typeof id !== 'string' || !id || ['undefined', 'null'].includes(id) || knownIds.has(id)) {
      throw new Error('Missing or duplicate record identity');
    }
    knownIds.add(id);
    const transformed = input.transform(record);
    if (!transformed || typeof transformed !== 'object' || Array.isArray(transformed) || transformed.then) {
      throw new Error('transform must synchronously return a JSON object');
    }
    const body = JSON.stringify(transformed);
    const payload = body ? JSON.parse(body) : null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || body === '{}') {
      throw new Error('transform must serialize to a nonempty JSON object');
    }
    return {
      url: input.destinationPath,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      meta: {
        recordId: id,
        idempotencyKey: hash(
          JSON.stringify([input.jobId, input.destinationUrl, input.destinationPath, id, body]),
        ),
      },
    };
  });
}

export async function syncRecords(clients, input, { stateDir, signal, onPage } = {}) {
  validateInput(input);
  const dir = stateDir ?? path.join(import.meta.dirname, 'state');
  const unlock = await lockCheckpoint(dir);
  try {
    const file = path.join(dir, 'checkpoint.json');
    let checkpoint = await readCheckpoint(file, jobFingerprint(input));
    if (checkpoint.complete) return { ...checkpoint, failures: [], alreadyComplete: true };
    // Persist the initial cursor too: a partial first page must replay with this job definition.
    await saveCheckpoint(file, checkpoint);
    while (!checkpoint.complete) {
      signal?.throwIfAborted();
      if (checkpoint.pages >= input.maxPages) throw new Error('Page limit reached before completion');
      const result = await clients.source.get(input.sourcePath, {
        params: { limit: input.pageSize, cursor: checkpoint.cursor },
        schema: input.readPage ?? readPage,
        signal,
      });
      const page = readPage(result.data);
      if (page.items.length > input.pageSize) throw new Error('Source exceeded requested pageSize');
      if (
        page.nextCursor !== null &&
        (page.nextCursor === checkpoint.cursor || checkpoint.cursors.includes(page.nextCursor))
      ) {
        throw new Error('Source cursor did not advance');
      }
      const requests = prepareRecords(page.items, input, new Set(checkpoint.identities));
      console.log('[bulk]', requests.length, 'POSTs, concurrency', input.concurrency);
      const written = await clients.destination.bulk(requests, {
        concurrency: input.concurrency,
        signal,
        onProgress: ({ done, total }) => console.log('[bulk progress]', done, '/', total),
      });
      const failures = written.results
        .filter((item) => item.status !== 'fulfilled')
        .map((item) => ({
          id: item.request.meta.recordId,
          code: item.error?.code ?? 'SKIPPED',
          status: item.error?.status ?? null,
        }));
      signal?.throwIfAborted();
      if (failures.length) {
        console.error('[sync stopped]', failures.length, 'failed writes; checkpoint remains on this page');
        return { ...checkpoint, failures, complete: false };
      }
      checkpoint = {
        ...checkpoint,
        cursor: page.nextCursor,
        pages: checkpoint.pages + 1,
        records: checkpoint.records + requests.length,
        complete: page.nextCursor === null,
        cursors: [...checkpoint.cursors, ...(page.nextCursor === null ? [] : [page.nextCursor])],
        identities: [...checkpoint.identities, ...requests.map((request) => request.meta.recordId)],
      };
      await saveCheckpoint(file, checkpoint);
      console.log('[checkpoint]', checkpoint.pages, 'pages,', checkpoint.records, 'records');
      await onPage?.(checkpoint);
    }
    return { ...checkpoint, failures: [], alreadyComplete: false };
  } finally {
    await unlock();
  }
}

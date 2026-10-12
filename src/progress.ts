import type { TransferProgress } from './types.ts';
import { isStreamBody } from './utils.ts';

const CHUNK = 64 * 1024;

type Emit = (progress: TransferProgress) => void;

function counter(total: number | undefined, emit: Emit): TransformStream<Uint8Array, Uint8Array> {
  let loaded = 0;
  let last = -1;
  const report = (final: boolean) => {
    const size = final ? (total ?? loaded) : total;
    if (final && last === loaded && size === total) return;
    last = loaded;
    emit({
      loaded,
      total: size,
      percent: size ? Math.min(100, Math.round((loaded / size) * 100)) : final ? 100 : undefined,
    });
  };
  return new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      controller.enqueue(chunk);
      report(false);
    },
    flush() {
      report(true);
    },
  });
}

/** Wraps the response body so `emit` sees each chunk; status, headers, url and redirected are preserved. */
export function trackDownload(response: Response, emit: Emit): Response {
  if (!response.body) return response;
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  // A compressed body decodes to more bytes than Content-Length announces.
  const total =
    length !== null && (!encoding || encoding === 'identity') && /^\d+$/.test(length)
      ? Number(length)
      : undefined;
  const tracked = new Response(response.body.pipeThrough(counter(total, emit)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(tracked, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return tracked;
}

function fromAsyncIterable(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

/**
 * Turns any body into a byte stream that reports upload progress. Known-size bodies are serialised
 * per attempt (so FormData gets a fresh boundary that matches the returned content type).
 */
export async function trackUpload(
  body: BodyInit,
  emit: Emit,
): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null }> {
  if (isStreamBody(body)) {
    const source =
      body instanceof ReadableStream
        ? (body as ReadableStream<Uint8Array>)
        : fromAsyncIterable(body as unknown as AsyncIterable<Uint8Array>);
    return { stream: source.pipeThrough(counter(undefined, emit)), contentType: null };
  }
  const serialised = new Request('http://localhost/', { method: 'POST', body });
  const bytes = new Uint8Array(await serialised.arrayBuffer());
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      const end = Math.min(offset + CHUNK, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  return {
    stream: stream.pipeThrough(counter(bytes.byteLength, emit)),
    contentType: serialised.headers.get('content-type'),
  };
}

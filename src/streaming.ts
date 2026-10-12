import type { FetchResult } from './types.ts';

export type StreamSource =
  | ReadableStream<Uint8Array>
  | Response
  | Pick<FetchResult<unknown>, 'data' | 'response'>;

export interface ServerSentEvent {
  /** `event:` field; `'message'` when absent. */
  event: string;
  /** `data:` lines joined with `\n`. */
  data: string;
  /** Last `id:` seen on the stream (persists across events, per the SSE spec). */
  id: string | undefined;
  /** `retry:` field in ms, when sent with this event. */
  retry: number | undefined;
}

function toStream(source: StreamSource): ReadableStream<Uint8Array> {
  if (source instanceof ReadableStream) return source;
  if (source instanceof Response) {
    if (!source.body) throw new TypeError('The response has no body to iterate');
    return source.body;
  }
  if (source && typeof source === 'object' && 'data' in source) {
    if (source.data instanceof ReadableStream) return source.data as ReadableStream<Uint8Array>;
    if (source.response?.body && !source.response.bodyUsed) return source.response.body;
  }
  throw new TypeError('Expected a ReadableStream, a Response or a result fetched with responseType "stream"');
}

/** Yields each line of a text stream (UTF-8), without the line terminator. Cancels the stream on early exit. */
export async function* iterateLines(source: StreamSource): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;
  const reader = toStream(source).pipeThrough(decoder).getReader();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index = buffer.search(/\r\n|\r|\n/);
      while (index !== -1) {
        // A trailing \r may be the first half of \r\n split across chunks.
        if (buffer[index] === '\r' && index === buffer.length - 1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer.startsWith('\r\n', index) ? 2 : 1));
        yield line;
        index = buffer.search(/\r\n|\r|\n/);
      }
    }
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer !== '') yield buffer;
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Yields one parsed JSON value per non-empty line (NDJSON / JSON Lines). */
export async function* iterateNdjson<T = unknown>(source: StreamSource): AsyncGenerator<T, void, undefined> {
  for await (const line of iterateLines(source)) {
    if (line.trim() === '') continue;
    yield JSON.parse(line) as T;
  }
}

/** Parses a `text/event-stream` body into Server-Sent Events. */
export async function* iterateSse(source: StreamSource): AsyncGenerator<ServerSentEvent, void, undefined> {
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let first = true;
  for await (let line of iterateLines(source)) {
    if (first) {
      first = false;
      if (line.startsWith('\uFEFF')) line = line.slice(1);
    }
    if (line === '') {
      if (data.length > 0) yield { event: event || 'message', data: data.join('\n'), id, retry };
      event = '';
      data = [];
      retry = undefined;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  // Per the SSE spec, an event not terminated by a blank line before EOF is discarded.
}

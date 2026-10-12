import { open } from 'node:fs/promises';

export async function readLocal(file, maxBytes) {
  const handle = await open(file, 'r');
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`Document exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readResponse(result, { maxBytes, timeout, signal }) {
  const body = result.data;
  if (!body) return '';
  const reader = body.getReader();
  const deadline = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  const cancel = () => void reader.cancel(deadline.reason).catch((error) => console.error('[cancel]', error));
  deadline.addEventListener('abort', cancel, { once: true });
  try {
    deadline.throwIfAborted();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      deadline.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Document exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    deadline.removeEventListener('abort', cancel);
    await reader.cancel();
    reader.releaseLock();
  }
}

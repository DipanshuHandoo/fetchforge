export function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Shutdown requested'));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return {
    signal: controller.signal,
    stop,
    close() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Expected an HTTP(S) URL without embedded credentials');
  }
  return url.href;
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

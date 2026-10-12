import { createServer } from 'node:http';

/** Starts a tiny local API so the examples run offline. `handler(req, res, count)` receives a request counter. */
export async function startServer(handler) {
  let count = 0;
  const server = createServer((req, res) => handler(req, res, ++count));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    get count() {
      return count;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

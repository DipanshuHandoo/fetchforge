import { startServer } from '../../_server.mjs';

export async function startDemo() {
  const hits = new Map();
  const server = await startServer((req, res) => {
    const [route, id] = req.url.slice(1).split('/');
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    if (route === 'redirect' || route === 'middle') {
      res.writeHead(route === 'redirect' ? 301 : 302, {
        location: `/${route === 'redirect' ? 'middle' : 'ok'}/${id}`,
      });
    } else {
      const status = route === 'missing' ? 404 : route === 'retry' && hits.get(req.url) === 1 ? 503 : 200;
      res.writeHead(status);
    }
    res.end();
  });
  const routes = ['ok', 'redirect', 'missing', 'retry', 'ok'];
  return {
    urls: Array.from({ length: 50 }, (_, index) => `${server.url}/${routes[index % 5]}/${index}`),
    close: server.close,
  };
}

import { startServer } from '../../_server.mjs';

export async function startDemo() {
  const outbound = await startServer((_req, res) => {
    res.writeHead(404);
    res.end('broken outbound link');
  });
  const requests = [];
  let base;
  const site = await startServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/pages.xml</loc></sitemap></sitemapindex>`,
      );
    }
    if (req.url === '/pages.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(
        `<urlset>${['/page', '/redirect', '/missing'].map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`,
      );
    }
    if (req.url === '/cycle.xml') {
      return res.end(`<sitemapindex><sitemap><loc>${base}/cycle.xml</loc></sitemap></sitemapindex>`);
    }
    if (req.url === '/redirect') {
      res.writeHead(301, { location: '/page' });
      return res.end();
    }
    if (req.url === '/missing') {
      res.writeHead(404);
      return res.end('missing');
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<base href="/"><a href="missing#section">broken</a><a href="/good">good</a><a href="/good">duplicate</a><a href="${outbound.url}/broken">outbound</a><a href="mailto:x@example.com">mail</a>`,
    );
  });
  base = site.url;
  return {
    ...site,
    requests,
    input: { sitemap: `${base}/sitemap.xml`, inspectLinks: true },
    async close() {
      await site.close();
      await outbound.close();
    },
  };
}

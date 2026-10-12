import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { httpUrl, positiveInteger } from '../_shared/runtime.mjs';
import { checkBulk } from '../http-status-checker/checker.mjs';
import { readLocal } from './reader.mjs';

const require = createRequire(new URL('./dependencies/package.json', import.meta.url));
const { load } = require('cheerio');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ['url', 'sitemap'].includes(name),
});

export function parseSitemap(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DTD/entity declarations are not supported');
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`Invalid sitemap XML: ${valid.err.msg}`);
  const xml = parser.parse(text);
  const isUrlset = Object.hasOwn(xml, 'urlset');
  const isIndex = Object.hasOwn(xml, 'sitemapindex');
  if (isUrlset === isIndex) throw new Error('Expected urlset or sitemapindex');
  const root = (isUrlset ? xml.urlset : xml.sitemapindex) || {};
  const kind = isUrlset ? 'pages' : 'sitemaps';
  const entries = root[kind === 'pages' ? 'url' : 'sitemap'] ?? [];
  const locations = entries.map((entry) => {
    if (typeof entry.loc !== 'string' || !entry.loc) throw new Error('Sitemap entry has no valid loc');
    return entry.loc;
  });
  return { kind, locations };
}

export function extractLinks(html, pageUrl) {
  const $ = load(html);
  const declaredBase = $('base[href]').first().attr('href');
  const base = declaredBase ? httpUrl(new URL(declaredBase, pageUrl).href) : pageUrl;
  const links = new Set();
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href').trim();
    if (!href || href.startsWith('#')) return;
    let target;
    try {
      target = new URL(href, base);
    } catch {
      // Browsers ignore invalid hrefs; these are not HTTP requests.
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol)) return;
    target.hash = '';
    links.add(httpUrl(target.href));
  });
  return [...links];
}

export async function auditSitemap(clients, input, signal) {
  for (const key of ['maxSitemaps', 'maxPages', 'maxLinks', 'maxBytes', 'timeout']) {
    positiveInteger(input[key], key);
  }
  const first = /^https?:/i.test(input.sitemap)
    ? httpUrl(input.sitemap)
    : pathToFileURL(path.resolve(input.sitemap)).href;
  const pending = [first];
  const seen = new Set();
  const pages = new Set();
  const errors = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const location = pending.shift();
    if (seen.has(location)) {
      errors.push({ phase: 'discovery', url: location, error: 'Repeated/cyclic sitemap reference' });
      continue;
    }
    if (seen.size === input.maxSitemaps) {
      errors.push({ phase: 'discovery', url: location, error: 'Sitemap document limit reached' });
      break;
    }
    seen.add(location);
    try {
      const document = location.startsWith('file:')
        ? { data: await readLocal(fileURLToPath(location), input.maxBytes), url: location }
        : await clients.documents.get(location, { signal });
      const base = document.redirectInfo?.finalUrl ?? document.url;
      const { kind, locations } = parseSitemap(document.data);
      for (const loc of locations) {
        const resolved = new URL(loc, base).href;
        if (kind === 'sitemaps') {
          if (location.startsWith('file:') && resolved.startsWith('file:')) pending.push(resolved);
          else pending.push(httpUrl(resolved));
        } else {
          const url = new URL(httpUrl(resolved));
          url.hash = '';
          if (!pages.has(url.href) && pages.size === input.maxPages) {
            throw new Error('Page limit reached; remaining entries were not checked');
          }
          pages.add(url.href);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      errors.push({ phase: 'discovery', url: location, error: error.message });
      console.error('[discovery error]', location, error.message);
    }
  }
  const statuses = await checkBulk(clients.client, [...pages], { signal });
  signal?.throwIfAborted();
  const relationships = [];
  const targets = new Set();
  if (input.inspectLinks) {
    // Small batches bound buffered HTML; bulk() controls the actual network slots.
    for (let offset = 0; offset < statuses.length; offset += 5) {
      const batch = statuses
        .slice(offset, offset + 5)
        .filter((item) => item.finalStatus < 400 && !item.error);
      const { results } = await clients.documents.bulk(
        batch.map((item) => ({ url: item.finalUrl, method: 'GET' })),
        { concurrency: 50, signal },
      );
      for (const [index, item] of results.entries()) {
        const source = batch[index].url;
        try {
          if (item.status !== 'fulfilled') throw item.error ?? new Error('Page request skipped');
          if (!/^text\/html\b/i.test(item.result.headers['content-type'] ?? '')) continue;
          const finalUrl = item.result.redirectInfo.finalUrl;
          for (const target of extractLinks(item.result.data, finalUrl)) {
            if (relationships.length === input.maxLinks) throw new Error('Link limit reached');
            targets.add(target);
            relationships.push({
              source,
              target,
              outbound: new URL(target).origin !== new URL(finalUrl).origin,
            });
          }
        } catch (error) {
          signal?.throwIfAborted();
          errors.push({ phase: 'links', url: source, error: error.message });
          console.error('[link read error]', source, error.message);
        }
      }
      signal?.throwIfAborted();
      if (relationships.length === input.maxLinks) {
        if (offset + 5 < statuses.length) {
          errors.push({
            phase: 'links',
            url: '',
            error: 'Link limit reached; remaining pages were not read',
          });
        }
        break;
      }
    }
  }
  const checked = new Map(
    (await checkBulk(clients.client, [...targets], { signal })).map((item) => [item.url, item]),
  );
  const links = relationships.map((item) => ({ ...item, ...checked.get(item.target), url: item.target }));
  const broken = (item) => Boolean(item.error) || item.finalStatus >= 400 || item.finalStatus === null;
  return {
    pages: statuses,
    links,
    errors,
    summary: {
      sitemaps: seen.size,
      pages: statuses.length,
      links: links.length,
      brokenPages: statuses.filter(broken).length,
      brokenLinks: links.filter(broken).length,
      complete: errors.length === 0,
    },
  };
}

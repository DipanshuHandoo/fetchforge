const redirects = new Set([301, 302, 303, 307, 308]);

async function check(client, urls, bulk) {
  const records = urls.map((url) => ({
    url,
    firstStatus: null,
    finalStatus: null,
    finalUrl: url,
    chain: [],
    error: '',
  }));
  let pending = [];
  for (const record of records) {
    try {
      const url = new URL(record.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL is not HTTP(S)');
      url.hash = '';
      pending.push({ record, url: url.href });
    } catch (error) {
      record.error = error.message;
    }
  }

  // Each round checks the next hop. bulk() owns concurrency; no custom worker pool.
  while (pending.length) {
    const requests = pending.map(({ url }) => ({ url, method: 'HEAD' }));
    let results;
    if (bulk) {
      console.log(`[bulk] ${requests.length} requests, concurrency 5`);
      const summary = await client.bulk(requests, { concurrency: 5 });
      ({ results } = summary);
      console.log(
        `[bulk] done in ${summary.durationMs} ms: ${summary.fulfilled} fulfilled, ${summary.rejected} rejected`,
      );
    } else {
      try {
        results = [{ status: 'fulfilled', result: await client.head(pending[0].url) }];
      } catch (error) {
        results = [{ status: 'rejected', error }];
      }
    }
    const next = [];
    for (const [index, item] of results.entries()) {
      const { record, url } = pending[index];
      record.finalUrl = url;
      if (item.status !== 'fulfilled') {
        record.finalStatus = null;
        record.error = item.status === 'rejected' ? item.error.message : 'Request skipped';
        continue;
      }
      const { status, headers } = item.result;
      record.firstStatus ??= status;
      record.finalStatus = status;
      record.chain.push({ url, status });
      if (!redirects.has(status)) continue;
      try {
        if (!headers.location) throw new Error('Redirect has no Location header');
        const target = new URL(headers.location, url);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Redirect is not HTTP(S)');
        target.hash = '';
        if (record.chain.some((hop) => hop.url === target.href)) throw new Error('Redirect loop');
        if (record.chain.length > 10) throw new Error('More than 10 redirects');
        next.push({ record, url: target.href });
      } catch (error) {
        record.error = error.message;
      }
    }
    pending = next;
  }
  return records;
}

export async function checkUrl(client, url) {
  const [record] = await check(client, [url], false);
  return record;
}

export function checkBulk(client, urls) {
  return check(client, urls, true);
}

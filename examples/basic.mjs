import assert from 'node:assert/strict';
import { createClient, HttpError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res) => {
  if (req.url?.startsWith('/users/1')) return json(res, 200, { id: 1, name: 'Ada' });
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => json(res, 201, JSON.parse(raw)));
    return;
  }
  json(res, 404, { error: 'not found' });
});

try {
  const client = createClient({ baseUrl: api.url, timeout: 2000 });

  const user = await client.get('/users/1');
  assert.deepEqual(user.data, { id: 1, name: 'Ada' });

  const created = await client.post('/users', undefined, { json: { name: 'Grace' } });
  assert.equal(created.status, 201);

  const head = await client.head('/users/1');
  assert.equal(head.ok, true);

  try {
    await client.get('/missing');
    assert.fail('expected an HttpError');
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    console.log('Typed error:', error.message);
  }
  console.log('basic example passed');
} finally {
  await api.close();
}

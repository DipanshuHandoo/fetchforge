// Response validation: check API data against a schema at the boundary, so a contract change fails loudly
// with the exact field instead of as `undefined` deep inside the UI. Works with any Standard Schema
// library (Zod 3.24+, Valibot, ArkType) or anything with safeParse/parse. No library is needed here.
// Docs: docs/validation.md
import assert from 'node:assert/strict';
import { createClient, isValidationError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

let contractBroken = false;
const api = await startServer((req, res) => {
  if (req.url === '/users/1') {
    return json(res, 200, contractBroken ? { id: '1', email: null } : { id: 1, email: 'ada@example.com' });
  }
  json(res, 404, { error: 'not found' });
});

// A minimal Standard Schema. With Zod this is just: z.object({ id: z.number(), email: z.string() })
const User = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      const issues = [];
      if (typeof value?.id !== 'number') issues.push({ message: 'expected a number', path: ['id'] });
      if (typeof value?.email !== 'string') issues.push({ message: 'expected a string', path: ['email'] });
      return issues.length > 0 ? { issues } : { value: { ...value, email: value.email.toLowerCase() } };
    },
  },
};

// Anything with safeParse (or parse) works too, e.g. an older Zod version or a hand-written guard.
const ErrorBody = {
  safeParse: (value) =>
    typeof value?.error === 'string'
      ? { success: true, data: value }
      : { success: false, error: 'bad error body' },
};

const client = createClient({ baseUrl: api.url, retry: false });

try {
  const user = await client.get('/users/1', { schema: User });
  assert.deepEqual(user.data, { id: 1, email: 'ada@example.com' }, 'data is the schema output');

  contractBroken = true;
  const error = await client.get('/users/1', { schema: User }).catch((e) => e);
  assert.ok(isValidationError(error));
  assert.deepEqual(
    error.issues.map((issue) => issue.path?.join('.')),
    ['id', 'email'],
  );
  console.log(error.message);

  // Schemas apply to successful responses; for errors, HttpError carries the raw body.
  const missing = await client.get('/nope', { schema: ErrorBody, throwHttpErrors: false });
  assert.equal(missing.status, 404);

  console.log('validation example passed');
} finally {
  await api.close();
}

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { fileStore } from '../src/file-store.ts';
import {
  type StorageLike,
  cacheBridgeStore,
  indexedDbStore,
  memoryStore,
  redisStore,
  webStorageStore,
} from '../src/stores.ts';

class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  quota = Number.POSITIVE_INFINITY;
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    const used = [...this.map].reduce((n, [k, v]) => (k === key ? n : n + v.length), 0);
    if (used + value.length > this.quota) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** In-memory Redis subset: GET, SET [PX], DEL, SCAN with a prefix glob. */
function fakeRedis() {
  const data = new Map<string, { value: string; expires: number }>();
  const commands: string[][] = [];
  const handle = (args: string[]): unknown => {
    commands.push(args);
    const [cmd, ...rest] = args;
    const live = (key: string) => {
      const item = data.get(key);
      if (item?.expires && item.expires <= Date.now()) data.delete(key);
      return data.get(key);
    };
    switch (cmd) {
      case 'GET':
        return live(rest[0] as string)?.value ?? null;
      case 'SET':
        data.set(rest[0] as string, {
          value: rest[1] as string,
          expires: rest[2] === 'PX' ? Date.now() + Number(rest[3]) : 0,
        });
        return 'OK';
      case 'DEL':
        return rest.filter((key) => data.delete(key)).length;
      case 'SCAN': {
        const prefix = (rest[2] as string).slice(0, -1).replace(/\\(.)/g, '$1');
        const keys = [...data.keys()].filter((key) => key.startsWith(prefix) && live(key));
        // Two pages, to exercise the cursor loop.
        if (rest[0] === '0') return ['1', keys.slice(0, 1)];
        return ['0', keys.slice(1)];
      }
      default:
        throw new Error(`unsupported ${cmd}`);
    }
  };
  return { data, commands, handle };
}

test('memoryStore: LRU eviction, TTL expiry, keys, clone and validation', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const store = memoryStore<number>({ maxEntries: 2 });
  store.set('a', 1);
  store.set('b', 2);
  assert.equal(store.get('a'), 1, 'touching a makes b the least recently used');
  store.set('c', 3);
  assert.equal(store.get('b'), undefined);
  assert.deepEqual(store.keys().sort(), ['a', 'c']);
  assert.equal(store.size, 2);

  store.set('t', 9, 100);
  t.mock.timers.tick(99);
  assert.equal(store.get('t'), 9);
  t.mock.timers.tick(1);
  assert.equal(store.get('t'), undefined);
  assert.equal(store.delete('a'), false, 'a was evicted when t was added');
  assert.equal(store.delete('c'), true);
  store.clear();
  assert.equal(store.size, 0);

  const cloning = memoryStore<{ n: number }>({ clone: true });
  const value = { n: 1 };
  cloning.set('x', value);
  value.n = 2;
  const read = cloning.get('x');
  assert.deepEqual(read, { n: 1 });
  assert.notEqual(read, cloning.get('x'));
  assert.throws(() => memoryStore({ maxEntries: 0 }), /maxEntries/);
});

test('webStorageStore: prefixing, expiry, corrupt values, quota recovery and validation', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const storage = new FakeStorage();
  storage.setItem('other', 'untouched');
  const store = webStorageStore<string>(storage, { prefix: 'app:' });
  store.set('a', 'A');
  store.set('short', 'S', 50);
  assert.equal(store.get('a'), 'A');
  assert.deepEqual(store.keys().sort(), ['a', 'short']);
  t.mock.timers.tick(50);
  assert.equal(store.get('short'), undefined);
  assert.equal(storage.getItem('app:short'), null, 'expired entries are removed on read');

  storage.setItem('app:bad', '{not json');
  assert.equal(store.get('bad'), undefined);
  assert.equal(storage.getItem('app:bad'), null);

  store.set('old', 'x'.repeat(40), 10);
  t.mock.timers.tick(10);
  storage.quota = [...storage.map.values()].reduce((n, v) => n + v.length, 0);
  store.set('new', 'y', undefined);
  assert.equal(store.get('new'), 'y', 'expired entries were purged to make room');
  storage.quota = 0;
  assert.throws(() => store.set('huge', 'z'), /full/);

  store.delete('a');
  store.clear();
  assert.deepEqual([...storage.map.keys()], ['other']);
  assert.throws(() => webStorageStore({} as StorageLike), /requires a Storage/);
  assert.throws(() => webStorageStore(storage, { prefix: 1 as never }), /prefix must be a string/);
});

test('indexedDbStore: CRUD, expiry, keys, structured values, reopen after close', async (t) => {
  const indexedDB = new IDBFactory();
  const store = indexedDbStore<unknown>({ indexedDB, dbName: 'test' });
  await store.set('a', { when: new Date(5), list: new Map([[1, 2]]) });
  const value = (await store.get('a')) as { when: Date; list: Map<number, number> };
  assert.ok(value.when instanceof Date);
  assert.equal(value.list.get(1), 2);

  await store.set('t', 1, 30);
  assert.deepEqual((await store.keys()).sort(), ['a', 't']);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60 });
  assert.equal(await store.get('t'), undefined);
  assert.deepEqual(await store.keys(), ['a']);
  t.mock.timers.reset();

  store.close();
  assert.ok(await store.get('a'), 'reopens lazily after close()');
  await store.delete('a');
  assert.equal(await store.get('a'), undefined);
  await store.set('b', 2);
  await store.clear();
  assert.deepEqual(await store.keys(), []);
  store.close();
  assert.throws(() => indexedDbStore({ indexedDB: {} as IDBFactory }), /not available/);
});

test('redisStore: ioredis (call) and node-redis (sendCommand) clients', async () => {
  const io = fakeRedis();
  const viaCall = redisStore<{ n: number }>({ call: async (cmd, ...args) => io.handle([cmd, ...args]) });
  await viaCall.set('a', { n: 1 }, 1500.2);
  await viaCall.set('b', { n: 2 });
  assert.deepEqual(io.commands[0], ['SET', 'fetchforge:a', '{"n":1}', 'PX', '1501']);
  assert.deepEqual(io.commands[1], ['SET', 'fetchforge:b', '{"n":2}']);
  assert.deepEqual(await viaCall.get('a'), { n: 1 });
  assert.equal(await viaCall.get('missing'), undefined);
  assert.deepEqual((await viaCall.keys()).sort(), ['a', 'b']);
  await viaCall.delete('a');
  assert.deepEqual(await viaCall.keys(), ['b']);

  const nr = fakeRedis();
  nr.data.set('foreign', { value: '1', expires: 0 });
  const viaSend = redisStore(
    { sendCommand: async (args) => nr.handle(args) },
    { prefix: 'c*[x]:', scanCount: 2 },
  );
  await viaSend.set('k', 'v');
  assert.equal(await viaSend.get('k'), 'v');
  const scan = nr.commands.find((c) => c[0] === 'SCAN');
  await viaSend.keys();
  assert.equal(scan, undefined);
  assert.deepEqual(nr.commands.at(-1)?.slice(2), ['MATCH', 'c\\*\\[x\\]:*', 'COUNT', '2']);
  await viaSend.clear();
  assert.deepEqual([...nr.data.keys()], ['foreign']);

  await assert.rejects(redisStore({ call: async () => null }, { prefix: '' }).clear(), /refusing to clear/);
  assert.throws(() => redisStore({} as never), /ioredis or node-redis/);
});

test('cacheBridgeStore maps the Store contract onto a cache-bridge cache', async () => {
  const calls: unknown[][] = [];
  const map = new Map<string, unknown>();
  const bridge = {
    getAsync: async (key: string) => map.get(key),
    setAsync: async (key: string, value: unknown, options?: { ttl?: number }) => {
      calls.push(['set', key, options]);
      map.set(key, value);
    },
    deleteAsync: async (key: string) => map.delete(key),
    clear: () => map.clear(),
    keys: () => [...map.keys()],
    sync: async () => calls.push(['sync']),
  };
  const store = cacheBridgeStore(bridge);
  await store.set('a', 1, 999.5);
  await store.set('b', 2);
  assert.deepEqual(calls, [
    ['set', 'a', { ttl: 1000 }],
    ['set', 'b', { ttl: 0 }],
  ]);
  assert.equal(await store.get('a'), 1);
  assert.deepEqual(store.keys(), ['a', 'b']);
  await store.delete('a');
  await store.clear();
  assert.deepEqual(store.keys(), []);
  assert.deepEqual(calls.at(-1), ['sync']);
  assert.throws(() => cacheBridgeStore({ ...bridge, getAsync: undefined } as never), /missing getAsync/);
});

test('fileStore: atomic files, expiry, corrupt files, keys, clear and a missing dir', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fetchforge-store-'));
  try {
    const store = fileStore<{ n: number }>({ dir: join(dir, 'nested') });
    assert.deepEqual(await store.keys(), [], 'a missing dir is empty');
    await store.delete('nothing');
    await store.set('a', { n: 1 });
    await store.set('t', { n: 2 }, 50);
    assert.deepEqual(await store.get('a'), { n: 1 });
    assert.deepEqual((await store.keys()).sort(), ['a', 't']);
    const files = await readdir(join(dir, 'nested'));
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => /^[0-9a-f]{64}\.json$/.test(name)));

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 100 });
    assert.equal(await store.get('t'), undefined);
    await store.purgeExpired();
    assert.equal((await readdir(join(dir, 'nested'))).length, 1);
    t.mock.timers.reset();

    await writeFile(join(dir, 'nested', `${'0'.repeat(64)}.json`), 'garbage');
    assert.deepEqual(await store.keys(), ['a'], 'corrupt files are removed');
    await store.delete('a');
    assert.equal(await store.get('a'), undefined);
    await store.set('b', { n: 3 });
    await store.clear();
    assert.deepEqual(await readdir(join(dir, 'nested')), []);
    assert.throws(() => fileStore({ dir: '' }), /dir must be/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

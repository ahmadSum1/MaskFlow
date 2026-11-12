import test from 'node:test';
import assert from 'node:assert/strict';

const messages = [];
globalThis.self = { postMessage: message => messages.push(message) };
await import('../src/index-worker.js');

test('enumerates a directory in the worker and pairs files without opening them', async () => {
  const file = name => ({ name, kind: 'file', getFile: () => { throw new Error('Should not read file'); } });
  const directory = (name, children) => ({
    name, kind: 'directory',
    async *values() { yield* children; }
  });
  const root = directory('dataset', [
    directory('images', [file('a.jpg')]),
    directory('maps', [file('a.png')])
  ]);
  messages.length = 0;
  await self.onmessage({ data: { root, paths: [], previous: [], addedStart: 0, roles: [], mode: 'replace' } });
  const result = messages.at(-1);
  assert.equal(result.ignored, 0);
  assert.deepEqual(result.addedPaths, ['dataset/images/a.jpg', 'dataset/maps/a.png']);
  assert.deepEqual(result.indices, [[0, 1, -1]]);
});

test('reports directory read failures', async () => {
  messages.length = 0;
  const root = { name: 'dataset', async *values() { throw new Error('Access denied'); } };
  await self.onmessage({ data: { root, paths: [], previous: [], addedStart: 0, roles: [], mode: 'replace' } });
  assert.equal(messages.at(-1).error, 'Access denied');
});

test('collects a new mask folder without matching outside the selected base folder', async () => {
  messages.length = 0;
  await self.onmessage({ data: {
    paths: ['images/P1_8192x4096.jpg', 'masks/HEsalmap_1.png'], previous: [[0, -1]],
    addedStart: 1, roles: [false], mode: 'selected-masks'
  } });
  assert.deepEqual(messages.at(-1).indices, [[0, -1, 0], [1, -1, -1]]);
});

test('matches folder records in the worker', async () => {
  messages.length = 0;
  const base = { file: 0, path: 'images/P1_8192x4096.jpg', stem: 'p1_8192x4096', sourceId: 1 };
  const mask = { file: 1, path: 'masks/HEsalmap_1.png', stem: 'hesalmap_1', sourceId: 2 };
  await self.onmessage({ data: {
    action: 'match-folders', pairs: [{ base, mask: null }, { base: mask, mask: null }],
    groups: [{ baseFolder: { sourceId: 1, path: 'images' }, maskFolders: [{ sourceId: 2, path: 'masks' }], rule: { type: 'numeric' } }]
  } });
  assert.equal(messages.at(-1).matched, 1);
  assert.equal(messages.at(-1).pairs[0].mask.file, 1);
});

test('matches independent groups with a shared mask in the worker', async () => {
  messages.length = 0;
  const first = { file: 0, path: 'a/P1.jpg', stem: 'p1', key: 'p1', sourceId: 1 };
  const second = { file: 1, path: 'b/img-1.jpg', stem: 'img-1', key: 'img-1', sourceId: 1 };
  const mask = { file: 2, path: 'pred/HEsalmap_1.png', stem: 'hesalmap_1', key: 'hesalmap_1', sourceId: 1 };
  const folder = path => ({ sourceId: 1, path });
  await self.onmessage({ data: {
    action: 'match-folders', pairs: [first, second, mask].map(base => ({ base, mask: null })),
    groups: [
      { baseFolder: folder('a'), maskFolders: [folder('pred')], rule: { type: 'numeric' } },
      { baseFolder: folder('b'), maskFolders: [folder('pred')], rule: { type: 'regex', base: '^img-(\\d+)$', mask: '^hesalmap_(\\d+)$' } }
    ]
  } });
  assert.equal(messages.at(-1).matched, 2);
  assert.deepEqual(messages.at(-1).groupResults.map(group => group.matched), [1, 1]);
  assert.deepEqual(messages.at(-1).pairs.map(pair => [pair.base.file, pair.mask.file]), [[0, 2], [1, 2]]);
});

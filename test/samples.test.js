import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { pairFiles } from '../src/core.js';
import { loadSampleFiles } from '../src/samples.js';

globalThis.File ??= File;

test('bundled samples load as two image and ground-truth pairs', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(url), { headers: { 'content-type': 'image/png' } }));
  const files = await loadSampleFiles();
  for (const file of files) {
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer()).slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.deepEqual(pairFiles(files).map(pair => [pair.base.name, pair.mask?.name]), [
    ['im00.png', 'gt00.png'],
    ['im01.png', 'gt01.png']
  ]);
});

test('reports an unavailable sample instead of returning partial data', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Not found', { status: 404 }));
  await assert.rejects(loadSampleFiles(), /Could not fetch .*HTTP 404/);
});

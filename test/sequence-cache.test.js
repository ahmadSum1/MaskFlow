import test from 'node:test';
import assert from 'node:assert/strict';
import { SequenceFrameCache } from '../src/sequence-cache.js';

class FakeWorker {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  complete(request, value = request.frame) {
    this.onmessage({ data: { id: request.id, raster: { values: new Float64Array([value]) } } });
  }
}

const axes = { frame: 0, height: 1, width: 2, channel: null };
const requests = worker => worker.messages.filter(message => message.type === 'read');

test('prefetches upcoming frames and reuses a completed or in-flight frame', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [5, 1, 1] }, worker);
  const first = cache.getFrame(axes, 0, {});
  worker.complete(requests(worker)[0]);
  assert.equal((await first).values[0], 0);
  assert.equal(requests(worker)[1].frame, 1);
  const next = cache.getFrame(axes, 1, {});
  assert.equal(requests(worker).length, 2);
  worker.complete(requests(worker)[1]);
  assert.equal((await next).values[0], 1);
  worker.complete(requests(worker)[2]);
  assert.equal(requests(worker)[3].frame, 3);
  assert.equal((await cache.getFrame(axes, 1, {})).values[0], 1);
  assert.equal(requests(worker).length, 4);
  cache.dispose();
  assert.equal(worker.terminated, true);
});

test('invalidates cached frames and ignores cancelled reads when indices change', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [3, 1, 1, 2] }, worker);
  const first = cache.getFrame(axes, 0, { 3: 0 });
  worker.complete(requests(worker)[0], 7);
  await first;
  const oldPrefetch = requests(worker)[1];
  const changed = cache.getFrame(axes, 0, { 3: 1 });
  worker.complete(oldPrefetch, 99);
  worker.complete(requests(worker)[2], 8);
  assert.equal((await changed).values[0], 8);
  assert.equal((await cache.getFrame(axes, 0, { 3: 1 })).values[0], 8);
  cache.dispose();
});

test('cancels a pending frame when jumping and reports worker errors', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [5, 1, 1] }, worker);
  const first = cache.getFrame(axes, 0, {});
  const jumped = cache.getFrame(axes, 4, {});
  await assert.rejects(first, /cancelled/);
  worker.onmessage({ data: { id: requests(worker)[1].id, error: 'Truncated NPY data.' } });
  await assert.rejects(jumped, /Truncated NPY data/);
  const retry = cache.getFrame(axes, 4, {});
  worker.onerror({ message: 'worker unavailable' });
  await assert.rejects(retry, /worker unavailable/);
  await assert.rejects(cache.getFrame(axes, 4, {}), /worker unavailable/);
  cache.dispose();
});

test('limits prefetch for large frames and skips it when a frame exceeds the cache budget', async () => {
  for (const [width, expected] of [[4 * 1024 * 1024, 1], [13 * 1024 * 1024, 0]]) {
    const worker = new FakeWorker();
    const cache = new SequenceFrameCache({}, { shape: [4, 1, width] }, worker);
    cache.setLimit(96 * 1024 * 1024);
    const first = cache.getFrame(axes, 0, {});
    worker.complete(requests(worker)[0]);
    await first;
    assert.equal(requests(worker).length, 1 + expected);
    cache.dispose();
  }
});

test('evicts the least recently used frames to keep the cache within its byte budget', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [4, 1, 1] }, worker);
  cache.setLimit(96 * 1024 * 1024);
  const first = cache.getFrame(axes, 0, {});
  const complete = request => worker.onmessage({ data: { id: request.id, raster: { values: { byteLength: 40 * 1024 * 1024 } } } });
  complete(requests(worker)[0]);
  await first;
  complete(requests(worker)[1]);
  complete(requests(worker)[2]);
  assert.deepEqual([...cache.cache.keys()], [1, 2]);
  assert.equal(cache.bytes, 80 * 1024 * 1024);
  cache.dispose();
});

test('prefetches more frames within the limit and preserves the upcoming window during navigation', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [10, 1, 1] }, worker);
  cache.setLimit(32);
  const first = cache.getFrame(axes, 0, {});
  for (let frame = 0; frame < 4; frame++) worker.complete(requests(worker)[frame]);
  await first;
  assert.deepEqual([...cache.cache.keys()], [0, 1, 2, 3]);
  assert.equal(requests(worker).length, 4);
  await cache.getFrame(axes, 1, {});
  worker.complete(requests(worker)[4]);
  await cache.getFrame(axes, 2, {});
  worker.complete(requests(worker)[5]);
  assert.deepEqual([...cache.cache.keys()].sort((a, b) => a - b), [2, 3, 4, 5]);
  assert.equal(requests(worker).length, 6);
  cache.dispose();
});

test('applies changed limits immediately, cancels excess prefetch, and resumes when raised', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [10, 1, 1] }, worker);
  cache.setLimit(24);
  const first = cache.getFrame(axes, 0, {});
  worker.complete(requests(worker)[0]);
  worker.complete(requests(worker)[1]);
  await first;
  const stale = requests(worker)[2];
  cache.setLimit(16);
  worker.complete(stale);
  assert.deepEqual([...cache.cache.keys()], [0, 1]);
  assert.equal(requests(worker).length, 3);
  cache.setLimit(40);
  for (let i = 3; i < 6; i++) worker.complete(requests(worker)[i]);
  assert.deepEqual([...cache.cache.keys()], [0, 1, 2, 3, 4]);
  assert.equal(cache.bytes, 40);
  cache.setLimit(8);
  assert.deepEqual([...cache.cache.keys()], [0]);
  assert.equal(cache.bytes, 8);
  assert.throws(() => cache.setLimit(0), /Invalid frame cache limit/);
  cache.dispose();
});

test('does not cancel a requested frame when lowering the cache limit', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [3, 1, 1] }, worker);
  const frame = cache.getFrame(axes, 1, {});
  cache.setLimit(1);
  worker.complete(requests(worker)[0]);
  assert.equal((await frame).values[0], 1);
  assert.equal(cache.cache.size, 0);
  assert.equal(requests(worker).length, 1);
  cache.dispose();
});

test('caps the number of cached frames even when frames are tiny', async () => {
  const worker = new FakeWorker();
  const cache = new SequenceFrameCache({}, { shape: [1030, 1, 1] }, worker);
  const first = cache.getFrame(axes, 0, {});
  for (let frame = 0; frame < 1024; frame++) worker.complete(requests(worker)[frame]);
  await first;
  assert.equal(cache.cache.size, 1024);
  assert.equal(requests(worker).length, 1024);
  await cache.getFrame(axes, 1, {});
  worker.complete(requests(worker)[1024]);
  assert.equal(cache.cache.size, 1024);
  assert.equal(cache.cache.has(0), false);
  assert.equal(cache.cache.has(1024), true);
  cache.dispose();
});

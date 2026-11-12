import test from 'node:test';
import assert from 'node:assert/strict';
import { readDimensions } from '../src/dimensions.js';

const blob = bytes => new Blob([Uint8Array.from(bytes)]);

function npy(shape, version = 1) {
  const header = new TextEncoder().encode(`{'descr': '<f4', 'fortran_order': False, 'shape': (${shape}), }`);
  const prefix = new Uint8Array(version === 1 ? 10 : 12);
  prefix.set([0x93, 78, 85, 77, 80, 89, version, 0]);
  const view = new DataView(prefix.buffer);
  if (version === 1) view.setUint16(8, header.length, true);
  else view.setUint32(8, header.length, true);
  return new Blob([prefix, header]);
}

test('reads NumPy spatial dimensions without array data', async () => {
  assert.deepEqual(await readDimensions(npy('10, 20')), { width: 20, height: 10 });
  assert.deepEqual(await readDimensions(npy('3, 10, 20', 2)), { width: 20, height: 10 });
  assert.deepEqual(await readDimensions(npy('3, 10, 4', 3)), { width: 10, height: 3 });
  await assert.rejects(readDimensions(npy('2, 10, 20')), /Unsupported NPY shape/);
});

test('reads image header dimensions', async () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set([73, 72, 68, 82], 12);
  new DataView(png.buffer).setUint32(16, 512);
  new DataView(png.buffer).setUint32(20, 256);
  assert.deepEqual(await readDimensions(new Blob([png])), { width: 512, height: 256 });
  assert.deepEqual(await readDimensions(blob([71, 73, 70, 56, 57, 97, 8, 0, 9, 0])), { width: 8, height: 9 });
  assert.deepEqual(await readDimensions(blob([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 12, 0, 34, 0xff, 0xd9])), { width: 34, height: 12 });
  const bmp = new Uint8Array(26);
  bmp.set([66, 77]); new DataView(bmp.buffer).setUint32(14, 40, true);
  new DataView(bmp.buffer).setInt32(18, 30, true); new DataView(bmp.buffer).setInt32(22, -40, true);
  assert.deepEqual(await readDimensions(new Blob([bmp])), { width: 30, height: 40 });
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF'), 0); webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
  webp[24] = 9; webp[27] = 19;
  assert.deepEqual(await readDimensions(new Blob([webp])), { width: 10, height: 20 });
  await assert.rejects(readDimensions(blob([0, 1, 2, 3])), /Unsupported or invalid/);
});

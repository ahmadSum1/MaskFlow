import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSequenceAxes, openNpy, readSequenceFrame } from '../src/sequence.js';

function fixture(shape, { fortran = false } = {}) {
  const header = `{'descr': '|u1', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}), }\n`;
  const text = new TextEncoder().encode(header);
  const prefix = new Uint8Array(10);
  prefix.set([0x93, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(prefix.buffer).setUint16(8, text.length, true);
  const values = Uint8Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, index) => index);
  return new Blob([prefix, text, values]);
}

test('reads only the requested frame from a four-dimensional sequence', async () => {
  const blob = fixture([2, 2, 2, 3]);
  let bytesRead = 0;
  const file = { size: blob.size, slice(start, end) {
    const part = blob.slice(start, end);
    return { async arrayBuffer() { bytesRead += part.size; return part.arrayBuffer(); } };
  } };
  const header = await openNpy(file);
  bytesRead = 0;
  const raster = await readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 1);
  assert.equal(bytesRead, 12);
  assert.deepEqual([raster.height, raster.width, raster.channels], [2, 2, 3]);
  assert.deepEqual([...raster.values], Array.from({ length: 12 }, (_, i) => i + 12));
});

test('extracts noncontiguous five-dimensional frames and supports changing axes', async () => {
  const file = fixture([2, 2, 3, 2, 3]);
  const header = await openNpy(file);
  const raster = await readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 1, 1);
  assert.deepEqual([...raster.values], [42, 43, 44, 45, 46, 47, 60, 61, 62, 63, 64, 65]);
  const alternate = await readSequenceFrame(file, header, { frame: 0, height: 3, width: 1, channel: 4 }, 1, 2);
  assert.deepEqual([...alternate.values], [48, 49, 50, 66, 67, 68, 51, 52, 53, 69, 70, 71]);
});

test('bounds concurrent reads when extracting a noncontiguous frame', async () => {
  const blob = fixture([2, 80, 2, 2, 3]);
  let active = 0, peak = 0;
  const file = { size: blob.size, slice(start, end) {
    const part = blob.slice(start, end);
    return { async arrayBuffer() {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        return await part.arrayBuffer();
      } finally {
        active--;
      }
    } };
  } };
  const header = await openNpy(file);
  peak = 0;
  const raster = await readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 1, 1);
  assert.ok(peak <= 16);
  assert.deepEqual([...raster.values.slice(0, 6)], [198, 199, 200, 201, 202, 203]);
});

test('limits bytes in flight for larger noncontiguous blocks', async () => {
  const header = { shape: [1, 6, 2, 1048576, 1], size: 1, dataOffset: 0, fortran: false, dtype: '|u1', kind: 'u', endian: '|' };
  let activeBytes = 0, peakBytes = 0;
  const file = { slice(start, end) {
    return { async arrayBuffer() {
      const length = end - start;
      activeBytes += length;
      peakBytes = Math.max(peakBytes, activeBytes);
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        return new ArrayBuffer(length);
      } finally {
        activeBytes -= length;
      }
    } };
  } };
  const raster = await readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 1);
  assert.ok(peakBytes <= 4 * 1024 * 1024);
  assert.deepEqual([raster.width, raster.height, raster.min, raster.max], [1048576, 6, 0, 0]);
});

test('uses the video training shape as width by height and changes the clip axis', async () => {
  const axes = defaultSequenceAxes([3, 1536, 65, 768, 3]);
  assert.deepEqual(axes, { frame: 2, height: 3, width: 1, channel: 4 });
  const file = fixture([3, 4, 2, 2, 3]);
  const header = await openNpy(file);
  const first = await readSequenceFrame(file, header, axes, 1, 0);
  const third = await readSequenceFrame(file, header, axes, 1, 2);
  assert.deepEqual([third.width, third.height], [4, 2]);
  assert.deepEqual([...third.values.slice(0, 6)], [102, 103, 104, 114, 115, 116]);
  assert.notDeepEqual([...first.values], [...third.values]);
});

test('reads higher-rank arrays with multiple indexed axes', async () => {
  const file = fixture([2, 3, 2, 2, 2, 3]);
  const header = await openNpy(file);
  const axes = { frame: 0, height: 2, width: 3, channel: 5 };
  const raster = await readSequenceFrame(file, header, axes, 1, { 1: 2, 4: 1 });
  assert.deepEqual([raster.width, raster.height, raster.channels], [2, 2, 3]);
  assert.deepEqual([...raster.values], [123, 124, 125, 129, 130, 131, 135, 136, 137, 141, 142, 143]);
});

test('reads Fortran-order sequences and 3D volumes', async () => {
  const file = fixture([2, 2, 3], { fortran: true });
  const header = await openNpy(file);
  const axes = defaultSequenceAxes(header.shape);
  assert.deepEqual(axes, { frame: 0, height: 1, width: 2, channel: null });
  const raster = await readSequenceFrame(file, header, axes, 1);
  assert.deepEqual([raster.width, raster.height, raster.channels], [3, 2, 1]);
  assert.deepEqual([...raster.values], [1, 5, 9, 3, 7, 11]);
});

test('preserves finite range and alpha behavior for sequence frames', async () => {
  const header = new TextEncoder().encode("{'descr': '<f4', 'fortran_order': False, 'shape': (2, 1, 2, 4), }\n");
  const prefix = new Uint8Array([0x93, 78, 85, 77, 80, 89, 1, 0, 0, 0]);
  new DataView(prefix.buffer).setUint16(8, header.length, true);
  const values = new Float32Array([NaN, 2, 3, 100, 4, Infinity, 6, 200, 1, 1, 1, 1, 1, 1, 1, 1]);
  const file = new Blob([prefix, header, values]);
  const info = await openNpy(file);
  const raster = await readSequenceFrame(file, info, defaultSequenceAxes(info.shape), 0);
  assert.equal(raster.min, 2);
  assert.equal(raster.max, 6);
  assert.ok(Number.isNaN(raster.values[0]));
  assert.equal(raster.values[3], 100);
});

test('rejects invalid axes, indices and truncated data', async () => {
  const file = fixture([2, 2, 3, 2, 3]);
  const header = await openNpy(file);
  await assert.rejects(readSequenceFrame(file, header, { frame: 0, height: 0, width: 3, channel: 4 }, 0), /different axis/);
  await assert.rejects(readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 3), /out of range/);
  await assert.rejects(readSequenceFrame(file, header, defaultSequenceAxes(header.shape), 0, { 0: 2 }), /out of range/);
  await assert.rejects(openNpy(file.slice(0, file.size - 1)), /Truncated/);
});

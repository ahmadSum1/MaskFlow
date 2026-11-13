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

test('efficiently reads a selected RGB channel as a scalar frame', async () => {
  const blob = fixture([2, 80, 256, 3]);
  let reads = 0, bytes = 0;
  const file = { size: blob.size, slice(start, end) {
    const part = blob.slice(start, end);
    return { async arrayBuffer() { reads++; bytes += part.size; return part.arrayBuffer(); } };
  } };
  const header = await openNpy(file);
  const axes = { frame: 0, height: 1, width: 2, channel: null };
  for (let channel = 0; channel < 3; channel++) {
    reads = 0; bytes = 0;
    const raster = await readSequenceFrame(file, header, axes, 1, { 3: channel });
    assert.equal(raster.channels, 1);
    assert.equal(raster.values.length, 80 * 256);
    assert.ok(raster.values.every((value, i) => value === ((80 * 256 + i) * 3 + channel) % 256));
    assert.ok(reads <= 2, `Expected at most 2 reads, got ${reads}`);
    assert.ok(bytes <= 3 * 80 * 256);
  }
});

test('coalesces channel reads without crossing gaps between video columns', async () => {
  const blob = fixture([2, 4, 10, 6, 3]);
  let reads = 0, bytes = 0;
  const file = { size: blob.size, slice(start, end) {
    const part = blob.slice(start, end);
    return { async arrayBuffer() { reads++; bytes += part.size; return part.arrayBuffer(); } };
  } };
  const header = await openNpy(file);
  reads = 0; bytes = 0;
  const raster = await readSequenceFrame(file, header, { frame: 2, height: 3, width: 1, channel: null }, 4, { 0: 1, 4: 2 });
  assert.deepEqual([...raster.values], Array.from({ length: 24 }, (_, i) => {
    const y = Math.floor(i / 4), x = i % 4;
    return (((1 * 4 + x) * 10 + 4) * 6 * 3 + y * 3 + 2) % 256;
  }));
  assert.equal(reads, 4);
  assert.ok(bytes <= 24 * 3);
});

test('coalesces multibyte channel values without changing their byte order', async () => {
  const text = new TextEncoder().encode("{'descr': '>u2', 'fortran_order': False, 'shape': (2, 2, 3, 3), }\n");
  const prefix = new Uint8Array([0x93, 78, 85, 77, 80, 89, 1, 0, 0, 0]);
  new DataView(prefix.buffer).setUint16(8, text.length, true);
  const bytes = new Uint8Array(2 * 2 * 3 * 3 * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setUint16(i * 2, 1000 + i);
  const file = new Blob([prefix, text, bytes]);
  const header = await openNpy(file);
  const raster = await readSequenceFrame(file, header, { frame: 0, height: 1, width: 2, channel: null }, 1, { 3: 1 });
  assert.deepEqual([...raster.values], [1019, 1022, 1025, 1028, 1031, 1034]);
});

test('coalesces selected channels in Fortran-order arrays', async () => {
  const blob = fixture([3, 4, 5, 2], { fortran: true });
  let reads = 0;
  const file = { size: blob.size, slice(start, end) {
    const part = blob.slice(start, end);
    return { async arrayBuffer() { reads++; return part.arrayBuffer(); } };
  } };
  const header = await openNpy(file);
  reads = 0;
  const raster = await readSequenceFrame(file, header, { frame: 3, height: 1, width: 2, channel: null }, 1, { 0: 2 });
  assert.deepEqual([...raster.values], Array.from({ length: 20 }, (_, i) => {
    const y = Math.floor(i / 5), x = i % 5;
    return 2 + 3 * (y + 4 * (x + 5));
  }));
  assert.equal(reads, 1);
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

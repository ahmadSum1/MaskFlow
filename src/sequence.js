import { npyReader, parseNpyHeader } from './core.js';

const MAX_HEADER_BYTES = 1048576;
const MAX_CONCURRENT_READS = 16;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_COALESCED_BYTES = 256 * 1024;
const MAX_READ_AMPLIFICATION = 4;

/** Read and validate an NPY header without loading its array data. */
export async function openNpy(file) {
  const prefix = await file.slice(0, 12).arrayBuffer();
  if (prefix.byteLength < 10) throw new Error('Truncated NPY header.');
  const view = new DataView(prefix);
  const offset = view.getUint8(6) === 1 ? 10 : 12;
  if (prefix.byteLength < offset) throw new Error('Truncated NPY header.');
  const length = offset === 10 ? view.getUint16(8, true) : view.getUint32(8, true);
  if (length > MAX_HEADER_BYTES || offset + length > file.size) throw new Error('Invalid NPY header length.');
  return parseNpyHeader(await file.slice(0, offset + length).arrayBuffer(), file.size);
}

/** Return the initial frame, height, width, and optional channel axes for a sequence shape. */
export function defaultSequenceAxes(shape) {
  if (shape.length === 3) return { frame: 0, height: 1, width: 2, channel: null };
  if (shape.length === 4) return { frame: 0, height: 1, width: 2, channel: 3 };
  if (shape.length === 5) return shape[1] === 1536 && shape[2] === 65 && shape[3] === 768 && shape[4] === 3
    ? { frame: 2, height: 3, width: 1, channel: 4 }
    : { frame: 2, height: 1, width: 3, channel: 4 };
  if (shape.length > 5) {
    const channel = [1, 3, 4].includes(shape.at(-1)) ? shape.length - 1 : null;
    return channel === null
      ? { frame: 0, height: shape.length - 2, width: shape.length - 1, channel }
      : { frame: 0, height: shape.length - 3, width: shape.length - 2, channel };
  }
  throw new Error('Sequences must have at least three dimensions.');
}

/**
 * Read one frame using distinct zero-based spatial axes and fixed indices for remaining axes.
 * `cancelled` is checked between reads.
 */
export async function readSequenceFrame(file, header, axes, frame, extra = 0, cancelled = () => false) {
  const { shape, size, dataOffset, fortran } = header;
  if (shape.length < 3) throw new Error('Sequences must have at least three dimensions.');
  const { height, width, channel } = axes;
  const axisList = [axes.frame, height, width, ...(channel === null ? [] : [channel])];
  if (axisList.some(axis => !Number.isInteger(axis) || axis < 0 || axis >= shape.length) || new Set(axisList).size !== axisList.length) throw new Error('Choose a different axis for each role.');
  if (channel !== null && ![1, 3, 4].includes(shape[channel])) throw new Error('The channel axis must have length 1, 3, or 4.');
  const extraAxes = shape.map((_, axis) => axis).filter(axis => !axisList.includes(axis));
  if (!Number.isInteger(frame) || frame < 0 || frame >= shape[axes.frame]) throw new Error('Frame number is out of range.');
  const fixed = new Map([[axes.frame, frame]]);
  const extraIndices = typeof extra === 'number' ? Object.fromEntries(extraAxes.slice(0, 1).map(axis => [axis, extra])) : extra;
  for (const axis of extraAxes) {
    const index = extraIndices[axis] ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= shape[axis]) throw new Error('Extra axis index is out of range.');
    fixed.set(axis, index);
  }
  const storageAxes = shape.map((_, axis) => axis);
  if (fortran) storageAxes.reverse();
  const strides = new Map();
  let stride = 1;
  for (const axis of [...storageAxes].reverse()) {
    strides.set(axis, stride);
    stride *= shape[axis];
  }
  const fixedStorage = [...fixed.keys()].map(axis => storageAxes.indexOf(axis));
  const lastFixed = Math.max(...fixedStorage);
  const blockElements = storageAxes.slice(lastFixed + 1).reduce((n, axis) => n * shape[axis], 1);
  const leading = storageAxes.slice(0, lastFixed).filter(axis => !fixed.has(axis));
  const blocks = leading.reduce((n, axis) => n * shape[axis], 1);
  const totalBytes = blocks * blockElements * size;
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Frame is too large.');
  const data = new Uint8Array(totalBytes);
  const fixedOffset = [...fixed].reduce((n, [axis, value]) => n + value * strides.get(axis), 0);
  const blockBytes = blockElements * size;
  const step = leading.length ? strides.get(leading.at(-1)) * size : blockBytes;
  let runBlocks = leading.length ? shape[leading.at(-1)] : 1;
  for (let i = leading.length - 2; i >= 0; i--) {
    if (strides.get(leading[i]) * size !== step * runBlocks) break;
    runBlocks *= shape[leading[i]];
  }
  const groupLimit = step <= blockBytes * MAX_READ_AMPLIFICATION && blockBytes <= MAX_COALESCED_BYTES
    ? Math.floor((MAX_COALESCED_BYTES - blockBytes) / step) + 1
    : 1;
  const maxReadBytes = groupLimit > 1 ? MAX_COALESCED_BYTES : blockBytes;
  const batchSize = Math.max(1, Math.min(MAX_CONCURRENT_READS, Math.floor(MAX_BATCH_BYTES / maxReadBytes)));
  let start = 0;
  while (start < blocks) {
    if (cancelled()) throw new Error('Frame loading cancelled.');
    const batch = [];
    for (let n = 0; n < batchSize && start < blocks; n++) {
      const i = start;
      const count = Math.min(groupLimit, runBlocks - i % runBlocks, blocks - i);
      start += count;
      let index = i, element = fixedOffset;
      for (let j = leading.length - 1; j >= 0; j--) {
        const axis = leading[j];
        element += (index % shape[axis]) * strides.get(axis);
        index = Math.floor(index / shape[axis]);
      }
      const begin = dataOffset + element * size;
      const length = (count - 1) * step + blockBytes;
      batch.push(file.slice(begin, begin + length).arrayBuffer().then(buffer => {
        if (cancelled()) throw new Error('Frame loading cancelled.');
        if (buffer.byteLength !== length) throw new Error('Truncated NPY data.');
        const source = new Uint8Array(buffer);
        if (step === blockBytes || count === 1) data.set(source, i * blockBytes);
        else if (blockBytes === 1) {
          for (let j = 0; j < count; j++) data[i + j] = source[j * step];
        } else {
          for (let j = 0; j < count; j++) data.set(source.subarray(j * step, j * step + blockBytes), (i + j) * blockBytes);
        }
      }));
    }
    await Promise.all(batch);
  }
  const freeAxes = storageAxes.filter(axis => !fixed.has(axis));
  const packedStrides = new Map(freeAxes.map((axis, i) => [axis, freeAxes.slice(i + 1).reduce((n, next) => n * shape[next], 1)]));
  const read = npyReader(data.buffer, header);
  const channels = channel === null ? 1 : shape[channel], w = shape[width], h = shape[height];
  const yStride = packedStrides.get(height), xStride = packedStrides.get(width), cStride = packedStrides.get(channel);
  const values = new Float64Array(h * w * channels);
  let min = Infinity, max = -Infinity, target = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) {
    const value = read(y * yStride + x * xStride + (channel === null ? 0 : c * cStride));
    values[target++] = value;
    if (Number.isFinite(value) && (channels !== 4 || c !== 3)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (min === Infinity) throw new Error('Array contains no finite values.');
  return { width: w, height: h, channels, values, min, max, dtype: header.dtype, shape: [h, w, channels] };
}

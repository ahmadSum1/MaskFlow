import { npyReader, parseNpyHeader } from './core.js';

const MAX_HEADER_BYTES = 1048576;
const MAX_CONCURRENT_READS = 16;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

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

/** Return the initial frame, height, width, and channel axis indices for a 4D or 5D shape. */
export function defaultSequenceAxes(shape) {
  if (shape.length === 4) return { frame: 0, height: 1, width: 2, channel: 3 };
  if (shape.length === 5) return shape[1] === 1536 && shape[2] === 65 && shape[3] === 768 && shape[4] === 3
    ? { frame: 2, height: 3, width: 1, channel: 4 }
    : { frame: 2, height: 1, width: 3, channel: 4 };
  throw new Error('Sequences must have four or five dimensions.');
}

/**
 * Read one C-order frame using distinct zero-based frame, height, width and channel axes.
 * The remaining 5D axis is fixed at the zero-based extra index. `cancelled` is checked between reads.
 */
export async function readSequenceFrame(file, header, axes, frame, extra = 0, cancelled = () => false) {
  const { shape, size, dataOffset, fortran } = header;
  if (fortran) throw new Error('Fortran-order sequences are not supported.');
  if (![4, 5].includes(shape.length)) throw new Error('Sequences must have four or five dimensions.');
  const { height, width, channel } = axes;
  const axisList = [axes.frame, height, width, channel];
  if (axisList.some(axis => !Number.isInteger(axis) || axis < 0 || axis >= shape.length) || new Set(axisList).size !== 4) throw new Error('Choose a different axis for each role.');
  if (![1, 3, 4].includes(shape[channel])) throw new Error('The channel axis must have length 1, 3, or 4.');
  const extraAxis = shape.findIndex((_, axis) => !axisList.includes(axis));
  if (!Number.isInteger(frame) || frame < 0 || frame >= shape[axes.frame]) throw new Error('Frame number is out of range.');
  if (extraAxis !== -1 && (!Number.isInteger(extra) || extra < 0 || extra >= shape[extraAxis])) throw new Error('Extra axis index is out of range.');
  const fixed = new Map([[axes.frame, frame]]);
  if (extraAxis !== -1) fixed.set(extraAxis, extra);
  const strides = shape.map((_, axis) => shape.slice(axis + 1).reduce((a, b) => a * b, 1));
  const lastFixed = Math.max(...fixed.keys());
  const blockElements = strides[lastFixed];
  const leading = shape.map((_, axis) => axis).filter(axis => axis < lastFixed && !fixed.has(axis));
  const blocks = leading.reduce((n, axis) => n * shape[axis], 1);
  const totalBytes = blocks * blockElements * size;
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Frame is too large.');
  const data = new Uint8Array(totalBytes);
  const fixedOffset = [...fixed].reduce((n, [axis, value]) => n + value * strides[axis], 0);
  const blockBytes = blockElements * size;
  const batchSize = Math.max(1, Math.min(MAX_CONCURRENT_READS, Math.floor(MAX_BATCH_BYTES / blockBytes)));
  for (let start = 0; start < blocks; start += batchSize) {
    if (cancelled()) throw new Error('Frame loading cancelled.');
    const batch = [];
    for (let i = start; i < Math.min(start + batchSize, blocks); i++) {
      let index = i, element = fixedOffset;
      for (let j = leading.length - 1; j >= 0; j--) {
        const axis = leading[j];
        element += (index % shape[axis]) * strides[axis];
        index = Math.floor(index / shape[axis]);
      }
      const begin = dataOffset + element * size;
      batch.push(file.slice(begin, begin + blockBytes).arrayBuffer().then(buffer => {
        if (cancelled()) throw new Error('Frame loading cancelled.');
        if (buffer.byteLength !== blockBytes) throw new Error('Truncated NPY data.');
        data.set(new Uint8Array(buffer), i * blockBytes);
      }));
    }
    await Promise.all(batch);
  }
  const freeAxes = shape.map((_, axis) => axis).filter(axis => !fixed.has(axis));
  const packedStrides = new Map(freeAxes.map((axis, i) => [axis, freeAxes.slice(i + 1).reduce((n, next) => n * shape[next], 1)]));
  const read = npyReader(data.buffer, header);
  const channels = shape[channel], w = shape[width], h = shape[height];
  const yStride = packedStrides.get(height), xStride = packedStrides.get(width), cStride = packedStrides.get(channel);
  const values = new Float64Array(h * w * channels);
  let min = Infinity, max = -Infinity, target = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) {
    const value = read(y * yStride + x * xStride + c * cStride);
    values[target++] = value;
    if (Number.isFinite(value) && (channels !== 4 || c !== 3)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (min === Infinity) throw new Error('Array contains no finite values.');
  return { width: w, height: h, channels, values, min, max, dtype: header.dtype, shape: [h, w, channels] };
}

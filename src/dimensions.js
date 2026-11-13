import { defaultSequenceAxes } from './sequence.js';

function valid(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height)) throw new Error('Invalid dimensions');
  return { width, height };
}

function jpegDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos++] !== 0xff) throw new Error('Invalid JPEG marker');
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) return null;
    const marker = bytes[pos++];
    if (marker === 0xd9 || marker === 0xda) throw new Error('JPEG dimensions not found');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (pos + 2 > bytes.length) return null;
    const length = view.getUint16(pos);
    if (length < 2) throw new Error('Invalid JPEG segment');
    if (pos + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) throw new Error('Invalid JPEG dimensions');
      return valid(view.getUint16(pos + 5), view.getUint16(pos + 3));
    }
    pos += length;
  }
  return null;
}

export async function readDimensions(file) {
  const prefix = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const text = (start, length) => String.fromCharCode(...prefix.slice(start, start + length));
  if (prefix.length >= 24 && prefix[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') return valid(view.getUint32(16), view.getUint32(20));
  if (prefix.length >= 10 && (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a')) return valid(view.getUint16(6, true), view.getUint16(8, true));
  if (prefix.length >= 26 && text(0, 2) === 'BM') {
    return view.getUint32(14, true) === 12 ? valid(view.getUint16(18, true), view.getUint16(20, true)) : valid(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
  }
  if (prefix.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    const u24 = offset => prefix[offset] | prefix[offset + 1] << 8 | prefix[offset + 2] << 16;
    if (kind === 'VP8X') return valid(u24(24) + 1, u24(27) + 1);
    if (kind === 'VP8L' && prefix[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8 ' && prefix[23] === 0x9d && prefix[24] === 1 && prefix[25] === 0x2a) return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    throw new Error('Unsupported WebP header');
  }
  if (prefix.length >= 10 && prefix[0] === 0x93 && text(1, 5) === 'NUMPY') {
    const version = prefix[6];
    if (![1, 2, 3].includes(version) || (version !== 1 && prefix.length < 12)) throw new Error('Unsupported NPY header');
    const offset = version === 1 ? 10 : 12;
    const length = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    if (length > 1048576 || offset + length > file.size) throw new Error('Invalid NPY header length');
    const header = new TextDecoder(version === 3 ? 'utf-8' : 'latin1').decode(await file.slice(offset, offset + length).arrayBuffer());
    const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
    if (shapeText === undefined) throw new Error('Invalid NPY shape');
    const shape = shapeText.split(',').map(value => value.trim()).filter(Boolean).map(value => /^\d+$/.test(value) ? Number(value) : NaN);
    if (shape.length === 0) return valid(1, 1);
    if (shape.length === 1) return valid(shape[0], 1);
    if (shape.length >= 4) {
      const axes = defaultSequenceAxes(shape);
      return valid(shape[axes.width], shape[axes.height]);
    }
    const channelFirst = shape.length === 3 && [1, 3, 4].includes(shape[0]) && ![1, 3, 4].includes(shape[2]);
    if (shape.length === 3 && !channelFirst && ![1, 3, 4].includes(shape[2])) {
      const axes = defaultSequenceAxes(shape);
      return valid(shape[axes.width], shape[axes.height]);
    }
    if (shape.length !== 2 && !(shape.length === 3 && (channelFirst || [1, 3, 4].includes(shape[2])))) throw new Error('Unsupported NPY shape');
    return valid(channelFirst ? shape[2] : shape[1], channelFirst ? shape[1] : shape[0]);
  }
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xd8) {
    const limit = Math.min(file.size, 1048576);
    for (let size = Math.min(4096, limit); size > 0; size = Math.min(size * 2, limit)) {
      const result = jpegDimensions(new Uint8Array(await file.slice(0, size).arrayBuffer()));
      if (result) return result;
      if (size === limit) break;
    }
    throw new Error('JPEG dimensions not found within 1 MiB');
  }
  throw new Error('Unsupported or invalid image header');
}

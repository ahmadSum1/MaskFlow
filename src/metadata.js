import { readDimensions } from './dimensions.js';

async function readImageMetadata(file) {
  const dimensions = await readDimensions(file);
  return {
    type: 'image',
    width: dimensions.width,
    height: dimensions.height,
    resolution: `${dimensions.width} × ${dimensions.height} px`,
  };
}

async function readNpyMetadata(file) {
  const prefix = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const text = (start, length) => String.fromCharCode(...prefix.slice(start, start + length));

  if (!(prefix.length >= 10 && prefix[0] === 0x93 && text(1, 5) === 'NUMPY')) {
    throw new Error('Invalid NPY file');
  }

  const version = prefix[6];
  if (![1, 2, 3].includes(version) || (version !== 1 && prefix.length < 12)) {
    throw new Error('Unsupported NPY header');
  }

  const offset = version === 1 ? 10 : 12;
  const length = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);

  if (length > 1048576 || offset + length > file.size) {
    throw new Error('Invalid NPY header length');
  }

  const header = new TextDecoder(version === 3 ? 'utf-8' : 'latin1').decode(
    await file.slice(offset, offset + length).arrayBuffer()
  );

  // Parse shape
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (shapeText === undefined) throw new Error('Invalid NPY shape');
  const shape = shapeText
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => (/^\d+$/.test(value) ? Number(value) : NaN));

  // Parse dtype
  const dtypeText = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];

  const metadata = {
    type: 'array',
    shape: `(${shape.join(', ')})`,
    dtype: dtypeText || 'unknown',
    elements: shape.reduce((a, b) => a * b, 1),
  };

  // Extract spatial dimensions if available
  if (shape.length === 2) {
    metadata.dimensions = `${shape[1]} × ${shape[0]} px`;
  } else if (shape.length === 3) {
    const channelFirst = [1, 3, 4].includes(shape[0]) && ![1, 3, 4].includes(shape[2]);
    if (channelFirst) {
      metadata.dimensions = `${shape[2]} × ${shape[1]} px`;
      metadata.channels = shape[0];
    } else if ([1, 3, 4].includes(shape[2])) {
      metadata.dimensions = `${shape[1]} × ${shape[0]} px`;
      metadata.channels = shape[2];
    }
  }

  return metadata;
}

export async function extractMetadata(file) {
  if (!file) return null;

  try {
    const extension = file.name?.split('.').pop()?.toLowerCase() || '';
    const path = file.webkitRelativePath || file.relativePath || file.name || '';

    if (extension === 'npy') {
      const metadata = await readNpyMetadata(file);
      metadata.filename = path;
      return metadata;
    }

    // Try to read as image
    try {
      const metadata = await readImageMetadata(file);
      metadata.filename = path;
      return metadata;
    } catch {
      return null;
    }
  } catch (error) {
    console.error('Error extracting metadata:', error);
    return null;
  }
}

export function formatMetadata(metadata) {
  if (!metadata) return '';

  const lines = [];
  
  if (metadata.filename) {
    lines.push(`File: ${metadata.filename}`);
  }
  
  if (metadata.type === 'image') {
    lines.push(`Resolution: ${metadata.resolution}`);
  } else if (metadata.type === 'array') {
    if (metadata.dimensions) {
      lines.push(`Dimensions: ${metadata.dimensions}`);
    }
    if (metadata.channels) {
      lines.push(`Channels: ${metadata.channels}`);
    }
    lines.push(`Shape: ${metadata.shape}`);
    lines.push(`Data type: ${metadata.dtype}`);
    lines.push(`Total elements: ${metadata.elements.toLocaleString()}`);
  }

  return lines.join('\n');
}

export function formatMetadataCompact(metadata) {
  if (!metadata) return '';

  if (metadata.type === 'image') {
    return metadata.resolution;
  } else if (metadata.type === 'array') {
    const parts = [];
    if (metadata.dimensions) parts.push(metadata.dimensions);
    if (metadata.channels) parts.push(`${metadata.channels}ch`);
    parts.push(`${metadata.dtype}`);
    parts.push(`${metadata.elements.toLocaleString()} elements`);
    return parts.join(' • ');
  }

  return '';
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { extractMetadata, formatMetadata, formatMetadataCompact } from '../src/metadata.js';

globalThis.File ??= File;

test('reads PNG image metadata', async t => {
  const bytes = await readFile('./sample/set1_pngpng/im00.png');
  const file = new File([bytes], 'test.png');
  const metadata = await extractMetadata(file);
  
  assert(metadata, 'Metadata should be extracted');
  assert.equal(metadata.type, 'image');
  assert(metadata.width > 0, 'Width should be positive');
  assert(metadata.height > 0, 'Height should be positive');
  assert(metadata.resolution, 'Resolution should be present');
  assert(metadata.resolution.includes('×'), 'Resolution should include × separator');
  assert(metadata.filename, 'Filename should be present');
});

test('reads JPG image metadata', async t => {
  const bytes = await readFile('./sample/set2_imgnpy/0001.jpg');
  const file = new File([bytes], 'test.jpg');
  const metadata = await extractMetadata(file);
  
  assert(metadata, 'Metadata should be extracted');
  assert.equal(metadata.type, 'image');
  assert(metadata.width > 0, 'Width should be positive');
  assert(metadata.height > 0, 'Height should be positive');
  assert(metadata.filename, 'Filename should be present');
});

test('reads NPY array metadata', async t => {
  const bytes = await readFile('./sample/set2_imgnpy/0001_gt.npy');
  const file = new File([bytes], 'test.npy');
  const metadata = await extractMetadata(file);
  
  assert(metadata, 'Metadata should be extracted');
  assert.equal(metadata.type, 'array');
  assert(metadata.shape, 'Shape should be present');
  assert(metadata.dtype, 'Data type should be present');
  assert(metadata.elements !== undefined, 'Element count should be present');
  assert(metadata.elements > 0, 'Element count should be positive');
  assert(metadata.filename, 'Filename should be present');
});

test('formats image metadata correctly', async t => {
  const metadata = { type: 'image', width: 640, height: 480, resolution: '640 × 480 px', filename: 'path/to/image.jpg' };
  const formatted = formatMetadata(metadata);
  
  assert(formatted.includes('File:'), 'Should include File label');
  assert(formatted.includes('path/to/image.jpg'), 'Should include filename');
  assert(formatted.includes('Resolution:'), 'Should include Resolution label');
  assert(formatted.includes('640 × 480 px'), 'Should include resolution value');
});

test('formats array metadata correctly', async t => {
  const metadata = {
    type: 'array',
    shape: '(512, 512)',
    dtype: '<f4',
    elements: 262144,
    dimensions: '512 × 512 px',
    channels: 1,
    filename: 'path/to/mask.npy'
  };
  const formatted = formatMetadata(metadata);
  
  assert(formatted.includes('File:'), 'Should include File label');
  assert(formatted.includes('path/to/mask.npy'), 'Should include filename');
  assert(formatted.includes('Dimensions:'), 'Should include Dimensions label');
  assert(formatted.includes('512 × 512 px'), 'Should include dimensions value');
  assert(formatted.includes('Channels:'), 'Should include Channels label');
  assert(formatted.includes('Shape:'), 'Should include Shape label');
  assert(formatted.includes('Data type:'), 'Should include Data type label');
  assert(formatted.includes('Total elements:'), 'Should include Total elements label');
});

test('formats compact metadata for image', async t => {
  const metadata = { type: 'image', width: 640, height: 480, resolution: '640 × 480 px' };
  const formatted = formatMetadataCompact(metadata);
  
  assert.equal(formatted, '640 × 480 px');
});

test('formats compact metadata for array', async t => {
  const metadata = {
    type: 'array',
    shape: '(512, 512)',
    dtype: '<f4',
    elements: 262144,
    dimensions: '512 × 512 px',
    channels: 3
  };
  const formatted = formatMetadataCompact(metadata);
  
  assert(formatted.includes('512 × 512 px'), 'Should include dimensions');
  assert(formatted.includes('3ch'), 'Should include channel count');
  assert(formatted.includes('<f4'), 'Should include dtype');
});

test('returns null for unsupported files', async t => {
  const file = new File([new Uint8Array([1, 2, 3])], 'test.txt');
  const metadata = await extractMetadata(file);
  
  assert.equal(metadata, null, 'Should return null for unsupported file types');
});

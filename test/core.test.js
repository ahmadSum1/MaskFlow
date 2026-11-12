import test from 'node:test';
import assert from 'node:assert/strict';
import { arrayRaster, assignMask, colorAt, fileInfo, inferExampleRule, maskAlternatives, matchFolderGroups, matchFolderPairs, mergePairs, pairFiles, parseNpy, removeFolders, resolveFile } from '../src/core.js';

function npy(shape, descr, values, { fortran = false, version = 1 } = {}) {
  const header = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const prefix = version === 1 ? 10 : 12;
  const padding = (16 - (prefix + header.length + 1) % 16) % 16;
  const bytes = new TextEncoder().encode(header + ' '.repeat(padding) + '\n');
  const size = Number(descr.slice(2));
  const buffer = new ArrayBuffer(prefix + bytes.length + values.length * size);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([0x93, 78, 85, 77, 80, 89, version, 0]);
  if (version === 1) view.setUint16(8, bytes.length, true);
  else view.setUint32(8, bytes.length, true);
  new Uint8Array(buffer, prefix, bytes.length).set(bytes);
  values.forEach((value, i) => {
    const offset = prefix + bytes.length + i * size;
    if (descr[1] === 'f' && size === 4) view.setFloat32(offset, value, descr[0] !== '>');
    else if (size === 2) view.setUint16(offset, value, descr[0] !== '>');
    else view.setUint8(offset, value);
  });
  return buffer;
}

const file = path => ({ name: path.split('/').pop(), webkitRelativePath: path });

test('pairs suffixes, prefixes and same-name arrays, retaining standalone files', () => {
  const pairs = pairFiles(['data/frame_001.jpg', 'data/frame_001_mask.npy', 'data/gt_frame_002.npy', 'data/frame_002.png', 'data/third.png', 'data/third.npy', 'data/lone.npy', 'data/notes.txt'].map(file));
  assert.deepEqual(pairs.map(p => [p.base.name, p.mask?.name]), [
    ['frame_001.jpg', 'frame_001_mask.npy'],
    ['frame_002.png', 'gt_frame_002.npy'],
    ['lone.npy', undefined],
    ['third.png', 'third.npy']
  ]);
});

test('prefers same directory and does not guess ambiguous cross-folder matches', () => {
  const pairs = pairFiles(['images/a.png', 'other/a.jpg', 'images/a_mask.npy', 'masks/a_gt.npy'].map(file));
  assert.equal(pairs.find(p => p.mask?.name === 'a_mask.npy').base.path, 'images/a.png');
  assert.ok(pairs.some(p => p.base.name === 'a_gt.npy' && !p.mask));
});

test('pairs numeric image and ground-truth prefixes without separators', () => {
  const pairs = pairFiles(['set/im00.png', 'set/gt00.png', 'set/im01.png', 'set/gt01.png', 'set/im06.png', 'set/image2.png', 'set/image2_mask.npy'].map(file));
  assert.deepEqual(pairs.map(p => [p.base.name, p.mask?.name]), [
    ['im00.png', 'gt00.png'], ['im01.png', 'gt01.png'], ['im06.png', undefined], ['image2.png', 'image2_mask.npy']
  ]);
});

test('pairs same-name image masks in maps directories without guessing ambiguous bases', () => {
  const pairs = pairFiles(['SALICON/images/train/a.jpg', 'SALICON/maps/train/a.png', 'SALICON/images/train/b.jpg', 'SALICON/images/val/b.jpg', 'SALICON/maps/train/b.png'].map(file));
  assert.ok(pairs.some(pair => pair.base.path === 'SALICON/images/train/a.jpg' && pair.mask?.path === 'SALICON/maps/train/a.png'));
  assert.ok(pairs.some(pair => pair.base.path === 'SALICON/maps/train/b.png' && !pair.mask));
  assert.equal(pairs.length, 4);
});

test('uses the nearest role directory when the dataset root is named maps', () => {
  const pairs = pairFiles(['maps/images/train/a.jpg', 'maps/maps/train/a.png'].map(file));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].base.path, 'maps/images/train/a.jpg');
  assert.equal(pairs[0].mask.path, 'maps/maps/train/a.png');
});

test('pairs a large indexed dataset with separate image and map folders', () => {
  const files = [];
  for (let i = 0; i < 15000; i++) files.push(file(`data/images/train/image_${i}.jpg`), file(`data/maps/train/image_${i}.png`));
  const pairs = pairFiles(files);
  assert.equal(pairs.length, 15000);
  assert.ok(pairs.every(pair => pair.base.isImage && pair.mask?.isImage && pair.base.stem === pair.mask.stem));
});

test('adding and replacing masks preserves alternatives and isolates different bases', () => {
  const pairs = pairFiles(['set/a.png', 'set/b.png'].map(file));
  const firstMask = { name: 'gt.png', path: 'gt.png' };
  const secondMask = { name: 'prediction.npy', path: 'prediction.npy' };
  const replacement = { name: 'updated.npy', path: 'updated.npy' };
  assert.equal(assignMask(pairs, 0, firstMask, 'add'), 0);
  pairs[0].swapped = true;
  assert.equal(assignMask(pairs, 0, secondMask, 'add'), 1);
  assert.deepEqual(maskAlternatives(pairs, pairs[0]).map(item => item.mask.name), ['gt.png', 'prediction.npy']);
  assert.deepEqual(maskAlternatives(pairs, pairs[2]), []);
  assert.equal(assignMask(pairs, 1, replacement, 'replace'), 1);
  assert.deepEqual(maskAlternatives(pairs, pairs[0]).map(item => item.mask.name), ['gt.png', 'updated.npy']);
  assert.equal(pairs[0].swapped, true);
  assert.throws(() => assignMask(pairs, 2, replacement, 'replace'), /Cannot assign mask/);
});

test('merges mask folders with existing singles and pairs while keeping edits', () => {
  const existing = pairFiles(['images/a.jpg', 'images/b.jpg', 'images/b_mask.png'].map(file));
  existing[1].swapped = true;
  const merged = mergePairs(existing, ['prediction/a.png', 'prediction/b.png', 'prediction/unknown.png', 'prediction/readme.txt'].map(file), 'masks');
  assert.ok(merged.some(pair => pair.base.name === 'a.jpg' && pair.mask?.path === 'prediction/a.png'));
  assert.ok(merged.some(pair => pair.base.name === 'b.jpg' && pair.mask?.path === 'prediction/b.png'));
  assert.ok(merged.some(pair => pair.base.name === 'b.jpg' && pair.mask?.name === 'b_mask.png' && pair.swapped));
  assert.ok(merged.some(pair => pair.base.name === 'unknown.png' && pair.base.isMask && !pair.mask));
  assert.equal(merged.length, 4);
});

test('merges new datasets and earlier orphans without guessing ambiguous bases', () => {
  const existing = mergePairs([], ['predictions/a.png', 'predictions/b.png'].map(file), 'masks');
  const merged = mergePairs(existing, ['set1/images/a.jpg', 'set1/images/b.jpg', 'set2/images/b.jpg'].map(file), 'dataset');
  assert.ok(merged.some(pair => pair.base.path === 'set1/images/a.jpg' && pair.mask?.path === 'predictions/a.png'));
  assert.ok(merged.some(pair => pair.base.path === 'predictions/b.png' && pair.base.isMask && !pair.mask));
  assert.equal(merged.filter(pair => pair.base.name === 'b.jpg' && !pair.mask).length, 2);
});

test('merges a large masks folder with existing bases', () => {
  const bases = [], masks = [];
  for (let i = 0; i < 15000; i++) {
    bases.push(file(`images/image_${i}.jpg`));
    masks.push(file(`predictions/image_${i}.png`));
  }
  const merged = mergePairs(pairFiles(bases), masks, 'masks');
  assert.equal(merged.length, 15000);
  assert.ok(merged.every(pair => pair.mask && pair.base.key === pair.mask.key));
});

test('matches selected folders by numeric IDs and keeps unrelated and ambiguous items', () => {
  const info = (path, sourceId) => ({ ...fileInfo(file(path)), sourceId });
  const b1 = info('data/images/P1_8192x4096.jpg', 1), b2 = info('data/images/P2_4000x2000.jpg', 1);
  const ambiguous = info('data/images/nested/P2_3000x1500.jpg', 1);
  const masks = ['pred/HEsalmap_1.png', 'pred/1_mask.png', 'pred/HEsalmap_2.png', 'pred/HEsalmap_9.png'].map(p => info(p, 2));
  const pairs = [b1, b2, ambiguous, ...masks].map(base => ({ base, mask: null }));
  const result = matchFolderPairs(pairs, { sourceId: 1, path: 'data/images' }, [{ sourceId: 2, path: 'pred' }], { type: 'numeric' });
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 2);
  assert.deepEqual(result.pairs.filter(p => p.base.file === b1.file).map(p => p.mask.name), ['HEsalmap_1.png', '1_mask.png']);
  assert.ok(result.pairs.some(p => p.base.name === 'HEsalmap_2.png' && p.base.isMask));
  assert.ok(result.pairs.some(p => p.base.file === b2.file && !p.mask));
});

test('learns an example and pairs mixed files in the same folder without guessing ambiguous roles', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const bases = [info('data/P1_900x450.jpg'), info('data/P2_5000x2500.jpg')];
  const masks = [info('data/HEsalmap_1.png'), info('data/HEsalmap_2.png'), info('data/HEsalmap_9.png')];
  const rule = inferExampleRule(bases[0], masks[0], '1');
  const folder = { sourceId: 1, path: 'data' };
  const result = matchFolderPairs([...bases, ...masks].map(base => ({ base, mask: null })), folder, [folder], rule);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 1);
  assert.deepEqual(result.pairs.filter(p => p.mask).map(p => [p.base.name, p.mask.name]), [
    ['P1_900x450.jpg', 'HEsalmap_1.png'], ['P2_5000x2500.jpg', 'HEsalmap_2.png']
  ]);
  assert.throws(() => inferExampleRule(info('data/1_1.jpg'), masks[0], '1'), /exactly once/);
  const ambiguous = matchFolderPairs([{ base: info('data/1.png'), mask: null }], folder, [folder], { type: 'numeric' });
  assert.equal(ambiguous.matched, 0);
  assert.equal(ambiguous.pairs[0].base.isMask, false);
});

test('example rules support zero-padded numeric and alphabetic IDs', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const folder = { sourceId: 1, path: 'data' };
  const numeric = [info('data/P001_900x450.jpg'), info('data/map_1.png')];
  const result = matchFolderPairs(numeric.map(base => ({ base, mask: null })), folder, [folder], inferExampleRule(...numeric, '1'));
  assert.equal(result.matched, 1);
  const letters = [info('data/image_cat.jpg'), info('data/map_cat.png'), info('data/image_dog.jpg'), info('data/map_dog.png')];
  assert.equal(matchFolderPairs(letters.map(base => ({ base, mask: null })), folder, [folder], inferExampleRule(letters[0], letters[1], 'cat')).matched, 2);
});

test('overlapping folder matching retains existing masks and accepts additional matches once', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const base = info('data/P1_900x450.jpg'), old = info('data/old_1.png'), incoming = info('data/HEsalmap_1.png');
  const pairs = [{ base, mask: old, swapped: true }, { base: incoming, mask: null }];
  const folder = { sourceId: 1, path: 'data' };
  const rule = inferExampleRule(base, incoming, '1');
  const result = matchFolderPairs(pairs, folder, [folder], rule);
  assert.equal(result.matched, 1);
  assert.equal(result.pairs.length, 2);
  assert.equal(result.pairs[0].mask.file, old.file);
  assert.equal(result.pairs[0].swapped, true);
  assert.equal(matchFolderPairs(result.pairs, folder, [folder], rule).matched, 0);
});

test('supports regex and prefix/suffix folder matching without stealing assigned masks', () => {
  const info = (path, sourceId) => ({ ...fileInfo(file(path)), sourceId });
  const base = info('base/img-01-end.jpg', 1), mask = info('masks/gt-01-out.png', 2);
  const input = [{ base, mask: null }, { base: mask, mask: null }];
  const baseFolder = { sourceId: 1, path: 'base' }, maskFolders = [{ sourceId: 2, path: 'masks' }];
  const affixes = { type: 'affixes', basePrefix: 'img-', baseSuffix: '-end', maskPrefix: 'gt-', maskSuffix: '-out' };
  assert.equal(matchFolderPairs(input, baseFolder, maskFolders, affixes).matched, 1);
  assert.equal(matchFolderPairs(input, baseFolder, maskFolders, { type: 'regex', base: '^img-(\\d+)-end$', mask: '^gt-(\\d+)-out$' }).matched, 1);
  assert.throws(() => matchFolderPairs(input, baseFolder, maskFolders, { type: 'regex', base: '[', mask: '(.)' }), /Invalid matching expression/);
  assert.throws(() => matchFolderPairs(input, baseFolder, maskFolders, { type: 'regex', base: 'img', mask: '(.)' }), /capture/);
  const other = info('other/img-01-end.jpg', 3);
  const already = [{ base, mask: null }, { base: other, mask }];
  assert.equal(matchFolderPairs(already, baseFolder, maskFolders, affixes).matched, 0);
});

test('removing folders preserves surviving bases, masks, and alternatives', () => {
  const info = (path, sourceId) => ({ ...fileInfo(file(path)), sourceId });
  const base = info('images/a.jpg', 1), mask1 = info('masks/a.png', 2), mask2 = info('other/a.png', 3);
  const pairs = [{ base, mask: mask1, swapped: true }, { base, mask: mask2 }];
  const withoutMask = removeFolders(pairs, [{ sourceId: 2, path: 'masks' }]);
  assert.deepEqual(withoutMask.map(p => p.mask?.file), [mask2.file]);
  const withoutBase = removeFolders(pairs, [{ sourceId: 1, path: 'images' }]);
  assert.equal(withoutBase.length, 2);
  assert.ok(withoutBase.every(p => p.base.isMask && !p.mask));
  const withoutBothMasks = removeFolders(pairs, [{ sourceId: 2, path: 'masks' }, { sourceId: 3, path: 'other' }]);
  assert.equal(withoutBothMasks.length, 1);
  assert.equal(withoutBothMasks[0].base.file, base.file);
});

test('matches independent base groups with distinct rules and shared mask paths', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const a = info('data/a/P1_900x450.jpg'), b = info('data/b/img-1.jpg');
  const m = info('data/pred/HEsalmap_1.png'), m2 = info('data/pred/1_mask.png');
  const pairs = [a, b, m, m2].map(base => ({ base, mask: null }));
  const path = name => ({ sourceId: 1, path: `data/${name}` });
  const groups = [
    { baseFolder: path('a'), maskFolders: [path('pred')], rule: { type: 'numeric' } },
    { baseFolder: path('b'), maskFolders: [path('pred')], rule: { type: 'regex', base: '^img-(\\d+)$', mask: '^(?:hesalmap_)?(\\d+)(?:_mask)?$' } }
  ];
  const result = matchFolderGroups(pairs, groups);
  assert.equal(result.matched, 4);
  assert.equal(result.pairs.length, 4);
  assert.equal(result.pairs.filter(p => p.base.file === a.file).length, 2);
  assert.equal(result.pairs.filter(p => p.base.file === b.file).length, 2);
  assert.equal(new Set(result.pairs.map(p => p.mask.file)).size, 2);
  assert.deepEqual(result.groupResults.map(g => g.matched), [2, 2]);
  assert.equal(matchFolderGroups(pairs, [groups[0], groups[0]]).matched, 2);
});

test('removing a parent path keeps child folders unless explicitly requested', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const parent = info('data/base.jpg'), child = info('data/child/mask.png');
  const pairs = [{ base: parent, mask: child }];
  const folder = { sourceId: 1, path: 'data' };
  const direct = removeFolders(pairs, [folder]);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].base.file, child.file);
  assert.equal(direct[0].base.isMask, true);
  assert.deepEqual(removeFolders(pairs, [folder], true), []);
});

test('preserves a file used as a base in one group and a mask in another', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const a = info('data/a/1.jpg'), b = info('data/b/1.png');
  const pairs = [a, b].map(base => ({ base, mask: null }));
  const folder = path => ({ sourceId: 1, path: `data/${path}` });
  const result = matchFolderGroups(pairs, [
    { baseFolder: folder('a'), maskFolders: [folder('b')], rule: { type: 'default' } },
    { baseFolder: folder('b'), maskFolders: [folder('empty')], rule: { type: 'default' } }
  ]);
  assert.equal(result.matched, 1);
  assert.ok(result.pairs.some(pair => pair.base.file === a.file && pair.mask.file === b.file));
  assert.ok(result.pairs.some(pair => pair.base.file === b.file && !pair.mask && !pair.base.isMask));
});

test('removing paths does not duplicate a surviving file used as both base and mask', () => {
  const info = path => ({ ...fileInfo(file(path)), sourceId: 1 });
  const a = info('data/removed/a.jpg'), b = info('data/keep/b.jpg'), c = info('data/removed/c.png');
  const pairs = [{ base: a, mask: b }, { base: b, mask: c }];
  const result = removeFolders(pairs, [{ sourceId: 1, path: 'data/removed' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].base.file, b.file);
  assert.equal(result[0].mask, null);
});

test('resolves folder handles lazily and propagates file access errors', async () => {
  const actual = { name: 'image.png' };
  let reads = 0;
  const entry = { handle: { getFile: async () => { reads++; return actual; } } };
  assert.equal(reads, 0);
  assert.equal(await resolveFile(entry), actual);
  assert.equal(reads, 1);
  assert.equal(await resolveFile(actual), actual);
  const rootHandle = { getDirectoryHandle: async part => {
    assert.equal(part, 'images');
    return { getFileHandle: async name => {
      assert.equal(name, 'image.png');
      return { getFile: async () => actual };
    } };
  } };
  assert.equal(await resolveFile({ rootHandle, relativePath: 'dataset/images/image.png' }), actual);
  await assert.rejects(resolveFile({ handle: { getFile: async () => { throw new Error('Permission denied'); } } }), /Permission denied/);
});

test('decodes big-endian floats and Fortran-order arrays', () => {
  const array = parseNpy(npy([2, 3], '>f4', [1, 4, 2, 5, 3, 6], { fortran: true, version: 2 }));
  const raster = arrayRaster(array);
  assert.deepEqual(Array.from(raster.values), [1, 2, 3, 4, 5, 6]);
  assert.equal(raster.min, 1);
  assert.equal(raster.max, 6);
});

test('decodes channel-first arrays in both storage orders', () => {
  const cOrder = arrayRaster(parseNpy(npy([1, 2, 5], '|u1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
  assert.deepEqual([cOrder.width, cOrder.height, cOrder.channels], [5, 2, 1]);
  assert.deepEqual(Array.from(cOrder.values), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const fOrder = arrayRaster(parseNpy(npy([3, 1, 5], '|u1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], { fortran: true })));
  assert.deepEqual(Array.from(fOrder.values), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('decodes float16 and excludes non-finite values from range', () => {
  const raster = arrayRaster(parseNpy(npy([2, 2], '<f2', [0x3c00, 0xc000, 0x7e00, 0x7c00])));
  assert.equal(raster.values[0], 1);
  assert.equal(raster.values[1], -2);
  assert.ok(Number.isNaN(raster.values[2]));
  assert.equal(raster.min, -2);
  assert.equal(raster.max, 1);
});

test('reports malformed data and unsupported shapes and dtypes', () => {
  assert.throws(() => parseNpy(new ArrayBuffer(4)), /valid NumPy/);
  assert.throws(() => parseNpy(npy([2, 2], '|u1', [1, 2])), /Truncated/);
  assert.throws(() => arrayRaster(parseNpy(npy([4], '|u1', [1, 2, 3, 4]))), /Unsupported array shape/);
  assert.throws(() => parseNpy(npy([1, 1], '<c8', [1])), /Unsupported NumPy dtype/);
});

test('color scales include endpoints and clamp values', () => {
  assert.deepEqual(colorAt('gray', -1), [0, 0, 0]);
  assert.deepEqual(colorAt('gray', 2), [255, 255, 255]);
  assert.deepEqual(colorAt('viridis', 0), [68, 1, 84]);
});

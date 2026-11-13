const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']);
const MASK_WORD = /(?:^|[_\-. ])(?:mask|masks|gt|groundtruth|ground_truth|seg|segmentation|label|labels)(?=$|[_\-. ])/gi;
const MASK_DIRECTORY = /^(?:mask|masks|map|maps|gt|groundtruth|ground_truth|segmentation|label|labels)$/i;
const IMAGE_DIRECTORY = /^(?:image|images|img|imgs)$/i;
const comparePaths = new Intl.Collator(undefined, { numeric: true }).compare;

export async function resolveFile(file) {
  if (file.rootHandle) {
    const parts = file.relativePath.split('/').slice(1);
    const name = parts.pop();
    let directory = file.rootHandle;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return (await directory.getFileHandle(name)).getFile();
  }
  return file.handle ? file.handle.getFile() : file;
}

export function fileInfo(file) {
  const path = (file.webkitRelativePath || file.relativePath || file.name).replaceAll('\\', '/');
  const name = path.split('/').pop();
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  const stem = dot < 0 ? name : name.slice(0, dot);
  const maskStem = stem.replace(MASK_WORD, '_').replace(/^(?:mask|gt|seg|label)(?=\d+$)/i, '').replace(/^[_\-. ]+|[_\-. ]+$/g, '').toLowerCase();
  const roleDirectory = path.split('/').slice(0, -1).reverse().find(part => MASK_DIRECTORY.test(part) || IMAGE_DIRECTORY.test(part));
  const isMask = maskStem !== stem.toLowerCase() || (roleDirectory !== undefined && MASK_DIRECTORY.test(roleDirectory));
  const key = maskStem.replace(/^(?:im|image)(?=\d+$)/i, '');
  return { file, path, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')).toLowerCase() : '', name, stem: stem.toLowerCase(), key, extension, isMask, isNpy: extension === 'npy', isImage: IMAGE_EXTENSIONS.has(extension) };
}

export function pairFiles(files) {
  const all = Array.from(files, fileInfo).filter(item => item.key && (item.isNpy || item.isImage)).sort((a, b) => comparePaths(a.path, b.path));
  const bases = all.filter(item => !item.isMask);
  const masks = all.filter(item => item.isMask);
  const used = new Set();
  const pairs = [];
  function makeIndex(items, keyOf) {
    const index = new Map();
    for (const item of items) {
      const key = keyOf(item);
      let group = index.get(key);
      if (!group) { group = { count: 0, first: item, dirs: new Map() }; index.set(key, group); }
      group.count++;
      let dir = group.dirs.get(item.dir);
      if (!dir) { dir = { first: item, image: null }; group.dirs.set(item.dir, dir); }
      if (item.isImage && !dir.image) dir.image = item;
    }
    return index;
  }
  function chooseBase(mask, group) {
    if (!group) return null;
    const dir = group.dirs.get(mask.dir);
    if (dir) return dir.image || dir.first;
    return group.count === 1 ? group.first : null;
  }
  const basesByKey = makeIndex(bases, item => item.key);
  const imagesByStem = makeIndex(bases.filter(item => item.isImage), item => item.stem);
  for (const mask of masks) {
    const base = chooseBase(mask, basesByKey.get(mask.key));
    if (base) {
      pairs.push({ base, mask });
      used.add(base);
      used.add(mask);
    }
  }
  for (const array of bases.filter(item => item.isNpy && !used.has(item))) {
    const image = chooseBase(array, imagesByStem.get(array.stem));
    if (image) {
      pairs.push({ base: image, mask: array });
      used.add(image);
      used.add(array);
    }
  }
  for (const item of all) if (!used.has(item)) pairs.push({ base: item, mask: null });
  return pairs.sort((a, b) => comparePaths(a.base.path, b.base.path) || comparePaths(a.mask?.path || '', b.mask?.path || ''));
}

export function mergePairs(existing, files, mode) {
  if (!['dataset', 'masks'].includes(mode)) throw new Error('Invalid folder merge mode.');
  const incoming = mode === 'dataset' ? pairFiles(files) : Array.from(files, fileInfo)
    .filter(info => info.key && (info.isImage || info.isNpy))
    .map(info => ({ base: { ...info, isMask: true }, mask: null }));
  const pairs = [];
  const orphans = [];
  const bases = new Map();
  const singles = new Map();
  for (const pair of [...existing, ...incoming]) {
    if (!pair.mask && pair.base.isMask) {
      orphans.push(pair);
      continue;
    }
    const position = pairs.length;
    pairs.push(pair);
    if (!pair.mask) singles.set(pair.base.file, position);
    let group = bases.get(pair.base.key);
    if (!group) { group = { files: new Set(), first: pair.base, dirs: new Map() }; bases.set(pair.base.key, group); }
    if (!group.files.has(pair.base.file)) {
      group.files.add(pair.base.file);
      const dir = group.dirs.get(pair.base.dir);
      if (dir) dir.count++;
      else group.dirs.set(pair.base.dir, { count: 1, first: pair.base });
    }
  }
  for (const orphan of orphans) {
    const group = bases.get(orphan.base.key);
    const sameDir = group?.dirs.get(orphan.base.dir);
    const base = sameDir?.count === 1 ? sameDir.first : !sameDir && group?.files.size === 1 ? group.first : null;
    if (!base) { pairs.push(orphan); continue; }
    const single = singles.get(base.file);
    if (single !== undefined) {
      pairs[single] = { ...pairs[single], mask: orphan.base };
      singles.delete(base.file);
    } else pairs.push({ base, mask: orphan.base });
  }
  return pairs;
}

export function inFolder(info, folder) {
  if (info.sourceId !== folder.sourceId) return false;
  if (folder.all) return true;
  const directory = info.path.includes('/') ? info.path.slice(0, info.path.lastIndexOf('/')) : '';
  return folder.path ? directory === folder.path || directory.startsWith(`${folder.path}/`) : !directory;
}

export function inferExampleRule(base, mask, id) {
  if (!/^(?:\d+|[a-z]+)$/i.test(id)) throw new Error('Choose an ID shared by both example filenames.');
  const numeric = /^\d+$/.test(id);
  const normalize = value => numeric ? value.replace(/^0+(?=\d)/, '') : value.toLowerCase();
  function expression(info) {
    const stem = info.stem;
    const tokens = [...stem.matchAll(numeric ? /\d+/g : /[a-z]+/gi)].filter(match => normalize(match[0]) === normalize(id));
    if (tokens.length !== 1) throw new Error(`The ID must occur exactly once in ${info.name}.`);
    const token = tokens[0];
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = escape(stem.slice(0, token.index));
    const after = stem.slice(token.index + token[0].length).split(/(\d+)/).map(part => /^\d+$/.test(part) ? '\\d+' : escape(part)).join('');
    return `^${before}(${numeric ? '\\d+' : '[a-z]+'})${after}$`;
  }
  return { type: 'regex', base: expression(base), mask: expression(mask), numericId: numeric };
}

function collectFolderMatches(pairs, baseFolder, maskFolders, rule) {
  if (!baseFolder || !maskFolders.length) throw new Error('Choose a base folder and at least one mask folder.');
  let baseRegex, maskRegex;
  if (rule.type === 'regex') {
    try { baseRegex = new RegExp(rule.base, 'i'); maskRegex = new RegExp(rule.mask, 'i'); }
    catch (error) { throw new Error(`Invalid matching expression: ${error.message}`); }
    if (!rule.base || !rule.mask) throw new Error('Enter both matching expressions with a capture group.');
  } else if (!['default', 'numeric', 'affixes'].includes(rule.type)) throw new Error('Invalid matching rule.');
  function key(info, side) {
    const stem = info.stem;
    if (rule.type === 'default') return info.key;
    if (rule.type === 'numeric') {
      const match = (side === 'base' ? /^(?:p)?(\d+)(?:[_\-. ]|$)/i : /^(?:hesalmap[_\-. ]*)?(\d+)(?:[_\-. ]|$)/i).exec(stem);
      return match ? match[1].replace(/^0+(?=\d)/, '') : null;
    }
    if (rule.type === 'regex') {
      const match = (side === 'base' ? baseRegex : maskRegex).exec(stem);
      if (!match) return null;
      if (!match[1]) throw new Error(`The ${side} expression must capture a non-empty ID in its first group.`);
      return rule.numericId ? match[1].replace(/^0+(?=\d)/, '') : match[1].toLowerCase();
    }
    const prefix = rule[`${side}Prefix`].toLowerCase(), suffix = rule[`${side}Suffix`].toLowerCase();
    if (!stem.startsWith(prefix) || !stem.endsWith(suffix) || stem.length <= prefix.length + suffix.length) return null;
    return stem.slice(prefix.length, stem.length - suffix.length);
  }
  const bases = new Map(), baseFiles = new Set(), pairedBases = new Set(), existingMasks = new Set();
  const maskContains = info => maskFolders.some(folder => inFolder(info, folder));
  function role(info) {
    const baseId = inFolder(info, baseFolder) ? key(info, 'base') : null;
    const maskId = maskContains(info) ? key(info, 'mask') : null;
    if (baseId && maskId) {
      if (rule.type === 'default') return info.isMask ? { maskId } : { baseId };
      return {};
    }
    return { baseId, maskId };
  }
  const roles = new Map();
  function getRole(info) {
    if (!roles.has(info.file)) roles.set(info.file, role(info));
    return roles.get(info.file);
  }
  for (const pair of pairs) {
    if (pair.mask) { pairedBases.add(pair.base.file); existingMasks.add(pair.mask.file); }
    const id = getRole(pair.base).baseId;
    if (!id) continue;
    baseFiles.add(pair.base.file);
    if (!bases.has(id)) bases.set(id, new Map());
    bases.get(id).set(pair.base.file, pair.base);
  }
  const proposals = [], seen = new Set(), unmatched = new Set(), maskCandidates = new Set();
  for (const pair of pairs) {
    const info = pair.base;
    if (pair.mask || pairedBases.has(info.file) || existingMasks.has(info.file) ||
        seen.has(info.file) || !maskContains(info)) continue;
    const candidate = getRole(info);
    if (candidate.baseId) continue;
    seen.add(info.file);
    if (candidate.maskId) maskCandidates.add(info.file);
    const group = bases.get(candidate.maskId);
    if (!group || group.size !== 1) { unmatched.add(info.file); continue; }
    const base = group.values().next().value;
    if (base.file === info.file) { unmatched.add(info.file); continue; }
    proposals.push({ base, mask: { ...info, isMask: true } });
  }
  return { proposals, unmatched, maskCandidates, baseFiles };
}

export function matchFolderGroups(pairs, groups) {
  if (!groups.length) throw new Error('Choose at least one base path.');
  const additions = new Map(), matchedMasks = new Set(), maskCandidates = new Set(), baseFiles = new Set(), unmatched = new Set();
  const groupResults = [];
  for (const { baseFolder, maskFolders, rule } of groups) {
    const found = collectFolderMatches(pairs, baseFolder, maskFolders, rule);
    groupResults.push({ path: baseFolder.path, sourceId: baseFolder.sourceId, matched: found.proposals.length, unmatched: found.unmatched.size });
    for (const file of found.unmatched) unmatched.add(file);
    for (const file of found.maskCandidates) maskCandidates.add(file);
    for (const file of found.baseFiles) baseFiles.add(file);
    for (const proposal of found.proposals) {
      let group = additions.get(proposal.base.file);
      if (!group) { group = { base: proposal.base, masks: new Map() }; additions.set(proposal.base.file, group); }
      group.masks.set(proposal.mask.file, proposal.mask);
      matchedMasks.add(proposal.mask.file);
    }
  }
  const preview = [];
  let matched = 0;
  for (const group of additions.values()) for (const mask of group.masks.values()) {
    matched++;
    if (preview.length < 20) preview.push({ base: group.base.path, mask: mask.path });
  }
  for (const file of matchedMasks) unmatched.delete(file);
  const result = [];
  for (const pair of pairs) {
    if (matchedMasks.has(pair.base.file) && !pair.mask && !baseFiles.has(pair.base.file)) continue;
    const group = additions.get(pair.base.file);
    if (!pair.mask && group?.masks.size) {
      const [file, mask] = group.masks.entries().next().value;
      group.masks.delete(file);
      result.push({ ...pair, mask });
    }
    else if (!pair.mask && maskCandidates.has(pair.base.file) && !baseFiles.has(pair.base.file)) result.push({ ...pair, base: { ...pair.base, isMask: true } });
    else result.push(pair);
  }
  for (const group of additions.values()) for (const mask of group.masks.values()) result.push({ base: group.base, mask });
  return { pairs: result, matched, unmatched: unmatched.size, preview, groupResults };
}

export function matchFolderPairs(pairs, baseFolder, maskFolders, rule) {
  return matchFolderGroups(pairs, [{ baseFolder, maskFolders, rule }]);
}

export function removeFolders(pairs, folders, includeSubfolders = false) {
  const removed = info => folders.some(folder => {
    if (includeSubfolders) return inFolder(info, folder);
    const directory = info.path.includes('/') ? info.path.slice(0, info.path.lastIndexOf('/')) : '';
    return info.sourceId === folder.sourceId && directory === folder.path;
  });
  const kept = [], lostBases = new Map(), orphanMasks = new Map();
  for (const pair of pairs) {
    if (removed(pair.base)) {
      if (pair.mask && !removed(pair.mask)) orphanMasks.set(pair.mask.file, { ...pair.mask, isMask: true });
    } else if (pair.mask && removed(pair.mask)) lostBases.set(pair.base.file, pair);
    else kept.push(pair);
  }
  const bases = new Set(kept.map(pair => pair.base.file));
  const masks = new Set(kept.filter(pair => pair.mask).map(pair => pair.mask.file));
  for (const [file, pair] of lostBases) if (!bases.has(file)) {
    kept.push({ ...pair, mask: null });
    bases.add(file);
  }
  for (const [file, mask] of orphanMasks) if (!masks.has(file) && !bases.has(file)) kept.push({ base: mask, mask: null });
  return kept;
}

export function maskAlternatives(pairs, pair) {
  return pairs.flatMap((candidate, index) => candidate.base.file === pair.base.file && candidate.mask ? [{ index, mask: candidate.mask }] : []);
}

export function assignMask(pairs, index, mask, action) {
  const pair = pairs[index];
  if (!pair || !mask || !['add', 'replace'].includes(action) || (action === 'replace' && !pair.mask)) throw new Error('Cannot assign mask to this item.');
  if (action === 'add' && pair.mask) {
    pairs.splice(index + 1, 0, { base: pair.base, mask });
    return index + 1;
  }
  pair.mask = mask;
  return index;
}

function halfToNumber(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function parseNpyHeader(buffer, fileSize = buffer.byteLength) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 10 || view.getUint8(0) !== 0x93 || String.fromCharCode(...new Uint8Array(buffer, 1, 5)) !== 'NUMPY') throw new Error('Not a valid NumPy .npy file.');
  const major = view.getUint8(6);
  if (![1, 2, 3].includes(major)) throw new Error(`Unsupported NPY version ${major}.`);
  const offset = major === 1 ? 10 : 12;
  if (buffer.byteLength < offset) throw new Error('Truncated NPY header.');
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  if (headerLength > buffer.byteLength - offset) throw new Error('Truncated NPY header.');
  const header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1').decode(new Uint8Array(buffer, offset, headerLength));
  const descr = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  const order = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(header)?.[1];
  if (!descr || shapeText === undefined || !order) throw new Error('Invalid NPY header.');
  const shape = shapeText.split(',').map(s => s.trim()).filter(Boolean).map(s => /^\d+$/.test(s) ? Number(s) : NaN);
  if (!shape.length || shape.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Array dimensions must be positive integers.');
  const dtype = /^([<>=|])([?biuf])(\d+)$/.exec(descr);
  if (!dtype) throw new Error(`Unsupported NumPy dtype: ${descr}.`);
  const [, endian, kind, sizeText] = dtype;
  const size = Number(sizeText);
  const valid = (kind === 'f' && [2, 4, 8].includes(size)) || (['i', 'u'].includes(kind) && [1, 2, 4, 8].includes(size)) || (['b', '?'].includes(kind) && size === 1);
  if (!valid) throw new Error(`Unsupported NumPy dtype: ${descr}.`);
  const count = shape.reduce((a, b) => a * b, 1);
  const dataOffset = offset + headerLength;
  if (!Number.isSafeInteger(count) || count > Math.floor((fileSize - dataOffset) / size)) throw new Error('Truncated or oversized NPY data.');
  return { shape, dtype: descr, fortran: order === 'True', dataOffset, size, kind, endian };
}

export function npyReader(buffer, { dtype, kind, size, endian }, dataOffset = 0) {
  const view = new DataView(buffer);
  const little = endian !== '>';
  return function read(index) {
    const pos = dataOffset + index * size;
    if (kind === 'f') return size === 2 ? halfToNumber(view.getUint16(pos, little)) : size === 4 ? view.getFloat32(pos, little) : view.getFloat64(pos, little);
    if (kind === 'b' || kind === '?') return view.getUint8(pos) ? 1 : 0;
    if (kind === 'i') return size === 1 ? view.getInt8(pos) : size === 2 ? view.getInt16(pos, little) : size === 4 ? view.getInt32(pos, little) : Number(view.getBigInt64(pos, little));
    return size === 1 ? view.getUint8(pos) : size === 2 ? view.getUint16(pos, little) : size === 4 ? view.getUint32(pos, little) : Number(view.getBigUint64(pos, little));
  }
}

export function parseNpy(buffer) {
  const header = parseNpyHeader(buffer);
  return { ...header, read: npyReader(buffer, header, header.dataOffset) };
}

export function arrayRaster(array) {
  const shape = array.shape;
  const channelFirst = shape.length === 3 && [1, 3, 4].includes(shape[0]) && ![1, 3, 4].includes(shape[2]);
  if (shape.length !== 2 && !(shape.length === 3 && (channelFirst || [1, 3, 4].includes(shape[2])))) throw new Error(`Unsupported array shape (${shape.join(', ')}). Expected H×W, H×W×C, or C×H×W with 1, 3, or 4 channels.`);
  const height = channelFirst ? shape[1] : shape[0];
  const width = channelFirst ? shape[2] : shape[1];
  const channels = channelFirst ? shape[0] : shape[2] || 1;
  const values = new Float64Array(height * width * channels);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) {
    const source = channelFirst
      ? (array.fortran ? c + channels * (y + height * x) : (c * height + y) * width + x)
      : (array.fortran ? y + height * (x + width * c) : (y * width + x) * channels + c);
    const value = array.read(source);
    values[(y * width + x) * channels + c] = value;
    if (Number.isFinite(value) && (channels !== 4 || c !== 3)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (min === Infinity) throw new Error('Array contains no finite values.');
  return { width, height, channels, values, min, max, dtype: array.dtype, shape };
}

const MAPS = {
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  plasma: ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  jet: ['#000080', '#0000ff', '#00ffff', '#80ff80', '#ffff00', '#ff0000', '#800000'],
  gray: ['#000000', '#ffffff']
};
export function colorStops(name) { return MAPS[name] || MAPS.viridis; }
export function colorAt(name, value) {
  const stops = colorStops(name);
  const pos = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2), fraction = pos - i;
  return [1, 3, 5].map(start => Math.round(parseInt(stops[i].slice(start, start + 2), 16) * (1 - fraction) + parseInt(stops[i + 1].slice(start, start + 2), 16) * fraction));
}

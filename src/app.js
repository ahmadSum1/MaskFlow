import { arrayRaster, assignMask, colorAt, colorStops, fileInfo, inferExampleRule, inFolder, npyReader, removeFolders, resolveFile } from './core.js';
import { loadSampleFiles } from './samples.js';
import { groupBaseRows, pairStatus, visibleDatasetRows } from './dataset-view.js';
import { defaultSequenceAxes, openNpy, readSequenceFrame } from './sequence.js';
import { extractMetadata, formatMetadata } from './metadata.js';

const $ = id => document.getElementById(id);
const baseCanvas = $('base-canvas');
const maskCanvas = $('mask-canvas');
const canvasWrap = $('canvas-wrap');
const canvasStack = $('canvas-stack');
const state = { pairs: [], maskGroups: new Map(), index: -1, base: null, mask: null, request: 0, datasetVersion: 0, inputVersion: 0, pickerOpen: false, sampleLoading: false, indexing: false, indexMessage: '', viewLoading: false, cancelIndex: null, viewVersion: 0, cancelView: null, rows: [], visibleRows: [], navigation: [], positions: new Map(), rowPositions: new Map(), ancestors: new Map(), collapsed: new Set(), expandedBases: new Set(), dimensions: new WeakMap() };
const ROW_HEIGHT = 61;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
let maskTarget = null;
let renderedRange = null;
let zoom = 1;
let panX = 0;
let panY = 0;
let panPointer = null;
let contextInfo = null;
let contextOrigin = null;
let metadataRequest = 0;
let addFolderMode = 'dataset';
let addFolderMatch = null;
let nextSourceId = 1;
let matchingMode = 'loaded';
let matchingFolders = [];
let matchingGroups = new Map();
let activeMatchingGroup = null;
let exampleFiles = [];
let matchingPreview = null;
let matchingRevision = 0;
let matchingPending = false;
let pickerInput = null;
let pickerSerial = 0;
let pickerVersion = 0;
let pickerFolderMode = null;
const formatNumber = value => Number(value.toPrecision(5)).toString();
let sequence = null;
let sequenceVersion = 0;
let playbackTimer = null;
let playing = false;
let playbackFps = 10;

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function setError(message) {
  $('error-message').textContent = message;
  $('error-message').hidden = !message;
}

function updateZoom() {
  canvasStack.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  canvasWrap.classList.toggle('zoomed', zoom > 1);
  $('zoom-value').textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(next, point = null) {
  const updated = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  if (point) {
    const bounds = canvasWrap.getBoundingClientRect();
    const x = point.x - bounds.left - bounds.width / 2;
    const y = point.y - bounds.top - bounds.height / 2;
    panX = x - (x - panX) * updated / zoom;
    panY = y - (y - panY) * updated / zoom;
  } else {
    panX *= updated / zoom;
    panY *= updated / zoom;
  }
  zoom = updated;
  if (zoom === 1) { panX = 0; panY = 0; }
  updateZoom();
}

function resetZoom() {
  zoom = 1;
  panX = 0;
  panY = 0;
  updateZoom();
}

async function loadRaster(info) {
  const file = await resolveFile(info.file);
  if (info.isNpy) {
    const header = await openNpy(file);
    const shape = header.shape;
    const isUnchannelledVolume = shape.length === 3 && ![1, 3, 4].includes(shape[0]) && ![1, 3, 4].includes(shape[2]);
    if (shape.length >= 4 || isUnchannelledVolume) return { type: 'sequence', file, header };
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength !== file.size) throw new Error('Truncated NPY data.');
    return { type: 'array', ...arrayRaster({ ...header, read: npyReader(buffer, header, header.dataOffset) }) };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image has no dimensions.');
    return { type: 'image', image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalized(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return max === min ? (value === 0 ? 0 : 1) : (value - min) / (max - min);
}

function paintArray(canvas, raster, colorize) {
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(raster.width, raster.height);
  const { values, channels, min, max } = raster;
  const rgbScale = min >= 0 && max <= 1 ? 1 : min >= 0 && max <= 255 ? 255 : null;
  const palette = Array.from({ length: 256 }, (_, i) => colorAt($('colormap').value, i / 255));
  for (let i = 0; i < raster.width * raster.height; i++) {
    const at = i * channels, out = i * 4;
    if (channels === 1 || colorize) {
      const value = channels === 1 ? values[at] : (values[at] + values[at + 1] + values[at + 2]) / 3;
      const color = palette[Math.round(normalized(value, min, max) * 255)];
      pixels.data.set(color, out);
    } else {
      for (let c = 0; c < 3; c++) pixels.data[out + c] = rgbScale ? Math.max(0, Math.min(255, values[at + c] / rgbScale * 255)) : normalized(values[at + c], min, max) * 255;
    }
    pixels.data[out + 3] = channels === 4 && !colorize ? Math.max(0, Math.min(255, values[at + 3] * (rgbScale === 1 ? 255 : 1))) : 255;
  }
  ctx.putImageData(pixels, 0, 0);
}

function paintRaster(canvas, raster, colorize) {
  if (raster.type === 'array') {
    paintArray(canvas, raster, colorize);
    return;
  }
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: colorize });
  ctx.drawImage(raster.image, 0, 0);
  if (colorize) {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = Array.from({ length: 256 }, (_, i) => colorAt($('colormap').value, i / 255));
    for (let i = 0; i < pixels.data.length; i += 4) {
      const value = (0.2126 * pixels.data[i] + 0.7152 * pixels.data[i + 1] + 0.0722 * pixels.data[i + 2]) / 255;
      pixels.data.set(palette[Math.round(value * 255)], i);
    }
    ctx.putImageData(pixels, 0, 0);
  }
}

function render() {
  if (!state.base) return;
  paintRaster(baseCanvas, state.base, false);
  if (state.mask) paintRaster(maskCanvas, state.mask, true);
  maskCanvas.hidden = !state.mask;
  canvasStack.classList.toggle('match-mask-size', $('match-mask-size').checked);
  updateLayerOrder();
  $('color-ramp').style.background = `linear-gradient(to right, ${colorStops($('colormap').value).join(', ')})`;
}

function updateLayerOrder() {
  const pair = state.pairs[state.index];
  const swapped = !!(pair?.mask && pair.swapped);
  const opacity = $('opacity').value / 100;
  baseCanvas.style.zIndex = swapped ? '1' : '0';
  baseCanvas.style.opacity = swapped ? opacity : 1;
  maskCanvas.style.zIndex = swapped ? '0' : '1';
  maskCanvas.style.opacity = swapped ? 1 : opacity;
  $('layer-order').textContent = !pair?.mask ? 'Select a mask to arrange layers.' : swapped ? 'Front: base image · Back: mask' : 'Front: mask · Back: base image';
  $('swap-layers').setAttribute('aria-pressed', String(swapped));
}

function updateMaskControls() {
  const pair = state.pairs[state.index];
  const selectMask = $('mask-select');
  selectMask.replaceChildren();
  const busy = inputsBusy();
  $('add-mask').disabled = busy || !pair;
  $('replace-mask').disabled = busy || !pair?.mask;
  $('swap-layers').disabled = !pair?.mask;
  $('match-mask-size').disabled = !pair?.mask;
  if (!pair?.mask) {
    selectMask.add(new Option('No mask selected', ''));
    selectMask.disabled = true;
  } else {
    (state.maskGroups.get(pair.base.file) || []).forEach(({ pair: candidate, index }) => {
      const option = new Option(candidate.mask.path, String(index));
      selectMask.add(option);
    });
    selectMask.value = String(state.index);
    selectMask.disabled = selectMask.options.length < 2;
  }
  updateLayerOrder();
}

function updateDatasetCount() {
  const count = state.pairs.length;
  $('dataset-count').textContent = count;
  $('add-folder-menu').hidden = count === 0;
  $('advanced-menu').hidden = count === 0;
  if (!count) $('add-folder-menu').open = false;
  const shown = state.navigation.length;
  $('pair-summary').textContent = shown === count ? `${count} ${count === 1 ? 'item' : 'items'}` : `${shown} / ${count} items`;
  $('clear-dataset').disabled = count === 0 && !state.sampleLoading && !state.indexing;
}

function setSampleLoading(loading) {
  state.sampleLoading = loading;
  updateBusyIndicator();
  $('clear-dataset').disabled = !loading && !state.indexing && state.pairs.length === 0;
}

function setIndexing(indexing, message = 'Indexing files…') {
  state.indexing = indexing;
  state.indexMessage = message;
  updateBusyIndicator();
  $('clear-dataset').disabled = !indexing && !state.sampleLoading && state.pairs.length === 0;
}

function updateBusyIndicator() {
  const busy = inputsBusy();
  $('busy-indicator').hidden = !busy;
  $('busy-message').textContent = state.indexing ? state.indexMessage : state.sampleLoading ? 'Loading samples…' : state.viewLoading ? 'Updating dataset view…' : pickerInput?.hasAttribute('webkitdirectory') ? 'Waiting for folder selection or browser folder scan…' : 'Waiting for file selection…';
  $('picker-recovery').hidden = !state.pickerOpen || state.indexing || state.sampleLoading || state.viewLoading;
  $('fallback-picker').hidden = !state.pickerOpen || pickerFolderMode === null || !!pickerInput;
  document.body.classList.toggle('loading', busy);
  $('dataset-list').setAttribute('aria-busy', String(busy));
  for (const id of ['choose-folder', 'empty-folder', 'choose-files', 'empty-files', 'add-dataset-folder', 'add-masks-folder', 'load-sample', 'match-loaded', 'remove-folders']) $(id).disabled = busy;
  const summary = $('add-folder-menu').querySelector('summary');
  summary.setAttribute('aria-disabled', String(busy));
  if (busy) $('add-folder-menu').open = false;
  const pair = state.pairs[state.index];
  $('add-mask').disabled = busy || !pair;
  $('replace-mask').disabled = busy || !pair?.mask;
}

function inputsBusy() {
  return state.pickerOpen || state.indexing || state.sampleLoading || state.viewLoading;
}

function cancelIndexing() {
  if (state.cancelIndex) state.cancelIndex();
  setIndexing(false);
}

function clearDataset() {
  state.request++;
  state.datasetVersion++;
  state.inputVersion++;
  cancelIndexing();
  cancelView();
  state.pairs = [];
  state.maskGroups = new Map();
  state.rows = [];
  state.visibleRows = [];
  state.navigation = [];
  state.positions = new Map();
  state.rowPositions = new Map();
  state.ancestors = new Map();
  state.collapsed.clear();
  state.expandedBases.clear();
  state.dimensions = new WeakMap();
  setSampleLoading(false);
  maskTarget = null;
  for (const id of ['files-input', 'folder-input', 'add-folder-input', 'mask-input']) $(id).value = '';
  updateDatasetCount();
  renderList();
  resetViewer(false);
  $('view-status').textContent = '';
  showNotice('');
}

function resetViewer(noMatches) {
  state.request++;
  clearSequence();
  resetZoom();
  state.index = -1;
  state.base = null;
  state.mask = null;
  for (const canvas of [baseCanvas, maskCanvas]) { canvas.width = 0; canvas.height = 0; }
  updateMaskControls();
  $('viewer-name').textContent = 'Canvas';
  $('viewer-subtitle').textContent = 'Your visual workspace';
  for (const id of ['detail-base', 'detail-mask', 'detail-dimensions', 'detail-range']) {
    $(id).textContent = '—';
    $(id).title = '';
  }
  $('dimension-badge').hidden = true;
  $('position').textContent = '0';
  $('jump-index').value = '';
  $('jump-index').disabled = true;
  $('jump-index').removeAttribute('aria-invalid');
  $('index-error').hidden = true;
  $('previous').disabled = true;
  $('next').disabled = true;
  $('canvas-wrap').hidden = true;
  $('empty-state').hidden = noMatches;
  $('no-matches').hidden = !noMatches;
  $('drop-zone').classList.remove('dragging');
  $('status').textContent = 'Ready to explore';
  setError('');
}

function renderList(ensureSelected = false, scrollOnly = false) {
  const list = $('dataset-list');
  if (!state.visibleRows.length) {
    closeFileMenu();
    renderedRange = null;
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = state.pairs.length ? 'No items match the current filter.' : 'Your dataset will appear here. Choose a folder or files to get started.';
    list.replaceChildren(empty);
    return;
  }
  const height = list.clientHeight || 300;
  let scrollTop = Math.min(list.scrollTop, Math.max(0, state.visibleRows.length * ROW_HEIGHT - height));
  if (ensureSelected) {
    const top = (state.rowPositions.get(state.index) ?? 0) * ROW_HEIGHT;
    if (top < scrollTop) scrollTop = top;
    else if (top + ROW_HEIGHT > scrollTop + height) scrollTop = top + ROW_HEIGHT - height;
  }
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const end = Math.min(state.visibleRows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 4);
  if (scrollOnly && renderedRange?.rows === state.visibleRows && renderedRange.start === start && renderedRange.end === end) return;
  closeFileMenu();
  renderedRange = { rows: state.visibleRows, start, end };
  const fragment = document.createDocumentFragment();
  const before = document.createElement('div');
  before.style.height = `${start * ROW_HEIGHT}px`;
  before.setAttribute('aria-hidden', 'true');
  fragment.append(before);
  for (let rowIndex = start; rowIndex < end; rowIndex++) {
    const row = state.visibleRows[rowIndex];
    if (row.kind === 'group') {
      const heading = document.createElement('div');
      heading.className = 'dataset-group';
      heading.textContent = row.label;
      fragment.append(heading);
      continue;
    }
    if (row.kind === 'folder') {
      const folder = document.createElement('button');
      folder.className = 'dataset-folder';
      folder.dataset.key = row.key;
      folder.style.paddingLeft = `${18 + Math.min(row.depth, 12) * 14}px`;
      folder.setAttribute('aria-expanded', String(!state.collapsed.has(row.key)));
      folder.textContent = `${state.collapsed.has(row.key) ? '▸' : '▾'} ${row.label}`;
      folder.addEventListener('click', () => {
        if (state.collapsed.has(row.key)) state.collapsed.delete(row.key);
        else state.collapsed.add(row.key);
        rebuildVisibleRows();
        renderList();
        [...list.querySelectorAll('.dataset-folder')].find(button => button.dataset.key === row.key)?.focus({ preventScroll: true });
      });
      fragment.append(folder);
      continue;
    }
    if (row.kind === 'mask') {
      const pair = state.pairs[row.index];
      const mask = document.createElement('button');
      mask.className = `mask-item${row.index === state.index ? ' active' : ''}`;
      mask.dataset.index = row.index;
      mask.style.paddingLeft = `${18 + Math.min(row.depth, 12) * 14}px`;
      mask.textContent = pair.mask.name;
      mask.title = pair.mask.path;
      if (row.index === state.index) mask.setAttribute('aria-current', 'true');
      mask.addEventListener('click', () => {
        select(row.index);
        list.querySelector(`.mask-item[data-index="${row.index}"]`)?.focus({ preventScroll: true });
      });
      fragment.append(mask);
      continue;
    }
    const index = row.indices.includes(state.index) ? state.index : row.index;
    const pair = state.pairs[index];
    const maskCount = row.indices.filter(item => state.pairs[item].mask).length;
    const container = document.createElement('div');
    container.className = 'dataset-row';
    const button = document.createElement('button');
    button.className = `dataset-item${row.indices.includes(state.index) ? ' active' : ''}`;
    button.dataset.index = row.index;
    if (row.depth) button.style.paddingLeft = `${18 + Math.min(row.depth, 12) * 14}px`;
    if (row.indices.includes(state.index) && (!state.expandedBases.has(row.key) || !state.pairs[state.index].mask)) button.setAttribute('aria-current', 'true');
    const icon = document.createElement('span');
    icon.className = 'item-icon';
    icon.textContent = pair.mask ? '◈' : '▧';
    const text = document.createElement('span');
    text.className = 'item-text';
    const name = document.createElement('strong');
    name.textContent = pair.base.name;
    name.title = pair.base.path;
    const subtitle = document.createElement('small');
    subtitle.textContent = maskCount ? `${maskCount} ${maskCount === 1 ? 'mask' : 'masks'}` : pair.base.isMask ? 'Orphan mask' : 'Single file';
    text.append(name, subtitle);
    button.append(icon, text);
    button.addEventListener('click', () => {
      select(index);
      list.querySelector(`.dataset-item[data-index="${row.index}"]`)?.focus({ preventScroll: true });
    });
    container.append(button);
    if (maskCount) {
      const arrow = document.createElement('button');
      arrow.className = 'item-arrow';
      arrow.dataset.index = row.index;
      const expanded = state.expandedBases.has(row.key);
      arrow.textContent = expanded ? '▾' : '▸';
      arrow.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} masks for ${pair.base.name}`);
      arrow.setAttribute('aria-expanded', String(expanded));
      arrow.addEventListener('click', () => {
        if (state.expandedBases.has(row.key)) state.expandedBases.delete(row.key);
        else state.expandedBases.add(row.key);
        rebuildVisibleRows();
        renderList();
        list.querySelector(`.item-arrow[data-index="${row.index}"]`)?.focus({ preventScroll: true });
      });
      container.append(arrow);
    }
    fragment.append(container);
  }
  const after = document.createElement('div');
  after.style.height = `${(state.visibleRows.length - end) * ROW_HEIGHT}px`;
  after.setAttribute('aria-hidden', 'true');
  fragment.append(after);
  list.replaceChildren(fragment);
  list.scrollTop = scrollTop;
}

function stopPlayback() {
  playing = false;
  clearTimeout(playbackTimer);
  playbackTimer = null;
  $('frame-play').textContent = 'Play';
  $('frame-play').setAttribute('aria-pressed', 'false');
}

function clearSequence() {
  stopPlayback();
  sequenceVersion++;
  sequence = null;
  $('sequence-controls').hidden = true;
}

function setupSequence(source, previous = null) {
  const { shape } = source.header;
  const axes = previous?.axes || defaultSequenceAxes(shape);
  sequence = { ...source, axes, frame: previous?.frame ?? 0, extra: previous?.extra ?? {} };
  $('sequence-shape').textContent = `Shape: (${shape.join(', ')}). Axis numbers are zero-based.`;
  for (const role of ['frame', 'height', 'width', 'channel']) {
    const select = $(`axis-${role}`);
    select.replaceChildren(...(role === 'channel' ? [new Option('None', '')] : []), ...shape.map((size, axis) => new Option(`Axis ${axis} (${size})`, String(axis))));
    select.value = axes[role] === null ? '' : String(axes[role]);
  }
  renderExtraAxisControls();
  $('sequence-controls').hidden = false;
  updateFrameControls();
}

function extraAxes(shape, axes) {
  const used = new Set(Object.values(axes).filter(axis => axis !== null));
  return shape.map((_, axis) => axis).filter(axis => !used.has(axis));
}

function renderExtraAxisControls() {
  const container = $('extra-controls');
  container.replaceChildren();
  if (!sequence) return;
  for (const axis of extraAxes(sequence.header.shape, sequence.axes)) {
    const row = document.createElement('div');
    row.className = 'sequence-navigation sequence-extra';
    const label = document.createElement('span');
    label.textContent = `Axis ${axis} (${sequence.header.shape[axis]})`;
    const previous = document.createElement('button');
    previous.className = 'nav-button';
    previous.type = 'button';
    previous.dataset.axis = axis;
    previous.dataset.direction = '-1';
    previous.setAttribute('aria-label', `Previous index for axis ${axis}`);
    previous.textContent = '←';
    const inputLabel = document.createElement('label');
    inputLabel.textContent = 'Index ';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.max = sequence.header.shape[axis];
    input.value = (sequence.extra[axis] ?? 0) + 1;
    input.dataset.axis = axis;
    inputLabel.append(input);
    const total = document.createElement('span');
    total.textContent = `/ ${sequence.header.shape[axis]}`;
    const next = document.createElement('button');
    next.className = 'nav-button';
    next.type = 'button';
    next.dataset.axis = axis;
    next.dataset.direction = '1';
    next.setAttribute('aria-label', `Next index for axis ${axis}`);
    next.textContent = '→';
    row.append(label, previous, inputLabel, total, next);
    container.append(row);
  }
  container.hidden = !container.childElementCount;
}

function updateFrameControls() {
  if (!sequence) return;
  const count = sequence.header.shape[sequence.axes.frame];
  $('frame-number').max = count;
  $('frame-number').value = sequence.frame + 1;
  $('frame-total').textContent = `/ ${count}`;
  $('frame-previous').disabled = sequence.frame === 0;
  $('frame-next').disabled = sequence.frame === count - 1;
  for (const button of $('extra-controls').querySelectorAll('button[data-axis]')) {
    const axis = Number(button.dataset.axis);
    const index = sequence.extra[axis] ?? 0;
    button.disabled = button.dataset.direction === '-1' ? index === 0 : index === sequence.header.shape[axis] - 1;
  }
  for (const input of $('extra-controls').querySelectorAll('input[data-axis]')) {
    input.value = (sequence.extra[Number(input.dataset.axis)] ?? 0) + 1;
  }
}

async function showFrame(frame) {
  const current = sequence;
  if (!current) return;
  const version = ++sequenceVersion;
  current.frame = frame;
  updateFrameControls();
  $('status').textContent = 'Loading frame…';
  setError('');
  try {
    const raster = await readSequenceFrame(current.file, current.header, current.axes, frame, current.extra, () => version !== sequenceVersion);
    if (version !== sequenceVersion) return;
    state.base = { type: 'array', ...raster };
    render();
    $('canvas-wrap').hidden = false;
    $('dimension-badge').textContent = `${raster.width} × ${raster.height}`;
    $('dimension-badge').hidden = false;
    $('detail-dimensions').textContent = `${raster.width} × ${raster.height}${state.mask && (raster.width !== state.mask.width || raster.height !== state.mask.height) ? ` / ${state.mask.width} × ${state.mask.height}` : ''}`;
    const data = state.mask?.type === 'array' ? state.mask : raster;
    $('detail-range').textContent = `${formatNumber(data.min)} – ${formatNumber(data.max)}`;
    $('status').textContent = 'Frame loaded';
    if (playing) {
      if (frame + 1 >= current.header.shape[current.axes.frame]) stopPlayback();
      else playbackTimer = setTimeout(() => showFrame(frame + 1), 1000 / playbackFps);
    }
  } catch (error) {
    if (version !== sequenceVersion) return;
    stopPlayback();
    $('status').textContent = 'Unable to load frame';
    setError(`Could not display frame: ${error.message}`);
  }
}

async function select(index) {
  if (!state.positions.has(index)) return;
  const pair = state.pairs[index];
  const currentPair = state.pairs[state.index];
  const previousSequence = sequence && currentPair?.base.file === pair.base.file
    ? { axes: { ...sequence.axes }, frame: sequence.frame, extra: { ...sequence.extra } }
    : null;
  const ancestors = state.ancestors.get(index) || [];
  if (ancestors.some(key => state.collapsed.has(key))) {
    for (const key of ancestors) state.collapsed.delete(key);
    rebuildVisibleRows();
  }
  const request = ++state.request;
  clearSequence();
  state.index = index;
  state.base = null;
  state.mask = null;
  renderList(true);
  updateMaskControls();
  $('viewer-name').textContent = pair.base.name;
  $('viewer-subtitle').textContent = pair.mask ? `Overlay: ${pair.mask.name}` : 'Single file';
  $('detail-base').textContent = pair.base.name;
  $('detail-base').title = pair.base.path;
  $('detail-mask').textContent = pair.mask?.name || '—';
  $('detail-mask').title = pair.mask?.path || '';
  $('detail-dimensions').textContent = '—';
  $('detail-range').textContent = '—';
  $('dimension-badge').hidden = true;
  updateNavigation();
  $('empty-state').hidden = true;
  $('no-matches').hidden = true;
  $('canvas-wrap').hidden = true;
  $('status').textContent = 'Loading…';
  setError('');
  try {
    const [base, mask] = await Promise.all([loadRaster(pair.base), pair.mask ? loadRaster(pair.mask) : null]);
    if (request !== state.request) return;
    if (mask?.type === 'sequence') throw new Error('Sequence masks are not supported.');
    if (base.type === 'sequence') {
      state.mask = mask;
      setupSequence(base, previousSequence);
      await showFrame(previousSequence?.frame ?? 0);
      return;
    }
    state.base = base;
    state.mask = mask;
    render();
    $('canvas-wrap').hidden = false;
    $('dimension-badge').textContent = `${base.width} × ${base.height}`;
    $('dimension-badge').hidden = false;
    $('detail-dimensions').textContent = `${base.width} × ${base.height}${mask && (base.width !== mask.width || base.height !== mask.height) ? ` / ${mask.width} × ${mask.height}` : ''}`;
    const data = mask?.type === 'array' ? mask : base.type === 'array' ? base : null;
    $('detail-range').textContent = data ? `${formatNumber(data.min)} – ${formatNumber(data.max)}` : '—';
    $('status').textContent = mask ? 'Pair loaded' : 'File loaded';
  } catch (error) {
    if (request !== state.request) return;
    $('status').textContent = 'Unable to load file';
    setError(`Could not display ${pair.base.name}${pair.mask ? ` / ${pair.mask.name}` : ''}: ${error.message}`);
  }
}

function updateNavigation() {
  const position = state.positions.get(state.index);
  $('index-error').hidden = true;
  $('jump-index').removeAttribute('aria-invalid');
  $('jump-index').value = position + 1;
  $('jump-index').max = state.navigation.length;
  $('jump-index').disabled = false;
  $('position').textContent = state.navigation.length;
  $('previous').disabled = position === 0;
  $('next').disabled = position === state.navigation.length - 1;
}

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

function cancelView() {
  state.viewVersion++;
  if (state.cancelView) state.cancelView();
  state.viewLoading = false;
  updateBusyIndicator();
}

function rebuildVisibleRows() {
  state.visibleRows = groupBaseRows(visibleDatasetRows(state.rows, state.collapsed), state.expandedBases, index => state.pairs[index].base.file, index => !!state.pairs[index].mask);
  state.rowPositions = new Map();
  state.visibleRows.forEach((row, position) => {
    if (row.kind === 'item') for (const index of row.indices) state.rowPositions.set(index, position);
    else if (row.kind === 'mask') state.rowPositions.set(row.index, position);
  });
}

async function refreshView(preferredIndex = state.index) {
  cancelView();
  const version = state.viewVersion;
  const selectedAtStart = state.index;
  const options = {
    filter: $('filter-items').value,
    sort: $('sort-items').value,
    direction: $('sort-asc').disabled ? 'asc' : 'desc',
    group: $('group-items').checked ? 'status' : 'none',
    tree: $('tree-toggle').checked
  };
  if (!state.pairs.length) return;
  state.viewLoading = true;
  updateBusyIndicator();
  $('view-status').textContent = 'Updating dataset view…';
  try {
    const records = [];
    for (let index = 0; index < state.pairs.length; index++) {
      const pair = state.pairs[index], file = pair.base.file;
      const cached = state.dimensions.get(file);
      const status = pairStatus(pair);
      const record = { index, status, name: pair.base.name, path: pair.base.path, area: cached?.area ?? null };
      if ((options.sort === 'size' || options.sort === 'modified' || (options.sort === 'area' && !cached)) && (options.filter === 'all' || options.filter === status)) record.file = file;
      records.push(record);
      if ((index + 1) % 1000 === 0) {
        await yieldToBrowser();
        if (version !== state.viewVersion) return;
      }
    }
    const worker = new Worker(new URL('./view-worker.js', import.meta.url), { type: 'module' });
    const result = await new Promise((resolve, reject) => {
      function finish(callback, value) {
        state.cancelView = null;
        worker.terminate();
        callback(value);
      }
      state.cancelView = () => finish(resolve, null);
      worker.onmessage = event => {
        if (event.data.error) finish(reject, new Error(event.data.error));
        else if (event.data.rows) finish(resolve, event.data);
        else if (event.data.total) $('view-status').textContent = `Reading ${options.sort === 'area' ? 'dimensions' : 'file metadata'}: ${event.data.progress.toLocaleString()} / ${event.data.total.toLocaleString()}`;
      };
      worker.onerror = event => { event.preventDefault(); finish(reject, new Error(event.message || 'Dataset view worker failed.')); };
      worker.onmessageerror = () => finish(reject, new Error('Could not read the dataset view worker response.'));
      try { worker.postMessage({ records, options }); } catch (error) { finish(reject, error); }
    });
    if (!result || version !== state.viewVersion) return;
    for (const dimension of result.dimensions) state.dimensions.set(state.pairs[dimension.index].base.file, dimension);
    state.rows = result.rows;
    state.navigation = [];
    state.ancestors = new Map();
    for (const row of state.rows) if (row.kind === 'item') {
      state.navigation.push(row.index);
      state.ancestors.set(row.index, row.ancestors);
    }
    state.positions = new Map(state.navigation.map((index, position) => [index, position]));
    rebuildVisibleRows();
    updateDatasetCount();
    if (options.sort === 'area') {
      const unknown = state.navigation.filter(index => state.dimensions.get(state.pairs[index].base.file)?.area == null);
      const first = unknown.length && state.dimensions.get(state.pairs[unknown[0]].base.file);
      $('view-status').textContent = unknown.length ? `${unknown.length.toLocaleString()} item(s) have unknown dimensions and sort last. ${state.pairs[unknown[0]].base.name}: ${first?.error || 'unavailable'}.` : '';
    } else if (result.metadata.length) {
      const first = result.metadata[0];
      $('view-status').textContent = `${result.metadata.length.toLocaleString()} item(s) have unreadable file metadata and sort last. ${state.pairs[first.index].base.name}: ${first.error}.`;
    } else $('view-status').textContent = '';
    const selected = state.index !== selectedAtStart ? state.index : preferredIndex;
    if (state.navigation.length && selected === state.index && state.positions.has(selected)) {
      const ancestors = state.ancestors.get(selected) || [];
      if (ancestors.some(key => state.collapsed.has(key))) {
        for (const key of ancestors) state.collapsed.delete(key);
        rebuildVisibleRows();
      }
      updateNavigation();
      renderList(true);
    } else if (state.navigation.length) select(state.positions.has(selected) ? selected : state.navigation[0]);
    else { resetViewer(true); renderList(); }
  } catch (error) {
    if (version === state.viewVersion) $('view-status').textContent = `Could not update dataset view: ${error.message}`;
  } finally {
    if (version === state.viewVersion) { state.viewLoading = false; updateBusyIndicator(); }
  }
}

function indexPaths(input) {
  const worker = new Worker(new URL('./index-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    function finish(callback, value) {
      state.cancelIndex = null;
      worker.terminate();
      callback(value);
    }
    state.cancelIndex = () => finish(resolve, null);
    worker.onmessage = event => {
      if (event.data.error) finish(reject, new Error(event.data.error));
      else if (event.data.progress !== undefined || event.data.indexing !== undefined) {
        const count = event.data.progress ?? event.data.indexing;
        state.indexMessage = `${event.data.progress !== undefined ? 'Reading folder' : 'Indexing'}… ${count.toLocaleString()} files`;
        updateBusyIndicator();
      }
      else finish(resolve, event.data);
    };
    worker.onerror = event => {
      event.preventDefault();
      finish(reject, new Error(event.message || 'Indexing worker failed.'));
    };
    worker.onmessageerror = () => finish(reject, new Error('Could not read the indexing worker response.'));
    try { worker.postMessage(input); } catch (error) { finish(reject, error); }
  });
}

function addMaskGroup(groups, pair, index) {
  if (!pair.mask) return;
  const key = pair.base.file;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ pair, index });
}

function rebuildMaskGroups() {
  state.maskGroups = new Map();
  state.pairs.forEach((pair, index) => addMaskGroup(state.maskGroups, pair, index));
}

function findSelection(pairs, selected) {
  if (!selected) return undefined;
  const exact = pairs.findIndex(pair => pair.base.file === selected.base.file && pair.mask?.file === selected.mask?.file);
  if (exact >= 0) return exact;
  const base = pairs.findIndex(pair => pair.base.file === selected.base.file);
  if (base >= 0) return base;
  const orphan = pairs.findIndex(pair => pair.mask?.file === selected.base.file);
  if (orphan >= 0) return orphan;
  if (selected.mask) {
    const mask = pairs.findIndex(pair => pair.base.file === selected.mask.file || pair.mask?.file === selected.mask.file);
    if (mask >= 0) return mask;
  }
  return undefined;
}

async function matchInWorker(pairs, groups, inputVersion) {
  const identities = new Map(), infos = [];
  function pack(info) {
    if (!identities.has(info.file)) { identities.set(info.file, infos.length); infos.push(info); }
    return { ...info, file: identities.get(info.file) };
  }
  const records = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    records.push({ ...pair, base: pack(pair.base), mask: pair.mask ? pack(pair.mask) : null });
    if ((i + 1) % 1000 === 0) {
      await yieldToBrowser();
      if (inputVersion !== state.inputVersion) return null;
    }
  }
  const result = await indexPaths({ action: 'match-folders', pairs: records, groups });
  if (!result || inputVersion !== state.inputVersion) return null;
  function unpack(info) {
    const original = infos[info.file];
    return original.isMask === info.isMask ? original : { ...original, isMask: info.isMask };
  }
  return { ...result, pairs: result.pairs.map(pair => ({ ...pair, base: unpack(pair.base), mask: pair.mask ? unpack(pair.mask) : null })) };
}

function replacePairs(pairs, selected) {
  const preferred = findSelection(pairs, selected) ?? 0;
  state.datasetVersion++;
  cancelView();
  state.pairs = pairs;
  rebuildMaskGroups();
  state.navigation = [];
  state.positions = new Map();
  state.rows = [];
  state.visibleRows = [];
  resetViewer(false);
  renderList();
  updateDatasetCount();
  if (pairs.length) refreshView(preferred);
  else $('view-status').textContent = '';
}

async function ingest(files, mode = 'replace', root = null, matching = null) {
  if (!files.length && !root) return;
  const inputVersion = ++state.inputVersion;
  const datasetVersion = state.datasetVersion;
  const sourceId = nextSourceId++;
  const existing = mode === 'replace' ? [] : state.pairs.slice();
  cancelIndexing();
  setSampleLoading(false);
  setIndexing(true, root ? 'Reading folder…' : 'Indexing files…');
  showNotice(root ? 'Reading folder…' : `${mode === 'replace' ? 'Indexing' : 'Adding'} ${files.length.toLocaleString()} files…`);
  try {
    const paths = [];
    const sourceFiles = [];
    const sourceInfos = [];
    const roles = [];
    const fileIndices = new Map();
    const previous = [];
    function existingIndex(info) {
      if (!fileIndices.has(info.file)) {
        fileIndices.set(info.file, sourceFiles.length);
        sourceFiles.push(info.file);
        sourceInfos.push(info);
        paths.push(info.path);
        roles.push(info.isMask);
      }
      return fileIndices.get(info.file);
    }
    for (let i = 0; i < existing.length; i++) {
      const pair = existing[i];
      previous.push([existingIndex(pair.base), pair.mask ? existingIndex(pair.mask) : -1]);
      if ((i + 1) % 1000 === 0) {
        await yieldToBrowser();
        if (inputVersion !== state.inputVersion) return;
      }
    }
    const addedStart = sourceFiles.length;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      sourceFiles.push(file);
      paths.push(file.webkitRelativePath || file.relativePath || file.name);
      if ((i + 1) % 1000 === 0) {
        await yieldToBrowser();
        if (inputVersion !== state.inputVersion) return;
      }
    }
    const result = await indexPaths({ paths, previous, addedStart, mode, roles, root });
    if (!result || inputVersion !== state.inputVersion) return;
    if (mode !== 'replace' && datasetVersion !== state.datasetVersion) {
      setIndexing(false);
      showNotice('The dataset changed while adding the folder. Please add the folder again.');
      return;
    }
    const addedCount = root ? result.addedPaths.length : files.length;
    if (!addedCount || result.ignored === addedCount) {
      setIndexing(false);
      showNotice('No supported files found. Choose .npy files or common image formats.');
      return;
    }
    let pairs = [];
    const previousPositions = new Map();
    const maskPositions = new Map();
    function info(index) {
      if (!sourceInfos[index]) {
        const path = root && index >= addedStart ? result.addedPaths[index - addedStart] : null;
        const file = path ? { name: path.split('/').pop(), relativePath: path, rootHandle: root } : sourceFiles[index];
        const found = fileInfo(file);
        sourceInfos[index] = index >= addedStart
          ? { ...found, sourceId, isMask: mode === 'masks' || mode === 'selected-masks' ? true : found.isMask }
          : found;
      }
      return sourceInfos[index];
    }
    for (let i = 0; i < result.indices.length; i++) {
      const [baseIndex, maskIndex, oldIndex] = result.indices[i];
      const pair = { ...(oldIndex < 0 ? {} : existing[oldIndex]), base: info(baseIndex), mask: maskIndex < 0 ? null : info(maskIndex) };
      if (mode !== 'replace') {
        if (oldIndex >= 0) previousPositions.set(oldIndex, i);
        if (pair.mask) maskPositions.set(pair.mask.file, i);
      }
      pairs.push(pair);
      if ((i + 1) % 1000 === 0) {
        await yieldToBrowser();
        if (inputVersion !== state.inputVersion) return;
        if (mode !== 'replace' && datasetVersion !== state.datasetVersion) {
          setIndexing(false);
          showNotice('The dataset changed while adding the folder. Please add the folder again.');
          return;
        }
      }
    }
    if (mode !== 'replace' && datasetVersion !== state.datasetVersion) {
      setIndexing(false);
      showNotice('The dataset changed while adding the folder. Please add the folder again.');
      return;
    }
    const selected = mode === 'replace' ? null : state.pairs[state.index];
    let selectedIndex = mode === 'replace' ? undefined : previousPositions.get(state.index);
    const selectedOrphanIndex = selected && !selected.mask && selected.base.isMask ? maskPositions.get(selected.base.file) : undefined;
    let matchResult = null;
    if (matching) {
      state.indexMessage = 'Matching folders…';
      updateBusyIndicator();
      matchResult = await matchInWorker(pairs, [{ baseFolder: matching.baseFolder, maskFolders: [{ sourceId, all: true }], rule: matching.rule }], inputVersion);
      if (!matchResult || inputVersion !== state.inputVersion) return;
      if (datasetVersion !== state.datasetVersion) {
        setIndexing(false);
        showNotice('The dataset changed while adding the folder. Please add the folder again.');
        return;
      }
      pairs = matchResult.pairs;
      selectedIndex = findSelection(pairs, selected);
    }
    state.datasetVersion++;
    cancelView();
    state.pairs = pairs;
    rebuildMaskGroups();
    state.navigation = [];
    state.positions = new Map();
    state.rows = [];
    state.visibleRows = [];
    if (mode === 'replace') {
      state.collapsed.clear();
      state.expandedBases.clear();
      state.dimensions = new WeakMap();
    }
    resetViewer(false);
    renderList();
    if (mode === 'replace') $('dataset-list').scrollTop = 0;
    setIndexing(false);
    updateDatasetCount();
    const skipped = result.ignored ? ` ${result.ignored} unsupported or unrecognized ${result.ignored === 1 ? 'file was' : 'files were'} skipped.` : '';
    showNotice(mode === 'replace' ? skipped.trim() : matchResult
      ? `Folder added. Matched ${matchResult.matched} mask(s); ${matchResult.unmatched} unmatched or ambiguous.${skipped}`
      : `Folder added.${skipped}`);
    refreshView((matchResult ? selectedIndex : selectedIndex ?? selectedOrphanIndex) ?? 0);
  } catch (error) {
    if (inputVersion === state.inputVersion) {
      setIndexing(false);
      showNotice(`Could not index dataset: ${error.message}`);
    }
  }
}

async function readDroppedEntries(entries, inputVersion) {
  const queue = entries.map(entry => ({ entry, path: '' }));
  const files = [];
  let head = 0;
  while (head < queue.length && inputVersion === state.inputVersion) {
    const item = queue[head++];
    if (item.entry.isDirectory) {
      const reader = item.entry.createReader();
      while (inputVersion === state.inputVersion) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const entry of batch) queue.push({ entry, path: `${item.path}${item.entry.name}/` });
      }
    } else if (item.entry.isFile) {
      const batch = [item];
      while (head < queue.length && batch.length < 64 && queue[head].entry.isFile) batch.push(queue[head++]);
      const found = await Promise.all(batch.map(async ({ entry, path }) => {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        Object.defineProperty(file, 'relativePath', { value: path + file.name });
        return file;
      }));
      if (inputVersion !== state.inputVersion) return files;
      files.push(...found);
      showNotice(`Reading folder… ${files.length.toLocaleString()} files found.`);
    }
  }
  return files;
}

function setPickerOpen(open, input = null) {
  state.pickerOpen = open;
  pickerInput = input;
  pickerSerial++;
  updateBusyIndicator();
}

function openFilePicker(id) {
  if (inputsBusy()) return;
  const input = $(id);
  setPickerOpen(true, input);
  pickerVersion = state.inputVersion;
  try { input.click(); }
  catch (error) { setPickerOpen(false); showNotice(`Could not open file picker: ${error.message}`); }
}

async function chooseFolder(mode, matching = null) {
  if (inputsBusy()) return;
  addFolderMatch = matching;
  // VS Code's embedded Electron browser can leave showDirectoryPicker active indefinitely.
  if (!window.showDirectoryPicker || /\bCode\/[\d.]+/.test(navigator.userAgent)) {
    if (mode === 'replace') openFilePicker('folder-input');
    else { addFolderMode = mode; addFolderMatch = matching; openFilePicker('add-folder-input'); }
    return;
  }
  const inputVersion = state.inputVersion;
  pickerFolderMode = mode;
  setPickerOpen(true);
  const serial = pickerSerial;
  try {
    const root = await window.showDirectoryPicker({ mode: 'read' });
    if (serial !== pickerSerial || inputVersion !== state.inputVersion) return;
    setPickerOpen(false);
    await ingest([], mode, root, matching);
  } catch (error) {
    if (serial === pickerSerial) {
      showNotice(error.name === 'AbortError'
        ? 'No folder was selected. If the picker did not open, try a regular browser.'
        : `Could not open folder picker: ${error.message}`);
    }
  } finally {
    if (serial === pickerSerial) setPickerOpen(false);
  }
}

for (const id of ['choose-folder', 'empty-folder']) $(id).addEventListener('click', () => chooseFolder('replace'));
for (const id of ['choose-files', 'empty-files']) $(id).addEventListener('click', () => openFilePicker('files-input'));
for (const [id, mode] of [['add-dataset-folder', 'dataset'], ['add-masks-folder', 'masks']]) $(id).addEventListener('click', () => {
  $('add-folder-menu').open = false;
  if (mode === 'masks') openMatchingDialog('new');
  else chooseFolder(mode);
});
$('add-folder-menu').querySelector('summary').addEventListener('click', event => { if (inputsBusy()) event.preventDefault(); });
$('reset-picker').addEventListener('click', () => {
  resetPicker();
  showNotice('Stopped waiting for the picker. If the browser still reports a picker is active, reload the page.');
});
$('fallback-picker').addEventListener('click', () => {
  const mode = pickerFolderMode;
  resetPicker();
  if (mode === 'replace') openFilePicker('folder-input');
  else { addFolderMode = mode; openFilePicker('add-folder-input'); }
});
$('load-sample').addEventListener('click', async () => {
  $('help-menu').open = false;
  $('help-menu').querySelector('summary').focus({ preventScroll: true });
  const inputVersion = ++state.inputVersion;
  cancelIndexing();
  setSampleLoading(true);
  showNotice('Loading sample dataset…');
  try {
    const files = await loadSampleFiles();
    if (inputVersion !== state.inputVersion) return;
    await Promise.all(files.map(async file => {
      try { await loadRaster(fileInfo(file)); }
      catch (error) { throw new Error(`${file.name}: ${error.message}`); }
    }));
    if (inputVersion === state.inputVersion) ingest(files);
  } catch (error) {
    if (inputVersion === state.inputVersion) {
      setSampleLoading(false);
      showNotice(`Could not load sample dataset: ${error.message}`);
    }
  }
});
document.addEventListener('click', event => {
  if (!$('help-menu').contains(event.target)) $('help-menu').open = false;
  if (!$('add-folder-menu').contains(event.target)) $('add-folder-menu').open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('help-menu').open) {
    $('help-menu').open = false;
    $('help-menu').querySelector('summary').focus({ preventScroll: true });
    event.preventDefault();
  }
});
$('clear-dataset').addEventListener('click', clearDataset);
for (const [id, action] of [['add-mask', 'add'], ['replace-mask', 'replace']]) $(id).addEventListener('click', () => {
  maskTarget = { pair: state.pairs[state.index], action };
  openFilePicker('mask-input');
});
async function handleMaskSelection(event) {
  const file = event.target.files[0];
  event.target.value = '';
  const target = maskTarget;
  maskTarget = null;
  if (!file || !target) return;
  const info = { ...fileInfo(file), sourceId: nextSourceId++ };
  if (!info.isNpy && !info.isImage) {
    showNotice('Unsupported mask file. Choose a .npy file or a supported image.');
    return;
  }
  const request = state.request;
  const datasetVersion = state.datasetVersion;
  try {
    if ((await loadRaster(info)).type === 'sequence') throw new Error('Sequence masks are not supported.');
    if (datasetVersion !== state.datasetVersion) return;
    if (state.request !== request || state.pairs[state.index] !== target.pair) {
      showNotice('The selected item changed; the mask was not added. Please try again.');
      return;
    }
    cancelView();
    const index = assignMask(state.pairs, state.index, info, target.action);
    state.datasetVersion++;
    rebuildMaskGroups();
    state.navigation = [];
    state.positions = new Map();
    state.rows = [];
    state.visibleRows = [];
    resetViewer(false);
    renderList();
    updateDatasetCount();
    showNotice(target.action === 'replace' ? 'Mask replaced for this item.' : 'Mask added to the current base.');
    refreshView(index);
  } catch (error) {
    if (datasetVersion !== state.datasetVersion) return;
    showNotice(`Could not load mask ${file.name}: ${error.message}`);
  }
}

function bindPickerInput(input) {
  input.addEventListener('change', event => {
    if (pickerInput !== input) return;
    const stale = pickerVersion !== state.inputVersion;
    setPickerOpen(false);
    if (stale) { input.value = ''; maskTarget = null; return; }
    if (!input.files.length) {
      maskTarget = null;
      showNotice('No files were selected.');
      return;
    }
    if (input.id === 'mask-input') handleMaskSelection(event);
    else {
      ingest(Array.from(input.files), input.id === 'add-folder-input' ? addFolderMode : 'replace', null,
        input.id === 'add-folder-input' ? addFolderMatch : null);
      input.value = '';
    }
  });
  input.addEventListener('cancel', () => {
    if (pickerInput === input) {
      setPickerOpen(false);
      maskTarget = null;
      showNotice('No files were selected.');
    }
  });
}

function resetPicker() {
  if (!state.pickerOpen) return;
  state.inputVersion++;
  if (pickerInput) {
    const replacement = pickerInput.cloneNode();
    pickerInput.replaceWith(replacement);
    bindPickerInput(replacement);
  }
  maskTarget = null;
  setPickerOpen(false);
}

for (const id of ['files-input', 'folder-input', 'add-folder-input', 'mask-input']) bindPickerInput($(id));

function loadedFolders() {
  const folders = new Map();
  function add(info) {
    const parts = info.path.split('/').slice(0, -1);
    if (!parts.length) {
      const folder = { sourceId: info.sourceId, path: '' };
      folders.set(JSON.stringify([folder.sourceId, folder.path]), folder);
      return;
    }
    for (let i = 1; i <= parts.length; i++) {
      const folder = { sourceId: info.sourceId, path: parts.slice(0, i).join('/') };
      folders.set(JSON.stringify([folder.sourceId, folder.path]), folder);
    }
  }
  for (const pair of state.pairs) {
    add(pair.base);
    if (pair.mask) add(pair.mask);
  }
  return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }) || a.sourceId - b.sourceId);
}

function populateFolders(select, folders) {
  select.replaceChildren();
  for (const folder of folders) {
    const option = new Option(`${folder.path || '(individual files)'} (load ${folder.sourceId})`, JSON.stringify(folder));
    select.add(option);
  }
}

const matchingSettingIds = ['match-rule', 'base-prefix', 'base-suffix', 'mask-prefix', 'mask-suffix', 'base-regex', 'mask-regex', 'example-base-search', 'example-mask-search', 'example-base', 'example-mask', 'example-id'];

function matchingSettings() {
  return Object.fromEntries(matchingSettingIds.map(id => [id, $(id).value]));
}

function matchingRule(settings = matchingSettings()) {
  const type = settings['match-rule'];
  if (type === 'example') {
    const baseIndex = settings['example-base'], maskIndex = settings['example-mask'];
    if (baseIndex === '' || maskIndex === '' || !settings['example-id']) throw new Error('Choose a base, a mask, and their shared ID.');
    const base = exampleFiles[Number(baseIndex)], mask = exampleFiles[Number(maskIndex)];
    if (!base || !mask || base.file === mask.file) throw new Error('Choose two different example files.');
    return inferExampleRule(base, mask, settings['example-id']);
  }
  if (type === 'regex') {
    const base = settings['base-regex'], mask = settings['mask-regex'];
    if (!base || !mask) throw new Error('Enter both expressions with a capture group for the shared ID.');
    try { new RegExp(base, 'i'); new RegExp(mask, 'i'); }
    catch (error) { throw new Error(`Invalid matching expression: ${error.message}`); }
    return { type, base, mask };
  }
  if (type === 'affixes') return {
    type, basePrefix: settings['base-prefix'], baseSuffix: settings['base-suffix'],
    maskPrefix: settings['mask-prefix'], maskSuffix: settings['mask-suffix']
  };
  return { type };
}

function openMatchingDialog(mode) {
  if (inputsBusy() || !state.pairs.length) return;
  matchingMode = mode;
  matchingFolders = loadedFolders();
  matchingGroups = new Map();
  activeMatchingGroup = null;
  const seen = new Set();
  exampleFiles = [];
  for (const pair of state.pairs) for (const info of [pair.base, pair.mask]) {
    if (info && !seen.has(info.file)) { seen.add(info.file); exampleFiles.push(info); }
  }
  $('path-search').value = '';
  $('example-base-search').value = '';
  $('example-mask-search').value = '';
  $('match-rule').value = 'default';
  for (const id of ['base-prefix', 'base-suffix', 'mask-prefix', 'mask-suffix', 'base-regex', 'mask-regex']) $(id).value = '';
  $('match-base').replaceChildren();
  $('match-masks').replaceChildren();
  for (const id of ['example-base', 'example-mask', 'example-id']) $(id).replaceChildren();
  if (mode === 'new') {
    $('match-base').add(new Option('All loaded bases (automatic matching)', ''));
    $('match-base').value = '';
  }
  $('mask-drop').hidden = mode === 'new';
  $('new-mask-note').hidden = mode !== 'new';
  $('match-rule').querySelector('[value="example"]').disabled = mode === 'new';
  if (mode === 'new' && $('match-rule').value === 'example') $('match-rule').value = 'default';
  updateRuleFields();
  renderPathCandidates();
  updateExamples();
  invalidateMatchingPreview();
  $('matching-title').textContent = mode === 'new' ? 'Add masks folder' : 'Match loaded folders';
  $('matching-error').hidden = true;
  $('advanced-menu').open = false;
  $('matching-dialog').showModal();
}

function invalidateMatchingPreview() {
  matchingRevision++;
  matchingPreview = null;
  $('match-preview').hidden = true;
  $('matching-submit').textContent = matchingMode === 'new' ? 'Choose masks folder' : 'Preview matches';
}

function updateRuleFields() {
  $('match-affixes').hidden = $('match-rule').value !== 'affixes';
  $('match-regex').hidden = $('match-rule').value !== 'regex';
  $('match-example').hidden = $('match-rule').value !== 'example';
}

function saveMatchingGroup() {
  const group = matchingGroups.get(activeMatchingGroup);
  if (!group) return;
  group.maskFolders = [...$('match-masks').options].map(option => JSON.parse(option.value));
  group.settings = matchingSettings();
}

function displayMatchingGroup(value) {
  activeMatchingGroup = value;
  const group = matchingGroups.get(value);
  $('match-masks').replaceChildren();
  for (const folder of group?.maskFolders || []) {
    $('match-masks').add(new Option(`${folder.path || '(individual files)'} (load ${folder.sourceId})`, JSON.stringify(folder)));
  }
  const settings = group?.settings || {};
  for (const id of matchingSettingIds) {
    if (!['example-base', 'example-mask', 'example-id'].includes(id)) $(id).value = settings[id] ?? (id === 'match-rule' ? 'default' : '');
  }
  $('example-base').replaceChildren();
  $('example-mask').replaceChildren();
  $('example-id').replaceChildren();
  updateRuleFields();
  updateExamples();
  for (const id of ['example-base', 'example-mask']) {
    if ([...$(id).options].some(option => option.value === settings[id])) $(id).value = settings[id];
  }
  updateExampleIds();
  if ([...$('example-id').options].some(option => option.value === settings['example-id'])) $('example-id').value = settings['example-id'];
  updateExampleIds();
}

function assignPath(value, side) {
  const folder = matchingFolders.find(item => JSON.stringify(item) === value);
  if (!folder || (side === 'mask' && matchingMode === 'new')) return;
  const select = $(side === 'base' ? 'match-base' : 'match-masks');
  if (side === 'base' && matchingMode === 'new') select.replaceChildren();
  if (matchingMode === 'loaded' && side === 'mask' && !activeMatchingGroup) {
    $('matching-error').textContent = 'Select a base path before adding mask paths.';
    $('matching-error').hidden = false;
    return;
  }
  if (matchingMode === 'loaded' && side === 'base') {
    saveMatchingGroup();
    if (!matchingGroups.has(value)) matchingGroups.set(value, { baseFolder: folder, maskFolders: [], settings: {} });
  }
  if (![...select.options].some(option => option.value === value)) select.add(new Option(`${folder.path || '(individual files)'} (load ${folder.sourceId})`, value));
  if (side === 'base') {
    select.value = value;
    if (matchingMode === 'loaded') displayMatchingGroup(value);
  }
  $('matching-error').hidden = true;
  invalidateMatchingPreview();
  updateExamples();
}

function renderPathCandidates() {
  const list = $('path-candidates');
  const query = $('path-search').value.trim().toLowerCase();
  list.replaceChildren();
  for (const folder of matchingFolders) {
    const label = `${folder.path || '(individual files)'} (load ${folder.sourceId})`;
    if (!label.toLowerCase().includes(query)) continue;
    const value = JSON.stringify(folder);
    const row = document.createElement('div');
    row.className = 'path-candidate';
    row.draggable = true;
    row.title = label;
    row.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', value); event.dataTransfer.effectAllowed = 'copy'; });
    const left = document.createElement('button');
    left.type = 'button'; left.textContent = '←'; left.setAttribute('aria-label', `Use ${label} as base path`);
    left.addEventListener('click', () => assignPath(value, 'base'));
    const text = document.createElement('span'); text.textContent = label;
    const right = document.createElement('button');
    right.type = 'button'; right.textContent = '→'; right.setAttribute('aria-label', `Use ${label} as mask path`);
    right.disabled = matchingMode === 'new';
    right.addEventListener('click', () => assignPath(value, 'mask'));
    row.append(left, text, right);
    list.append(row);
  }
}

for (const [id, side] of [['base-drop', 'base'], ['mask-drop', 'mask']]) {
  const target = $(id);
  target.addEventListener('dragover', event => { event.preventDefault(); target.classList.add('drop-active'); event.dataTransfer.dropEffect = 'copy'; });
  target.addEventListener('dragleave', () => target.classList.remove('drop-active'));
  target.addEventListener('drop', event => { event.preventDefault(); target.classList.remove('drop-active'); assignPath(event.dataTransfer.getData('text/plain'), side); });
}
$('path-search').addEventListener('input', renderPathCandidates);
$('match-base').addEventListener('change', () => {
  if (matchingMode !== 'loaded') { updateExamples(); return; }
  saveMatchingGroup();
  displayMatchingGroup($('match-base').value);
});
$('clear-base-path').addEventListener('click', () => {
  if (matchingMode === 'new') {
    $('match-base').replaceChildren(new Option('All loaded bases (automatic matching)', ''));
  } else if (activeMatchingGroup) {
    matchingGroups.delete(activeMatchingGroup);
    for (const option of [...$('match-base').options]) if (option.value === activeMatchingGroup) option.remove();
    const next = $('match-base').options[0];
    if (next) $('match-base').value = next.value;
    displayMatchingGroup(next?.value || null);
  }
  invalidateMatchingPreview(); updateExamples();
});
$('clear-mask-path').addEventListener('click', () => {
  for (const option of [...$('match-masks').selectedOptions]) option.remove();
  invalidateMatchingPreview(); updateExamples();
});

function updateExamples() {
  const baseFolder = $('match-base').value ? JSON.parse($('match-base').value) : null;
  const maskFolders = [...$('match-masks').options].map(option => JSON.parse(option.value));
  for (const [side, folders] of [['base', baseFolder ? [baseFolder] : []], ['mask', maskFolders]]) {
    const select = $(`example-${side}`), previous = select.value;
    const query = $(`example-${side}-search`).value.trim().toLowerCase();
    select.replaceChildren(new Option('Select a file', ''));
    let count = 0;
    exampleFiles.forEach((info, index) => {
      if (count < 100 && folders.some(folder => inFolder(info, folder)) && info.path.toLowerCase().includes(query)) {
        select.add(new Option(info.path, String(index))); count++;
      }
    });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  updateExampleIds();
}

function updateExampleIds() {
  const baseValue = $('example-base').value, maskValue = $('example-mask').value;
  const base = baseValue === '' ? null : exampleFiles[Number(baseValue)];
  const mask = maskValue === '' ? null : exampleFiles[Number(maskValue)];
  const select = $('example-id'), previous = select.value;
  select.replaceChildren(new Option('Select shared ID', ''));
  if (base && mask) {
    const ids = text => [...new Set((text.match(/[a-z]+|\d+/gi) || []).map(id => /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, '') : id.toLowerCase()))];
    const other = new Set(ids(mask.stem));
    for (const id of ids(base.stem)) if (other.has(id)) select.add(new Option(id, id));
  }
  if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
  else if (select.options.length === 2) select.selectedIndex = 1;
  if ($('match-rule').value !== 'example') { $('example-rule').textContent = ''; return; }
  try {
    const rule = matchingRule();
    $('example-rule').textContent = `Base: ${rule.base}   Mask: ${rule.mask}`;
  } catch (error) { $('example-rule').textContent = error.message; }
}
for (const id of ['example-base-search', 'example-mask-search']) $(id).addEventListener('input', updateExamples);
for (const id of ['example-base', 'example-mask', 'example-id']) $(id).addEventListener('change', updateExampleIds);
$('match-rule').addEventListener('change', () => { updateRuleFields(); updateExampleIds(); });
$('matching-form').addEventListener('input', invalidateMatchingPreview);
$('matching-form').addEventListener('change', invalidateMatchingPreview);
$('matching-dialog').addEventListener('close', () => {
  if (matchingPending) { state.inputVersion++; cancelIndexing(); }
  matchingPending = false;
  $('matching-submit').disabled = false;
});
$('match-loaded').addEventListener('click', () => openMatchingDialog('loaded'));
$('matching-cancel').addEventListener('click', () => $('matching-dialog').close());
$('matching-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (matchingMode === 'new') {
      const rule = matchingRule();
      const baseValue = $('match-base').value;
      if (!baseValue && rule.type !== 'default') throw new Error('Choose a base folder for custom matching.');
      const baseFolder = baseValue ? JSON.parse(baseValue) : null;
      $('matching-dialog').close();
      chooseFolder(baseFolder ? 'selected-masks' : 'masks', baseFolder ? { baseFolder, rule } : null);
      return;
    }
    if (matchingPreview) {
      const { result, datasetVersion } = matchingPreview;
      if (datasetVersion !== state.datasetVersion) throw new Error('The dataset changed. Preview the matches again.');
      const selected = state.pairs[state.index];
      $('matching-dialog').close();
      replacePairs(result.pairs, selected);
      showNotice(`Matched ${result.matched} mask(s); ${result.unmatched} unmatched or ambiguous.`);
      return;
    }
    saveMatchingGroup();
    if (!matchingGroups.size) throw new Error('Choose at least one base path.');
    const groups = [...matchingGroups.values()].map(group => {
      const label = `${group.baseFolder.path || '(individual files)'} (load ${group.baseFolder.sourceId})`;
      if (!group.maskFolders.length) throw new Error(`Choose at least one mask path for ${label}.`);
      try {
        return { baseFolder: group.baseFolder, maskFolders: group.maskFolders, rule: matchingRule(group.settings) };
      } catch (error) {
        throw new Error(`${label}: ${error.message}`);
      }
    });
    const selected = state.pairs[state.index];
    const datasetVersion = state.datasetVersion;
    const inputVersion = ++state.inputVersion;
    const revision = matchingRevision;
    matchingPending = true;
    $('matching-submit').disabled = true;
    setIndexing(true, 'Matching folders…');
    try {
      const result = await matchInWorker(state.pairs, groups, inputVersion);
      if (!result || inputVersion !== state.inputVersion) return;
      if (datasetVersion !== state.datasetVersion) throw new Error('The dataset changed. Please try matching again.');
      setIndexing(false);
      if (revision !== matchingRevision) return;
      matchingPreview = { result, datasetVersion, selected };
      $('preview-summary').textContent = `${result.matched} proposed match(es); ${result.unmatched} unmatched or ambiguous.`;
      $('preview-groups').replaceChildren(...result.groupResults.map(group => {
        const item = document.createElement('li');
        item.textContent = `${group.path || '(individual files)'} (load ${group.sourceId}): ${group.matched} proposed, ${group.unmatched} unmatched or ambiguous`;
        return item;
      }));
      $('preview-pairs').replaceChildren(...result.preview.map(pair => {
        const item = document.createElement('li'); item.textContent = `${pair.base} → ${pair.mask}`; return item;
      }));
      $('match-preview').hidden = false;
      $('matching-submit').textContent = 'Apply matches';
      $('matching-error').hidden = true;
    } catch (error) {
      if (inputVersion === state.inputVersion) { setIndexing(false); $('matching-error').textContent = `Could not match folders: ${error.message}`; $('matching-error').hidden = false; }
    } finally {
      matchingPending = false;
      $('matching-submit').disabled = false;
    }
  } catch (error) {
    $('matching-error').textContent = error.message;
    $('matching-error').hidden = false;
  }
});

$('remove-folders').addEventListener('click', () => {
  if (inputsBusy() || !state.pairs.length) return;
  populateFolders($('remove-paths'), loadedFolders());
  $('remove-subfolders').checked = false;
  $('remove-error').hidden = true;
  $('advanced-menu').open = false;
  $('remove-dialog').showModal();
});
$('remove-cancel').addEventListener('click', () => $('remove-dialog').close());
$('remove-form').addEventListener('submit', event => {
  event.preventDefault();
  const folders = [...$('remove-paths').selectedOptions].map(option => JSON.parse(option.value));
  if (!folders.length) {
    $('remove-error').textContent = 'Select at least one folder to remove.';
    $('remove-error').hidden = false;
    return;
  }
  const selected = state.pairs[state.index];
  const pairs = removeFolders(state.pairs, folders, $('remove-subfolders').checked);
  $('remove-dialog').close();
  replacePairs(pairs, selected);
  showNotice('Selected folders removed from the viewer; local files were not changed.');
});
$('mask-select').addEventListener('change', event => select(Number(event.target.value)));
$('match-mask-size').addEventListener('change', event => {
  canvasStack.classList.toggle('match-mask-size', event.target.checked);
});
$('swap-layers').addEventListener('click', () => {
  const pair = state.pairs[state.index];
  if (!pair?.mask) return;
  pair.swapped = !pair.swapped;
  updateLayerOrder();
});
function navigate(offset) {
  const position = state.positions.get(state.index);
  if (position !== undefined) select(state.navigation[position + offset]);
}
$('previous').addEventListener('click', () => navigate(-1));
$('next').addEventListener('click', () => navigate(1));
for (const id of ['filter-items', 'sort-items', 'group-items', 'tree-toggle']) $(id).addEventListener('change', () => refreshView());
for (const direction of ['asc', 'desc']) $(`sort-${direction}`).addEventListener('click', () => {
  for (const option of ['asc', 'desc']) {
    const button = $(`sort-${option}`);
    button.disabled = option === direction;
    button.setAttribute('aria-pressed', String(option === direction));
  }
  $(`sort-${direction === 'asc' ? 'desc' : 'asc'}`).focus({ preventScroll: true });
  refreshView();
});
$('jump-index').addEventListener('change', event => {
  const input = event.target, value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > state.navigation.length) {
    $('index-error').textContent = `Enter an item number between 1 and ${state.navigation.length}.`;
    $('index-error').hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.value = (state.positions.get(state.index) ?? 0) + 1;
    return;
  }
  select(state.navigation[value - 1]);
});
const datasetList = $('dataset-list');
const fileMenu = $('file-menu');
function closeFileMenu(restoreFocus = false) {
  fileMenu.hidden = true;
  if (restoreFocus && contextOrigin?.isConnected) contextOrigin.focus({ preventScroll: true });
  metadataRequest++;
  $('copy-file-metadata').hidden = true;
  $('copy-file-metadata').dataset.metadata = '';
  $('file-menu-separator').hidden = true;
  contextInfo = null;
  contextOrigin = null;
}

datasetList.addEventListener('contextmenu', event => {
  const item = event.target.closest('.dataset-item, .mask-item');
  if (!item) return;
  const pair = state.pairs[Number(item.dataset.index)];
  const info = item.classList.contains('mask-item') ? pair?.mask : pair?.base;
  if (!info) return;
  event.preventDefault();
  contextInfo = info;
  contextOrigin = item;
  const request = ++metadataRequest;
  $('copy-file-metadata').hidden = true;
  $('copy-file-metadata').dataset.metadata = '';
  $('file-menu-separator').hidden = true;
  $('file-menu-name').textContent = info.name;
  $('file-menu-name').title = info.path;
  const hasPath = info.path !== info.name;
  $('copy-file-path').disabled = !hasPath;
  $('file-menu-note').textContent = `${hasPath ? '' : 'No relative path is available for this file. '}Browsers cannot reveal local folders or access absolute paths.`;
  
  resolveFile(info.file).then(file => extractMetadata(file)).then(metadata => {
    if (request !== metadataRequest || contextInfo !== info) return;
    if (metadata) {
      metadata.filename = info.path;
      $('copy-file-metadata').hidden = false;
      $('file-menu-separator').hidden = false;
      $('copy-file-metadata').dataset.metadata = JSON.stringify(metadata);
    } else {
      $('copy-file-metadata').hidden = true;
      $('file-menu-separator').hidden = true;
    }
  }).catch(error => {
    if (request !== metadataRequest || contextInfo !== info) return;
    console.error('Error extracting metadata:', error);
    $('copy-file-metadata').hidden = true;
    $('file-menu-separator').hidden = true;
  });
  
  fileMenu.hidden = false;
  const rect = item.getBoundingClientRect();
  const x = event.clientX || rect.left;
  const y = event.clientY || rect.bottom;
  fileMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - fileMenu.offsetWidth - 8))}px`;
  fileMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - fileMenu.offsetHeight - 8))}px`;
  $('copy-file-name').focus({ preventScroll: true });
});
for (const [id, property, description] of [['copy-file-name', 'name', 'File name'], ['copy-file-path', 'path', 'Relative path']]) $(id).addEventListener('click', async () => {
  if (!contextInfo) return;
  const value = contextInfo[property];
  const datasetVersion = state.datasetVersion;
  closeFileMenu(true);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable; use HTTPS or localhost.');
    await navigator.clipboard.writeText(value);
    if (datasetVersion === state.datasetVersion) showNotice(`${description} copied.`);
  } catch (error) {
    if (datasetVersion === state.datasetVersion) showNotice(`Could not copy ${description.toLowerCase()}: ${error.message}`);
  }
});

$('copy-file-metadata').addEventListener('click', async () => {
  if (!contextInfo || !$('copy-file-metadata').dataset.metadata) return;
  const datasetVersion = state.datasetVersion;
  const metadata = JSON.parse($('copy-file-metadata').dataset.metadata);
  const formattedMetadata = formatMetadata(metadata);
  closeFileMenu(true);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable; use HTTPS or localhost.');
    await navigator.clipboard.writeText(formattedMetadata);
    if (datasetVersion === state.datasetVersion) showNotice('Metadata copied.');
  } catch (error) {
    if (datasetVersion === state.datasetVersion) showNotice(`Could not copy metadata: ${error.message}`);
  }
});
document.addEventListener('pointerdown', event => {
  if (!fileMenu.hidden && !fileMenu.contains(event.target)) closeFileMenu();
});
fileMenu.addEventListener('focusout', event => {
  if (!fileMenu.hidden && !fileMenu.contains(event.relatedTarget)) closeFileMenu();
});
document.addEventListener('contextmenu', event => {
  if (!fileMenu.hidden && !datasetList.contains(event.target) && !fileMenu.contains(event.target)) closeFileMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !fileMenu.hidden) {
    closeFileMenu(true);
    event.preventDefault();
  }
});
document.addEventListener('scroll', () => { if (!fileMenu.hidden) closeFileMenu(); }, true);
window.addEventListener('resize', () => { if (!fileMenu.hidden) closeFileMenu(); });
let listRenderScheduled = false;
function scheduleListRender() {
  if (listRenderScheduled) return;
  listRenderScheduled = true;
  requestAnimationFrame(() => { listRenderScheduled = false; if (state.pairs.length) renderList(false, true); });
}
datasetList.addEventListener('scroll', scheduleListRender);
new ResizeObserver(scheduleListRender).observe(datasetList);
datasetList.addEventListener('keydown', event => {
  if (!state.navigation.length || event.target.closest('.dataset-folder')) return;
  let index = state.positions.get(state.index) ?? 0;
  if (event.key === 'ArrowDown') index++;
  else if (event.key === 'ArrowUp') index--;
  else if (event.key === 'PageDown') index += Math.max(1, Math.floor(datasetList.clientHeight / ROW_HEIGHT));
  else if (event.key === 'PageUp') index -= Math.max(1, Math.floor(datasetList.clientHeight / ROW_HEIGHT));
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = state.navigation.length - 1;
  else return;
  event.preventDefault();
  select(state.navigation[Math.max(0, Math.min(state.navigation.length - 1, index))]);
  datasetList.focus({ preventScroll: true });
});
$('opacity').addEventListener('input', () => { $('opacity-value').value = `${$('opacity').value}%`; updateLayerOrder(); });
$('zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('zoom-fit').addEventListener('click', resetZoom);
canvasWrap.addEventListener('wheel', event => {
  if (event.target.closest?.('.zoom-controls')) return;
  event.preventDefault();
  setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY });
}, { passive: false });
canvasWrap.addEventListener('pointerdown', event => {
  if (zoom <= 1 || event.target.closest?.('.zoom-controls') || event.button !== 0) return;
  panPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
  canvasWrap.classList.add('panning');
  canvasWrap.setPointerCapture(event.pointerId);
  event.preventDefault();
});
canvasWrap.addEventListener('pointermove', event => {
  if (!panPointer || panPointer.id !== event.pointerId) return;
  panX = panPointer.panX + event.clientX - panPointer.x;
  panY = panPointer.panY + event.clientY - panPointer.y;
  updateZoom();
});
function finishPanning(event) {
  if (!panPointer || panPointer.id !== event.pointerId) return;
  panPointer = null;
  canvasWrap.classList.remove('panning');
  if (canvasWrap.hasPointerCapture(event.pointerId)) canvasWrap.releasePointerCapture(event.pointerId);
}
canvasWrap.addEventListener('pointerup', finishPanning);
canvasWrap.addEventListener('pointercancel', finishPanning);
$('colormap').addEventListener('change', () => { $('color-ramp').style.background = `linear-gradient(to right, ${colorStops($('colormap').value).join(', ')})`; try { render(); } catch (error) { setError(`Could not render: ${error.message}`); } });
$('apply-axes').addEventListener('click', () => {
  if (!sequence) return;
  stopPlayback();
  sequenceVersion++;
  const axes = Object.fromEntries(['frame', 'height', 'width', 'channel'].map(role => {
    const value = $(`axis-${role}`).value;
    return [role, value === '' ? null : Number(value)];
  }));
  const shape = sequence.header.shape;
  const invalid = message => { $('status').textContent = 'Unable to load frame'; setError(message); };
  const assigned = Object.values(axes).filter(axis => axis !== null);
  if (new Set(assigned).size !== assigned.length) return invalid('Choose a different axis for each role.');
  if (axes.channel !== null && ![1, 3, 4].includes(shape[axes.channel])) return invalid('The channel axis must have length 1, 3, or 4.');
  sequence.axes = axes;
  sequence.extra = Object.fromEntries(extraAxes(shape, axes).map(axis => [axis, sequence.extra[axis] ?? 0]));
  renderExtraAxisControls();
  showFrame(0);
});
function selectExtra(axis, extra) {
  if (!sequence) return;
  const total = sequence.header.shape[axis];
  if (!Number.isInteger(extra) || extra < 0 || extra >= total) {
    setError(`Extra axis index must be between 1 and ${total}.`);
    updateFrameControls();
    return;
  }
  stopPlayback();
  sequence.extra[axis] = extra;
  showFrame(sequence.frame);
}
$('extra-controls').addEventListener('click', event => {
  const button = event.target.closest('button[data-axis]');
  if (!button || !sequence) return;
  const axis = Number(button.dataset.axis);
  selectExtra(axis, (sequence.extra[axis] ?? 0) + Number(button.dataset.direction));
});
$('extra-controls').addEventListener('change', event => {
  const input = event.target.closest('input[data-axis]');
  if (input) selectExtra(Number(input.dataset.axis), Number(input.value) - 1);
});
$('frame-previous').addEventListener('click', () => { if (sequence && sequence.frame > 0) { stopPlayback(); showFrame(sequence.frame - 1); } });
$('frame-next').addEventListener('click', () => { if (sequence && sequence.frame + 1 < sequence.header.shape[sequence.axes.frame]) { stopPlayback(); showFrame(sequence.frame + 1); } });
$('frame-number').addEventListener('change', () => {
  if (!sequence) return;
  const frame = Number($('frame-number').value) - 1;
  if (!Number.isInteger(frame) || frame < 0 || frame >= sequence.header.shape[sequence.axes.frame]) {
    setError(`Frame number must be between 1 and ${sequence.header.shape[sequence.axes.frame]}.`);
    updateFrameControls();
    return;
  }
  stopPlayback();
  showFrame(frame);
});
$('frame-play').addEventListener('click', () => {
  if (!sequence) return;
  if (playing) return stopPlayback();
  const fps = Number($('frame-fps').value);
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) return setError('FPS must be an integer between 1 and 30.');
  playbackFps = fps;
  playing = true;
  $('frame-play').textContent = 'Pause';
  $('frame-play').setAttribute('aria-pressed', 'true');
  showFrame(sequence.frame + 1 >= sequence.header.shape[sequence.axes.frame] ? 0 : sequence.frame);
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || $('help-menu').contains(document.activeElement) || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) return;
  if (event.key === 'ArrowLeft') navigate(-1);
  if (event.key === 'ArrowRight') navigate(1);
});
const dropZone = $('drop-zone');
for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', event => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', async event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  if (inputsBusy()) { showNotice('Wait for the current operation to finish, or clear the dataset to cancel it.'); return; }
  const inputVersion = ++state.inputVersion;
  cancelIndexing();
  setIndexing(true);
  showNotice('Reading dropped files…');
  if (state.sampleLoading) {
    setSampleLoading(false);
  }
  try {
    const items = Array.from(event.dataTransfer.items);
    const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    const files = entries.length === items.length && entries.length ? await readDroppedEntries(entries, inputVersion) : Array.from(event.dataTransfer.files);
    if (inputVersion === state.inputVersion) {
      if (files.length) ingest(files);
      else { setIndexing(false); showNotice('No files found in the drop.'); }
    }
  } catch (error) { if (inputVersion === state.inputVersion) { setIndexing(false); showNotice(`Could not read the dropped files: ${error.message}`); } }
});

const sidebarResizer = $('sidebar-resizer');
const app = document.querySelector('.app');
const sidebar = $('sidebar');
function sidebarMaxWidth() {
  return Math.min(600, Math.max(220, window.innerWidth - (window.innerWidth > 1100 ? 652 : 360)));
}
function updateSidebarWidth(width) {
  const max = sidebarMaxWidth();
  const value = Math.round(Math.max(220, Math.min(max, width)));
  app.style.setProperty('--sidebar-width', `${value}px`);
  sidebarResizer.setAttribute('aria-valuemax', String(max));
  sidebarResizer.setAttribute('aria-valuenow', String(value));
  sidebarResizer.setAttribute('aria-valuetext', `${value} pixels`);
}
function syncSidebarWidth() {
  if (window.innerWidth <= 700) return;
  const value = Math.round(sidebar.getBoundingClientRect().width);
  sidebarResizer.setAttribute('aria-valuemax', String(sidebarMaxWidth()));
  sidebarResizer.setAttribute('aria-valuenow', String(value));
  sidebarResizer.setAttribute('aria-valuetext', `${value} pixels`);
}
sidebarResizer.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startWidth = sidebar.getBoundingClientRect().width;
  sidebarResizer.focus({ preventScroll: true });
  sidebarResizer.setPointerCapture(event.pointerId);
  const move = moveEvent => updateSidebarWidth(startWidth + moveEvent.clientX - startX);
  const finish = () => {
    sidebarResizer.removeEventListener('pointermove', move);
    sidebarResizer.removeEventListener('lostpointercapture', finish);
  };
  sidebarResizer.addEventListener('pointermove', move);
  sidebarResizer.addEventListener('lostpointercapture', finish);
  event.preventDefault();
});
sidebarResizer.addEventListener('keydown', event => {
  const width = sidebar.getBoundingClientRect().width;
  if (event.key === 'ArrowLeft') updateSidebarWidth(width - 10);
  else if (event.key === 'ArrowRight') updateSidebarWidth(width + 10);
  else if (event.key === 'Home') updateSidebarWidth(220);
  else if (event.key === 'End') updateSidebarWidth(sidebarMaxWidth());
  else return;
  event.preventDefault();
});
window.addEventListener('resize', syncSidebarWidth);
syncSidebarWidth();

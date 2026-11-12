import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatasetView, groupBaseRows, pairStatus, visibleDatasetRows } from '../src/dataset-view.js';

const records = [
  { index: 0, name: 'image10.png', path: 'b/image10.png', status: 'paired', size: 20, modified: 100, area: 12 },
  { index: 1, name: 'image2.png', path: 'a/image2.png', status: 'single', size: 10, modified: 300, area: null },
  { index: 2, name: 'image1.png', path: 'a/nested/image1.png', status: 'orphan', size: 30, modified: 200, area: 6 },
  { index: 3, name: 'image3.png', path: 'a/image3.png', status: 'paired', size: 15, modified: 400, area: 9 }
];
const options = { filter: 'all', sort: 'path', direction: 'asc', group: 'none', tree: false };
const items = rows => rows.filter(row => row.kind === 'item').map(row => row.index);

test('classifies paired, single and orphan items', () => {
  assert.equal(pairStatus({ base: { isMask: true }, mask: {} }), 'paired');
  assert.equal(pairStatus({ base: { isMask: false }, mask: null }), 'single');
  assert.equal(pairStatus({ base: { isMask: true }, mask: null }), 'orphan');
});

test('filters and sorts by name, bytes, modification time and dimensions', () => {
  assert.deepEqual(items(buildDatasetView(records, { ...options, sort: 'name' })), [2, 1, 3, 0]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, sort: 'size', direction: 'desc' })), [2, 0, 3, 1]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, sort: 'modified' })), [0, 2, 1, 3]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, sort: 'area', direction: 'desc' })), [0, 3, 2, 1]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, filter: 'paired', sort: 'size' })), [3, 0]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, filter: 'single' })), [1]);
  assert.deepEqual(items(buildDatasetView(records, { ...options, filter: 'orphan' })), [2]);
});

test('groups and nests rows while collapse affects visibility but not navigation order', () => {
  const rows = buildDatasetView(records, { ...options, group: 'status', tree: true, sort: 'size', direction: 'desc' });
  assert.deepEqual(rows.filter(row => row.kind === 'group').map(row => row.label), ['Paired (2)', 'Single base (1)', 'Orphan mask (1)']);
  const folder = rows.find(row => row.kind === 'folder' && row.label === 'a');
  const visible = visibleDatasetRows(rows, new Set([folder.key]));
  assert.ok(visible.includes(folder));
  assert.equal(items(visible).includes(3), false);
  assert.equal(items(rows).includes(3), true);
  assert.equal(items(visible).includes(1), true);
});

test('one base expands to its selectable masks without grouping distinct bases', () => {
  const rows = [
    { kind: 'item', index: 0, depth: 0, ancestors: [] },
    { kind: 'item', index: 1, depth: 0, ancestors: [] },
    { kind: 'item', index: 2, depth: 0, ancestors: [] }
  ];
  const bases = [{}, {}];
  const keys = [bases[0], bases[0], bases[1]];
  const group = expanded => groupBaseRows(rows, expanded, index => keys[index], index => index !== 2);
  assert.deepEqual(group(new Set()).map(row => [row.kind, row.index]), [['item', 0], ['item', 2]]);
  const expanded = group(new Set([bases[0]]));
  assert.deepEqual(expanded.map(row => [row.kind, row.index]), [['item', 0], ['mask', 0], ['mask', 1], ['item', 2]]);
  assert.deepEqual(expanded[0].indices, [0, 1]);
  assert.deepEqual(group(new Set([bases[1]])).map(row => row.kind), ['item', 'item']);
});

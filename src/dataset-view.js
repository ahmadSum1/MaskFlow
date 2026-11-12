const compareText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const STATUS_ORDER = ['paired', 'single', 'orphan'];
const STATUS_LABELS = { paired: 'Paired', single: 'Single base', orphan: 'Orphan mask' };

export function pairStatus(pair) {
  return pair.mask ? 'paired' : pair.base.isMask ? 'orphan' : 'single';
}

export function buildDatasetView(records, { filter, sort, direction, group, tree }) {
  const selected = records.filter(record => filter === 'all' || record.status === filter);
  const multiplier = direction === 'desc' ? -1 : 1;
  selected.sort((a, b) => {
    let order = 0;
    if (sort === 'name') order = compareText(a.name, b.name);
    else if (sort === 'path') order = compareText(a.path, b.path);
    else {
      const left = sort === 'size' ? a.size : sort === 'modified' ? a.modified : a.area;
      const right = sort === 'size' ? b.size : sort === 'modified' ? b.modified : b.area;
      if (left == null || right == null) {
        if (left == null && right != null) return 1;
        if (left != null && right == null) return -1;
      } else order = left - right;
    }
    return order * multiplier || compareText(a.path, b.path) || a.index - b.index;
  });
  const groups = group === 'status'
    ? STATUS_ORDER.map(status => ({ key: status, label: STATUS_LABELS[status], records: selected.filter(record => record.status === status) })).filter(item => item.records.length)
    : [{ key: 'all', label: null, records: selected }];
  const rows = [];
  for (const section of groups) {
    if (section.label) rows.push({ kind: 'group', label: `${section.label} (${section.records.length})`, ancestors: [] });
    if (!tree) {
      for (const record of section.records) rows.push({ kind: 'item', index: record.index, depth: 0, ancestors: [] });
      continue;
    }
    const root = { dirs: new Map(), items: [] };
    for (const record of section.records) {
      const parts = record.path.replaceAll('\\', '/').split('/').slice(0, -1);
      let node = root;
      const path = [];
      for (const part of parts) {
        path.push(part);
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, key: JSON.stringify([section.key, ...path]), dirs: new Map(), items: [] });
        node = node.dirs.get(part);
      }
      node.items.push(record.index);
    }
    function append(node, depth, ancestors) {
      for (const index of node.items) rows.push({ kind: 'item', index, depth, ancestors });
      for (const child of [...node.dirs.values()].sort((a, b) => compareText(a.name, b.name))) {
        rows.push({ kind: 'folder', label: child.name, key: child.key, depth, ancestors });
        append(child, depth + 1, [...ancestors, child.key]);
      }
    }
    append(root, 0, []);
  }
  return rows;
}

export function visibleDatasetRows(rows, collapsed) {
  return rows.filter(row => !row.ancestors.some(key => collapsed.has(key)));
}

export function groupBaseRows(rows, expanded, baseKey, hasMask) {
  const grouped = [];
  let bases = new Map();
  for (const row of rows) {
    if (row.kind !== 'item') {
      if (row.kind === 'group') bases = new Map();
      grouped.push(row);
      continue;
    }
    const key = baseKey(row.index);
    let base = bases.get(key);
    if (!base) {
      base = { ...row, key, indices: [] };
      bases.set(key, base);
      grouped.push(base);
    }
    base.indices.push(row.index);
  }
  const result = [];
  for (const row of grouped) {
    result.push(row);
    if (row.kind === 'item' && expanded.has(row.key)) {
      for (const index of row.indices) {
        if (hasMask(index)) result.push({ kind: 'mask', index, depth: row.depth + 1 });
      }
    }
  }
  return result;
}

import { fileInfo, matchFolderGroups, mergePairs, pairFiles } from './core.js';

self.onmessage = async event => {
  try {
    if (event.data.action === 'match-folders') {
      self.postMessage(matchFolderGroups(event.data.pairs, event.data.groups));
      return;
    }
    const { paths, previous, addedStart, mode, roles, root } = event.data;
    if (root) {
      const directories = [{ handle: root, path: root.name }];
      let lastUpdate = 0;
      for (let i = 0; i < directories.length; i++) {
        const { handle, path } = directories[i];
        for await (const entry of handle.values()) {
          const relativePath = `${path}/${entry.name}`;
          if (entry.kind === 'directory') directories.push({ handle: entry, path: relativePath });
          else if (entry.kind === 'file') {
            paths.push(relativePath);
            if (paths.length % 256 === 0 && Date.now() - lastUpdate >= 100) {
              self.postMessage({ progress: paths.length - addedStart });
              lastUpdate = Date.now();
            }
          }
        }
      }
      self.postMessage({ indexing: paths.length - addedStart });
    }
    const files = paths.map((path, index) => ({ name: path.split('/').pop(), relativePath: path, index }));
    let pairs;
    if (mode === 'replace') pairs = pairFiles(files);
    else {
      const infos = files.slice(0, addedStart).map((file, index) => ({ ...fileInfo(file), isMask: roles[index] }));
      const existing = previous.map(([base, mask], oldIndex) => ({ base: infos[base], mask: mask < 0 ? null : infos[mask], oldIndex }));
      if (mode === 'selected-masks') {
        const masks = files.slice(addedStart).map(fileInfo).filter(info => info.key && (info.isImage || info.isNpy));
        pairs = existing.concat(masks.map(info => ({ base: { ...info, isMask: true }, mask: null })));
      } else pairs = mergePairs(existing, files.slice(addedStart), mode);
    }
    const used = new Set();
    const indices = pairs.map(({ base, mask, oldIndex }) => {
      used.add(base.file.index);
      if (mask) used.add(mask.file.index);
      return [base.file.index, mask ? mask.file.index : -1, oldIndex ?? -1];
    });
    self.postMessage({ indices, ignored: files.slice(addedStart).filter(file => !used.has(file.index)).length, addedPaths: root ? paths.slice(addedStart) : null });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

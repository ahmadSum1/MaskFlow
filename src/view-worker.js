import { buildDatasetView } from './dataset-view.js';
import { readDimensions } from './dimensions.js';
import { resolveFile } from './core.js';

self.onmessage = async event => {
  try {
    const { records, options } = event.data;
    const dimensions = [];
    const metadata = [];
    if (options.sort === 'size' || options.sort === 'modified') {
      const pending = records.filter(record => record.file);
      for (let i = 0; i < pending.length; i += 16) {
        await Promise.all(pending.slice(i, i + 16).map(async record => {
          try {
            const file = await resolveFile(record.file);
            record[options.sort] = options.sort === 'size' ? file.size : file.lastModified;
          } catch (error) {
            record[options.sort] = null;
            metadata.push({ index: record.index, error: error.message });
          }
          delete record.file;
        }));
        if ((i + 16) % 256 === 0 || i + 16 >= pending.length) self.postMessage({ progress: Math.min(i + 16, pending.length), total: pending.length });
      }
    }
    if (options.sort === 'area') {
      const pending = records.filter(record => record.file);
      for (let i = 0; i < pending.length; i += 16) {
        await Promise.all(pending.slice(i, i + 16).map(async record => {
          try {
            const { width, height } = await readDimensions(await resolveFile(record.file));
            record.area = width * height;
            dimensions.push({ index: record.index, area: record.area });
          } catch (error) {
            record.area = null;
            dimensions.push({ index: record.index, area: null, error: error.message });
          }
          delete record.file;
        }));
        if ((i + 16) % 256 === 0 || i + 16 >= pending.length) self.postMessage({ progress: Math.min(i + 16, pending.length), total: pending.length });
      }
    }
    const rows = buildDatasetView(records, options);
    self.postMessage({ rows, dimensions, metadata });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

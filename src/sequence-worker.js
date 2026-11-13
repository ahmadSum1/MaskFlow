import { readSequenceFrame } from './sequence.js';

let file, header, version = 0;

self.onmessage = async event => {
  const { type, id, frame, axes, extra } = event.data;
  if (type === 'init') {
    ({ file, header } = event.data);
    return;
  }
  const current = ++version;
  if (type !== 'read') return;
  try {
    const raster = await readSequenceFrame(file, header, axes, frame, extra, () => current !== version);
    if (current === version) self.postMessage({ id, raster }, [raster.values.buffer]);
  } catch (error) {
    if (current === version) self.postMessage({ id, error: error.message });
  }
};

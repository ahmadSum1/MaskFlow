export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_PREFETCH_FRAMES = 1023;
const MAX_CACHE_FRAMES = MAX_PREFETCH_FRAMES + 1;

export class SequenceFrameCache {
  constructor(file, header, worker = new Worker(new URL('./sequence-worker.js', import.meta.url), { type: 'module' })) {
    this.header = header;
    this.worker = worker;
    this.cache = new Map();
    this.bytes = 0;
    this.serial = 0;
    this.maxBytes = DEFAULT_CACHE_BYTES;
    this.active = null;
    this.configKey = null;
    this.failure = null;
    worker.onmessage = event => this.receive(event.data);
    worker.onerror = event => {
      this.failure = new Error(`Frame worker failed: ${event.message}`);
      this.cancel(this.failure);
    };
    worker.postMessage({ type: 'init', file, header });
  }

  cancel(error = new Error('Frame loading cancelled.')) {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    this.worker.postMessage({ type: 'cancel' });
    active.reject(error);
  }

  dispose() {
    this.cancel();
    this.worker.terminate();
    this.cache.clear();
    this.bytes = 0;
  }

  setLimit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid frame cache limit.');
    this.maxBytes = bytes;
    if (!this.axes) return;
    const end = this.anchor + this.prefetchCount();
    if (this.active?.background && (this.active.frame <= this.anchor || this.active.frame > end)) this.cancel();
    this.trimCache(0);
    this.nextPrefetch = this.anchor + 1;
    this.prefetch();
  }

  trimCache(incomingBytes, incomingFrames = 0) {
    const end = this.anchor + this.prefetchCount();
    while ((this.bytes + incomingBytes > this.maxBytes || this.cache.size + incomingFrames > MAX_CACHE_FRAMES) && this.cache.size) {
      let outside;
      for (const frame of this.cache.keys()) {
        if (frame < this.anchor || frame > end) { outside = frame; break; }
      }
      const oldest = outside ?? this.cache.keys().next().value;
      this.bytes -= this.cache.get(oldest).values.byteLength;
      this.cache.delete(oldest);
    }
  }

  getFrame(axes, frame, extra) {
    if (this.failure) return Promise.reject(this.failure);
    const key = JSON.stringify([axes, extra]);
    if (key !== this.configKey) {
      this.cancel();
      this.cache.clear();
      this.bytes = 0;
      this.configKey = key;
      this.axes = { ...axes };
      this.extra = { ...extra };
    }
    this.anchor = frame;
    this.nextPrefetch = frame + 1;
    const cached = this.cache.get(frame);
    if (cached) {
      this.cache.delete(frame);
      this.cache.set(frame, cached);
      if (this.active && (this.active.frame <= frame || this.active.frame > frame + this.prefetchCount())) this.cancel();
      this.prefetch();
      return Promise.resolve(cached);
    }
    if (this.active?.frame === frame) {
      this.active.background = false;
      return this.active.promise;
    }
    this.cancel();
    return this.start(frame, false);
  }

  prefetchCount() {
    const { shape } = this.header;
    const { height, width, channel } = this.axes;
    const bytes = shape[height] * shape[width] * (channel === null ? 1 : shape[channel]) * 8;
    return Number.isSafeInteger(bytes) && bytes > 0
      ? Math.max(0, Math.min(MAX_PREFETCH_FRAMES, Math.floor(this.maxBytes / bytes) - 1))
      : 0;
  }

  prefetch() {
    if (!this.axes || this.active || this.failure) return;
    const end = Math.min(this.anchor + this.prefetchCount(), this.header.shape[this.axes.frame] - 1);
    while (this.nextPrefetch <= end) {
      const frame = this.nextPrefetch++;
      if (!this.cache.has(frame)) {
        this.start(frame, true).catch(error => {
          if (error.message !== 'Frame loading cancelled.') console.warn('Background frame caching failed:', error);
        });
        break;
      }
    }
  }

  start(frame, background) {
    const id = ++this.serial;
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    this.active = { id, frame, resolve, reject, promise, background };
    this.worker.postMessage({ type: 'read', id, frame, axes: this.axes, extra: this.extra });
    return promise;
  }

  receive(message) {
    const active = this.active;
    if (!active || message.id !== active.id) return;
    this.active = null;
    if (message.error) {
      active.reject(new Error(message.error));
      return;
    }
    const raster = message.raster;
    const size = raster.values.byteLength;
    if (size <= this.maxBytes) {
      this.trimCache(size, 1);
      this.cache.set(active.frame, raster);
      this.bytes += size;
    }
    active.resolve(raster);
    this.prefetch();
  }
}

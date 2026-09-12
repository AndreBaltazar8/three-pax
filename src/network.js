/** Uncached byte stream whose socket consumption does not wait on the scene loader. */
export function fetchAsset(url, { signal, headers, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./network.worker.js', import.meta.url), { type: 'module' });
    let controller, finished = false;
    const cleanup = () => { signal?.removeEventListener('abort', abort); worker.terminate(); };
    const fail = error => { if (finished) return; finished = true; reject(error); controller.error(error); cleanup(); };
    const abort = () => fail(signal.reason || new DOMException('Aborted', 'AbortError'));
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() { finished = true; cleanup(); } });
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => fail(new Error(event.message || 'Network worker failed'));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data.type === 'headers') resolve({ ok: data.status >= 200 && data.status < 300, status: data.status, headers: new Headers(data.headers), body });
      if (data.type === 'chunk') { controller.enqueue(data.value); onProgress({ bytes: data.received, total: data.total, timestamp: data.timestamp, done: false }); }
      if (data.type === 'end') { onProgress({ bytes: data.received, total: data.total, timestamp: data.timestamp, done: true }); finished = true; controller.close(); cleanup(); }
      if (data.type === 'error') fail(new Error(data.message));
    };
    worker.postMessage({ url: new URL(url, location.href).href, headers });
  });
}

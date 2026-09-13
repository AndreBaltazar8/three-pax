/** Uncached stream with bounded worker read-ahead and consumer backpressure. */
export function fetchAsset(
  url,
  {
    signal,
    headers,
    onProgress = () => {},
    maxBufferedBytes = 4 * 1024 * 1024,
    metrics,
  } = {},
) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 65536)
    throw new Error("maxBufferedBytes must be at least 65536");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./network.worker.js", import.meta.url), {
      type: "module",
    });
    let controller,
      finished = false,
      outstanding = 0;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
      controller.error(error);
      cleanup();
    };
    const abort = () =>
      fail(signal.reason || new DOMException("Aborted", "AbortError"));
    const body = new ReadableStream(
      {
        start(c) {
          controller = c;
        },
        pull() {
          const bytes = Math.max(0, controller.desiredSize - outstanding);
          if (bytes && !finished) {
            outstanding += bytes;
            worker.postMessage({ type: "credit", bytes });
          }
        },
        cancel() {
          finished = true;
          cleanup();
        },
      },
      { highWaterMark: maxBufferedBytes, size: (chunk) => chunk.byteLength },
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) =>
      fail(new Error(event.message || "Network worker failed"));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data.type === "headers")
        resolve({
          ok: data.status >= 200 && data.status < 300,
          status: data.status,
          headers: new Headers(data.headers),
          body,
        });
      if (data.type === "chunk") {
        outstanding -= data.value.byteLength;
        controller.enqueue(data.value);
        if (metrics)
          metrics.networkQueuePeakBytes = Math.max(
            metrics.networkQueuePeakBytes || 0,
            maxBufferedBytes - controller.desiredSize,
          );
        onProgress({
          bytes: data.received,
          total: data.total,
          timestamp: data.timestamp,
          done: false,
        });
      }
      if (data.type === "end") {
        onProgress({
          bytes: data.received,
          total: data.total,
          timestamp: data.timestamp,
          done: true,
        });
        finished = true;
        controller.close();
        cleanup();
      }
      if (data.type === "error") fail(new Error(data.message));
    };
    worker.postMessage({ url: new URL(url, location.href).href, headers });
  });
}

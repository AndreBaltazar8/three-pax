// Drain the HTTP response independently of scene decoding and rendering.
// Progress timestamps come from this worker's clock, not from a UI animation.
self.onmessage = async ({ data: { url, headers } }) => {
  let reader;
  try {
    const response = await fetch(url, { cache: 'no-store', headers });
    self.postMessage({ type: 'headers', status: response.status, headers: [...response.headers] });
    if (!response.body) throw new Error('Missing response body');
    const total = Number(response.headers.get('content-length')) || 0; let received = 0;
    reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      received += value.byteLength;
      self.postMessage({ type: 'chunk', value, received, total, timestamp: performance.timeOrigin + performance.now() }, [value.buffer]);
    }
    self.postMessage({ type: 'end', received, total, timestamp: performance.timeOrigin + performance.now() });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
  finally { reader?.releaseLock(); self.close(); }
};

// Bounded read-ahead. Credits represent bytes the consumer has room to receive.
let credit = 0,
  wake;
self.onmessage = async ({ data }) => {
  if (data.type === "credit") {
    credit += data.bytes;
    wake?.();
    wake = null;
    return;
  }
  const { url, headers } = data;
  let reader;
  try {
    const response = await fetch(url, { cache: "no-store", headers });
    self.postMessage({
      type: "headers",
      status: response.status,
      headers: [...response.headers],
    });
    if (!response.body) throw new Error("Missing response body");
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    reader = response.body.getReader();
    while (true) {
      while (credit <= 0)
        await new Promise((resolve) => {
          wake = resolve;
        });
      const { value, done } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        while (credit <= 0)
          await new Promise((resolve) => {
            wake = resolve;
          });
        const amount = Math.min(credit, value.byteLength - offset),
          chunk =
            offset === 0 && amount === value.byteLength
              ? value
              : value.slice(offset, offset + amount);
        offset += amount;
        credit -= amount;
        received += amount;
        const length = value.byteLength;
        self.postMessage(
          {
            type: "chunk",
            value: chunk,
            received,
            total,
            timestamp: performance.timeOrigin + performance.now(),
          },
          [chunk.buffer],
        );
        if (amount === length) break;
      }
    }
    self.postMessage({
      type: "end",
      received,
      total,
      timestamp: performance.timeOrigin + performance.now(),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  } finally {
    reader?.releaseLock();
    self.close();
  }
};

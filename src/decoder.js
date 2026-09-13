import { decodePacket } from "./format.js";
export class PacketDecoder {
  constructor() {
    this.next = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL("./decoder.worker.js", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.value);
    };
    this.worker.onerror = (e) => this.dispose(new Error(e.message));
  }
  run(op, args, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args }, transfer);
    });
  }
  release(buffer) {
    this.worker.postMessage({ op: "release", args: { buffer } }, [buffer]);
  }
  decode = (entry, bytes) =>
    this.run("packet", { entry, bytes }, [bytes.buffer]);
  dispose(error = new Error("Decoder disposed")) {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}

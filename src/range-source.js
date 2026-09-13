import {
  HEADER_BYTES,
  NO_RESOURCE,
  TYPES,
  parseHeader,
  parseDirectory,
  decodePacket,
} from "./format.js";
import { fetchAsset } from "./network.js";
/** A resumable, in-memory session. Each successful packet is applied at most once. */
export class RangeSource {
  constructor(
    url,
    {
      signal,
      onProgress = () => {},
      decode = decodePacket,
      maxBufferedBytes,
      metrics,
    } = {},
  ) {
    Object.assign(this, {
      url,
      signal,
      onProgress,
      decode,
      maxBufferedBytes,
      metrics,
    });
    this.loaded = new Set();
    this.bytes = 0;
  }
  async read(start, end) {
    const before = this.bytes;
    const response = await fetchAsset(this.url, {
      signal: this.signal,
      maxBufferedBytes: this.maxBufferedBytes,
      metrics: this.metrics,
      headers: {
        Range: `bytes=${start}-${end}`,
        ...(this.etag ? { "If-Range": this.etag } : {}),
      },
      onProgress: (e) =>
        this.onProgress({
          ...e,
          bytes: before + e.bytes,
          total: this.header?.fileBytes || 0,
          done: false,
        }),
    });
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !==
        `bytes ${start}-${end}/${this.header?.fileBytes ?? response.headers.get("content-range")?.split("/")[1]}`
    )
      throw new Error("PAX range loading requires a valid HTTP 206 response");
    const tag = response.headers.get("etag");
    if (this.etag && tag !== this.etag)
      throw new Error("Asset changed during range session");
    if (tag) this.etag = tag;
    const data = new Uint8Array(
      await new Response(response.body).arrayBuffer(),
    );
    if (data.length !== end - start + 1)
      throw new Error("Truncated HTTP range");
    this.bytes += data.length;
    return data;
  }
  async open() {
    this.header = parseHeader(await this.read(0, HEADER_BYTES - 1));
    this.entries = parseDirectory(
      await this.read(HEADER_BYTES, this.header.dataOffset - 1),
      this.header,
    );
    return this;
  }
  select({ maxLevel = Infinity, primitives, images, tiles } = {}) {
    const wanted = new Set([0, 1]);
    for (const e of this.entries) {
      if (e.type === TYPES.end) continue;
      if (e.type === TYPES.extension && e.level === 0) {
        wanted.add(e.id);
        continue;
      }
      if (e.level > maxLevel) continue;
      if (
        e.type === TYPES.geometry &&
        primitives &&
        !primitives.includes(e.resource)
      )
        continue;
      if (
        e.type === TYPES.texture &&
        ((images && !images.includes(e.resource)) ||
          (tiles && e.tile !== NO_RESOURCE && !tiles.includes(e.tile)))
      )
        continue;
      wanted.add(e.id);
    }
    // An extension callback is a scene-wide barrier at its scheduled level.
    for (const id of [...wanted])
      if (this.entries[id].type === TYPES.extension)
        for (const e of this.entries)
          if (e.type === TYPES.geometry && e.level <= this.entries[id].level)
            wanted.add(e.id);
    for (const id of [...wanted]) {
      let e = this.entries[id];
      while (e.dependency !== NO_RESOURCE) {
        wanted.add(e.dependency);
        e = this.entries[e.dependency];
      }
    }
    if (
      this.entries.every(
        (e) =>
          e.type === TYPES.end || wanted.has(e.id) || this.loaded.has(e.id),
      )
    )
      wanted.add(this.entries.at(-1).id);
    return [...wanted]
      .sort((a, b) => a - b)
      .filter((id) => !this.loaded.has(id));
  }
  async *packets(options) {
    for (const id of this.select(options)) {
      const entry = this.entries[id],
        bytes = await this.read(entry.offset, entry.offset + entry.packed - 1);
      yield {
        type: entry.type,
        data: await this.decode(entry, bytes),
        entry,
        header: this.header,
        entries: this.entries,
      };
      this.loaded.add(id);
    }
  }
}

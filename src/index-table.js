/** Dense active indices; no JS array is allocated per triangle or patch. */
export class IndexTable {
  constructor(storage, width, initial) {
    this.storage = storage;
    this.width = width;
    this.count = initial.length / width;
    this.ids = new Uint32Array(storage.length / width);
    this.slots = new Map();
    this.dirty = new Uint8Array(Math.ceil(storage.length / 4096));
    storage.set(initial);
    for (let i = 0; i < this.count; i++) {
      this.ids[i] = i;
      this.slots.set(i, i);
    }
  }
  get size() {
    return this.count;
  }
  has(id) {
    return this.slots.has(id);
  }
  get(id) {
    const slot = this.slots.get(id);
    return slot === undefined
      ? undefined
      : this.storage.subarray(slot * this.width, (slot + 1) * this.width);
  }
  mark(slot) {
    const start = slot * this.width,
      end = start + this.width - 1;
    this.dirty[start >>> 12] = 1;
    this.dirty[end >>> 12] = 1;
  }
  remove(id) {
    const slot = this.slots.get(id);
    if (slot === undefined) throw new Error("Removing unknown triangle");
    const last = --this.count;
    this.slots.delete(id);
    if (slot !== last) {
      const moved = this.ids[last];
      this.ids[slot] = moved;
      this.slots.set(moved, slot);
      for (let c = 0; c < this.width; c++)
        this.storage[slot * this.width + c] =
          this.storage[last * this.width + c];
      this.mark(slot);
    }
  }
  add(data, offset, vertexCount) {
    const id = data[offset];
    if (this.slots.has(id) || this.count >= this.ids.length)
      throw new Error("Invalid triangle patch");
    for (let c = 0; c < this.width; c++)
      if (data[offset + 1 + c] >= vertexCount)
        throw new Error("Invalid triangle patch");
    const slot = this.count++;
    this.ids[slot] = id;
    this.slots.set(id, slot);
    for (let c = 0; c < this.width; c++)
      this.storage[slot * this.width + c] = data[offset + 1 + c];
    this.mark(slot);
  }
  order(id, destination) {
    const source = this.slots.get(id);
    if (source === undefined || source < destination)
      throw new Error("Invalid final primitive order");
    if (source === destination) return;
    const other = this.ids[destination];
    this.ids[source] = other;
    this.ids[destination] = id;
    this.slots.set(other, source);
    this.slots.set(id, destination);
    for (let c = 0; c < this.width; c++) {
      const a = destination * this.width + c,
        b = source * this.width + c,
        value = this.storage[a];
      this.storage[a] = this.storage[b];
      this.storage[b] = value;
    }
    this.mark(source);
    this.mark(destination);
  }
  flush(attribute) {
    let bytes = 0;
    for (let i = 0; i < this.dirty.length; i++) {
      if (!this.dirty[i]) continue;
      const start = i * 4096;
      while (i < this.dirty.length && this.dirty[i]) this.dirty[i++] = 0;
      const count = Math.min(i * 4096, this.storage.length) - start;
      attribute.addUpdateRange(start, count);
      bytes += count * 4;
      i--;
    }
    if (bytes) attribute.needsUpdate = true;
    return bytes;
  }
}

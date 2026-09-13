// Runtime-only implementation of the v0 lattice. Wire reference stays unchanged.
import { paeth } from "./textures.js";
export function expandInto(pixels, width, height, out, outWidth, outHeight) {
  const source = new Uint32Array(
      pixels.buffer,
      pixels.byteOffset,
      width * height,
    ),
    target = new Uint32Array(out.buffer, out.byteOffset, outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const row = Math.floor((y * height) / outHeight) * width;
    for (let x = 0; x < outWidth; x++)
      target[y * outWidth + x] =
        source[row + Math.floor((x * width) / outWidth)];
  }
  return out;
}
export class TileWorkspace {
  constructor() {
    this.images = new Map();
    this.pool = [];
    this.scratch = new Uint8Array(0);
    this.metrics = {
      tileBufferAllocations: 0,
      tileAllocatedBytes: 0,
      patchReuses: 0,
    };
  }
  allocate(size) {
    this.metrics.tileBufferAllocations++;
    this.metrics.tileAllocatedBytes += size;
    return new Uint8Array(size);
  }
  init(state) {
    this.images.set(state.image, {
      ...state,
      tiles: new Map(),
      finished: new Set(),
    });
  }
  release(buffer) {
    if (this.pool.length < 2) this.pool.push(buffer);
  }
  patch(meta, filtered) {
    const state = this.images.get(meta.image);
    if (!state) throw new Error("Unknown tile image");
    const {
      tile,
      x,
      y,
      tileWidth: tw,
      tileHeight: th,
      width,
      height,
      axis,
    } = meta;
    if (
      !Number.isInteger(tile) ||
      x < 0 ||
      y < 0 ||
      x + tw > state.fullWidth ||
      y + th > state.fullHeight ||
      !["x", "y"].includes(axis) ||
      state.finished.has(tile)
    )
      throw new Error("Invalid tile bounds or completion");
    let local = state.tiles.get(tile);
    if (!local) {
      const sx = state.fullWidth / state.baseWidth,
        sy = state.fullHeight / state.baseHeight,
        w = tw / sx,
        h = th / sy;
      if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        !Number.isInteger(x / sx) ||
        !Number.isInteger(y / sy)
      )
        throw new Error("Invalid tile grid");
      const data = this.allocate(tw * th * 4),
        src = new Uint32Array(
          state.basePixels.buffer,
          state.basePixels.byteOffset,
        ),
        dst = new Uint32Array(data.buffer);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++)
          dst[j * w + i] = src[(y / sy + j) * state.baseWidth + x / sx + i];
      local = { width: w, height: h, level: 0, data };
      state.tiles.set(tile, local);
    }
    const pw = local.width,
      ph = local.height,
      stride = pw * 4;
    if (
      meta.level !== local.level + 1 ||
      width !== pw * (axis === "x" ? 2 : 1) ||
      height !== ph * (axis === "y" ? 2 : 1) ||
      width > tw ||
      height > th ||
      filtered.length !== (stride + 1) * ph
    )
      throw new Error("Out-of-order tile");
    if (this.scratch.length < tw * th * 4)
      this.scratch = this.allocate(tw * th * 4);
    const out = this.scratch;
    for (let row = 0; row < ph; row++) {
      const filter = filtered[row * (stride + 1)];
      if (filter > 4) throw new Error("Invalid PNG row filter");
      for (let col = 0; col < stride; col++) {
        const i = row * stride + col,
          left = col >= 4 ? out[i - 4] : 0,
          up = row ? out[i - stride] : 0,
          corner = row && col >= 4 ? out[i - stride - 4] : 0;
        out[i] =
          filtered[row * (stride + 1) + 1 + col] +
          (filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, corner)
                  : 0);
      }
    }
    const pixels = new Uint32Array(local.data.buffer),
      missing = new Uint32Array(out.buffer);
    for (let row = ph - 1; row >= 0; row--)
      for (let col = pw - 1; col >= 0; col--) {
        const a = row * pw + col,
          b =
            (axis === "y" ? row * 2 : row) * width +
            (axis === "x" ? col * 2 : col);
        pixels[b] = pixels[a];
        pixels[b + (axis === "x" ? 1 : width)] = missing[a];
      }
    Object.assign(local, { width, height, level: meta.level });
    const size = tw * th * 4,
      index = this.pool.findIndex((b) => b.byteLength === size);
    let patch;
    if (index >= 0) {
      patch = new Uint8Array(this.pool.splice(index, 1)[0]);
      this.metrics.patchReuses++;
    } else patch = this.allocate(size);
    expandInto(local.data, width, height, patch, tw, th);
    if (meta.final) {
      if (width !== tw || height !== th)
        throw new Error("Incomplete final tile");
      state.finished.add(tile);
      state.tiles.delete(tile);
      if (state.finished.size === state.tileCount)
        this.images.delete(meta.image);
    }
    return patch;
  }
}

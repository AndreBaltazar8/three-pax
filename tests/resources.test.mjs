import test from "node:test";
import assert from "node:assert/strict";
import { IndexTable } from "../src/index-table.js";
import { FrameBudget } from "../src/frame-budget.js";
test("dense patches keep stable storage and exact order through removal, append and swaps", () => {
  const storage = new Uint32Array(30),
    table = new IndexTable(
      storage,
      3,
      new Uint32Array([0, 1, 2, 2, 3, 0, 3, 4, 0]),
    );
  table.remove(1);
  table.add(new Uint32Array([10, 4, 5, 0]), 0, 6);
  for (const [i, id] of [10, 0, 2].entries()) table.order(id, i);
  assert.equal(table.storage, storage);
  assert.deepEqual([...storage.subarray(0, 9)], [4, 5, 0, 0, 1, 2, 3, 4, 0]);
  assert.equal(table.size, 3);
  assert.throws(() => table.order(10, 1), /order/);
  assert.throws(() => table.remove(99), /unknown/);
  const attribute = {
    ranges: [],
    addUpdateRange(start, count) {
      this.ranges.push({ start, count });
    },
  };
  table.flush(attribute);
  assert.equal(attribute.ranges.length, 1);
  assert.equal(attribute.needsUpdate, true);
  table.flush(attribute);
  assert.equal(attribute.ranges.length, 1);
});
test("CPU and upload budgets yield, preserve order, and honor cancellation", async () => {
  let clock = 0,
    yields = 0;
  const controller = new AbortController(),
    metrics = {};
  const budget = new FrameBudget({
    frameBudgetMs: 2,
    uploadBudgetBytes: 100,
    signal: controller.signal,
    metrics,
    now: () => clock,
    yieldFrame: async () => {
      yields++;
    },
  });
  await budget.run(() => {
    clock += 1;
  }, 60);
  await budget.run(() => {
    clock += 1;
  }, 60);
  assert.equal(yields, 1);
  await budget.run(() => {
    clock += 2;
  });
  await budget.run(() => {});
  assert.equal(yields, 2);
  assert.equal(metrics.cpuWorkMs, 4);
  assert.equal(metrics.uploadBytes, 120);
  controller.abort();
  await assert.rejects(() => budget.run(() => assert.fail("aborted task ran")));
});

import { TileWorkspace } from "../src/runtime-textures.js";
import { refineTile } from "../src/texture-tiles.js";
test("reused tile buffers match reference pixels with every PNG row filter", () => {
  const workspace = new TileWorkspace(),
    basePixels = new Uint8Array([1, 2, 3, 255]);
  workspace.init({
    image: 0,
    basePixels,
    baseWidth: 1,
    baseHeight: 1,
    fullWidth: 8,
    fullHeight: 4,
    tileCount: 1,
  });
  const reference = {
    basePixels,
    baseWidth: 1,
    baseHeight: 1,
    fullWidth: 8,
    fullHeight: 4,
    tiles: new Map(),
  };
  let width = 1,
    height = 1,
    level = 0,
    firstAllocationCount;
  for (const axis of ["x", "y", "x", "y", "x"]) {
    const filtered = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      filtered[y * (width * 4 + 1)] = level;
      for (let x = 1; x <= width * 4; x++)
        filtered[y * (width * 4 + 1) + x] = (x * 13 + y * 17) & 255;
    }
    width *= axis === "x" ? 2 : 1;
    height *= axis === "y" ? 2 : 1;
    level++;
    const meta = {
      image: 0,
      tile: 0,
      x: 0,
      y: 0,
      tileWidth: 8,
      tileHeight: 4,
      width,
      height,
      axis,
      level,
      final: level === 5,
    };
    const patch = workspace.patch(meta, filtered);
    assert.deepEqual(patch, refineTile(reference, meta, filtered));
    workspace.release(patch.buffer);
    if (level === 1)
      firstAllocationCount = workspace.metrics.tileBufferAllocations;
  }
  assert.equal(workspace.metrics.tileBufferAllocations, firstAllocationCount);
  assert.equal(workspace.metrics.patchReuses, 4);
  assert.equal(workspace.images.size, 0);
});

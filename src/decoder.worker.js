import { decodePacket } from "./format.js";
import { mergeAxis, unfilterRows } from "./textures.js";
import { TileWorkspace, expandInto } from "./runtime-textures.js";
const workspace = new TileWorkspace();
self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    let value;
    if (op === "release") {
      workspace.release(args.buffer);
      return;
    } else if (op === "stats") value = workspace.metrics;
    else if (op === "expand")
      value = expandInto(
        args.pixels,
        args.width,
        args.height,
        new Uint8Array(args.fullWidth * args.fullHeight * 4),
        args.fullWidth,
        args.fullHeight,
      );
    else if (op === "packet")
      value = await decodePacket(args.entry, args.bytes);
    else if (op === "lattice")
      value = mergeAxis(
        args.pixels,
        args.width,
        args.height,
        unfilterRows(args.filtered, args.width, args.height),
        args.axis,
      );
    else if (op === "tile-init") {
      workspace.init(args);
      value = new Uint8Array(0);
    } else if (op === "tile") value = workspace.patch(args.meta, args.filtered);
    else throw new Error("Unknown decode operation");
    self.postMessage({ id, value }, value?.buffer ? [value.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};

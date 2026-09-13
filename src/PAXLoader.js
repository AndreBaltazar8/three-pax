import { MorphStorage } from "./morph-storage.js";
import { FrameBudget } from "./frame-budget.js";
import { IndexTable } from "./index-table.js";
import { TileWorkspace, expandInto } from "./runtime-textures.js";
import * as THREE from "three";
import { PacketDecoder } from "./decoder.js";
import { mipContainer } from "./ktx-mips.js";
import { expandPixels, refineTile } from "./texture-tiles.js";
import { RangeSource } from "./range-source.js";
import { nativeExtensions } from "./extensions.js";
import { fetchAsset } from "./network.js";
import { createGLTFLoader } from "./gltf-loader.js";
import {
  VERSION,
  TYPES,
  COMPONENTS,
  unpackPayload,
  readPackets,
} from "./format.js";
import { mergeAxis, unfilterRows } from "./textures.js";
const names = {
  POSITION: "position",
  NORMAL: "normal",
  TANGENT: "tangent",
  TEXCOORD_0: "uv",
  TEXCOORD_1: "uv1",
  TEXCOORD_2: "uv2",
  TEXCOORD_3: "uv3",
  COLOR_0: "color",
  JOINTS_0: "skinIndex",
  WEIGHTS_0: "skinWeight",
};
const nameOf = (s) =>
  names[s] || (/^TEXCOORD_\d+$/.test(s) ? `uv${s.slice(9)}` : s.toLowerCase());
export class PAXLoader {
  constructor(manager) {
    this.gltfLoader = createGLTFLoader(manager);
    this.extensions = new Map();
  }
  registerExtension(
    name,
    { gltfPlugin, onBase, onRefine, onComplete, onPacket } = {},
  ) {
    if (!name || this.extensions.has(name))
      throw new Error("Invalid or duplicate extension registration");
    this.extensions.set(name, { onBase, onRefine, onComplete, onPacket });
    if (gltfPlugin) this.gltfLoader.register(gltfPlugin);
    return this;
  }
  setDRACOLoader(loader) {
    this.gltfLoader.setDRACOLoader(loader);
    return this;
  }
  setKTX2Loader(loader) {
    this.gltfLoader.setKTX2Loader(loader);
    return this;
  }
  setMeshoptDecoder(decoder) {
    this.gltfLoader.setMeshoptDecoder(decoder);
    return this;
  }

  async load(
    url,
    {
      signal,
      onProgress = () => {},
      onScene = () => {},
      onRefine = () => {},
      transport = "stream",
      maxLevel,
      primitives,
      images,
      tiles,
      worker = true,
      renderer = this.gltfLoader.paxRenderer,
      reuseMorphTextures = true,
      frameBudgetMs = 2,
      uploadBudgetBytes = 8 * 1024 * 1024,
      maxBufferedBytes = 4 * 1024 * 1024,
    } = {},
  ) {
    const lifetime = new AbortController();
    signal = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    const metrics = {
      geometryDisposals: 0,
      textureReplacements: 0,
      textureRectUploads: 0,
      geometryReservedBytes: 0,
      textureReservedBytes: 0,
    };
    const budget = new FrameBudget({
      frameBudgetMs,
      uploadBudgetBytes,
      signal,
      metrics,
    });
    const tileWorkspace = worker ? null : new TileWorkspace();
    let bytes = 0,
      level = 0;
    const decoder = worker ? new PacketDecoder() : null;
    const progress = (event) => {
      bytes = event.bytes;
      onProgress({ ...event, level });
    };
    let range, packets;
    try {
      range =
        transport === "range"
          ? await new RangeSource(url, {
              signal,
              onProgress: progress,
              maxBufferedBytes,
              metrics,
              ...(decoder ? { decode: decoder.decode } : {}),
            }).open()
          : null;
      if (range)
        packets = range.packets({ maxLevel, primitives, images, tiles });
      else {
        const response = await fetchAsset(url, {
          signal,
          onProgress: progress,
          maxBufferedBytes,
          metrics,
        });
        if (!response.ok || !response.body)
          throw new Error(`PAX HTTP ${response.status}`);
        packets = readPackets(response.body, () => {}, decoder?.decode);
      }
    } catch (error) {
      decoder?.dispose();
      lifetime.abort();
      throw error;
    }
    let manifest,
      gltf,
      states,
      imageStates = [],
      complete = false,
      pendingBootstrap = 0,
      scenePublished = false;
    const notify = async (hook, event) => {
      for (const extension of this.extensions.values())
        await extension[hook]?.({ event, gltf, manifest, states, imageStates });
    };
    const publishScene = async () => {
      gltf.prepareGaussianFields?.();
      await notify("onBase", { kind: "base" });
      gltf.interactivity?.start();
      await onScene(gltf, manifest);
      scenePublished = true;
      onRefine({
        kind: "base",
        level: 0,
        triangles: manifest.primitives.reduce((n, p) => n + p.baseTriangles, 0),
        bytes,
      });
    };
    const consume = async (packets) => {
      for await (const { type, data, entry } of packets) {
        signal?.throwIfAborted();
        if (complete) throw new Error("Data after end packet");
        if (type === TYPES.manifest) {
          if (manifest) throw new Error("Duplicate manifest");
          manifest = JSON.parse(new TextDecoder().decode(data));
          if (manifest.version !== VERSION)
            throw new Error("Unsupported PAX version");
          pendingBootstrap = manifest.bootstrapExtensionPackets || 0;
          for (const feature of manifest.features || [])
            if (
              !["primitive-modes", "final-order", "extension-packets"].includes(
                feature,
              )
            )
              throw new Error(`Unsupported PAX feature: ${feature}`);
        } else if (type === TYPES.base) {
          if (!manifest || gltf) throw new Error("Unexpected bootstrap");
          const payload = unpackPayload(data),
            base = payload.take(Uint8Array, payload.meta.glbLength).slice();
          for (const t of payload.meta.textures)
            imageStates[t.image] = {
              width: t.width,
              height: t.height,
              pixels: payload.take(Uint8Array, t.width * t.height * 4).slice(),
              textures: [],
            };
          const header = new DataView(
            base.buffer,
            base.byteOffset,
            base.byteLength,
          );
          const jsonLength = header.getUint32(12, true);
          const bootstrapJSON = JSON.parse(
            new TextDecoder().decode(base.subarray(20, 20 + jsonLength)),
          );
          for (const name of bootstrapJSON.extensionsRequired || [])
            if (!nativeExtensions.has(name) && !this.extensions.has(name))
              throw new Error(`Missing progressive runtime extension: ${name}`);
          gltf = await this.gltfLoader.parseAsync(base.buffer, "");
          if (!gltf.scene) {
            gltf.scene = new THREE.Group();
            gltf.scenes.push(gltf.scene);
          }
          const canonical = await gltf.parser.getDependencies("mesh");
          const objects = [
            ...new Set(
              [...gltf.scenes, ...canonical].flatMap((root) => {
                const list = [];
                root.traverse((o) => {
                  if (o.geometry) list.push(o);
                });
                return list;
              }),
            ),
          ];
          states = manifest.primitives.map((p) => {
            const root = canonical[p.mesh],
              sourceGeometry = (
                root.isGroup ? root.children[p.primitive] : root
              ).geometry;
            const meshes = objects.filter((o) => o.geometry === sourceGeometry);
            if (!meshes.length) return null; // Mesh may belong to an inactive scene.
            const geometry = meshes[0].geometry;
            const primitiveJSON =
              bootstrapJSON.meshes[p.mesh].primitives[p.primitive];
            const binOffset = 28 + jsonLength;
            const attributes = p.attributes.map((a) => {
              const accessorID =
                a.morph !== undefined
                  ? primitiveJSON.targets[a.morph][a.semantic]
                  : primitiveJSON.attributes[a.semantic];
              const definition = bootstrapJSON.accessors[accessorID],
                view = bootstrapJSON.bufferViews[definition.bufferView];
              const Type = COMPONENTS[a.componentType];
              const offset =
                binOffset +
                (view.byteOffset || 0) +
                (definition.byteOffset || 0);
              const current = new Type(
                base.buffer,
                offset,
                definition.count * a.itemSize,
              );
              const array = new Type(p.finalVertices * a.itemSize);
              array.set(current);
              metrics.geometryReservedBytes += array.byteLength;
              const attr = new THREE.BufferAttribute(
                array,
                a.itemSize,
                a.normalized,
              );
              attr.setUsage(THREE.DynamicDrawUsage);
              if (a.morph !== undefined)
                (geometry.morphAttributes[nameOf(a.semantic)] ||= [])[a.morph] =
                  attr;
              else geometry.setAttribute(nameOf(a.semantic), attr);
              return attr;
            });
            geometry.userData.paxVertexCount = p.baseVertices;
            const indexWidth = p.indexWidth || 3;
            const initial = geometry.index.array;
            const indexStorage = new Uint32Array(p.finalTriangles * indexWidth);
            const triangles = new IndexTable(indexStorage, indexWidth, initial);
            metrics.geometryReservedBytes +=
              indexStorage.byteLength +
              triangles.ids.byteLength +
              triangles.dirty.byteLength;
            geometry.setIndex(
              new THREE.BufferAttribute(indexStorage, 1).setUsage(
                THREE.DynamicDrawUsage,
              ),
            );
            geometry.setDrawRange(0, initial.length);
            // Every instance uses the same evolving geometry and its original skin/material.
            for (const mesh of meshes) {
              mesh.geometry = geometry;
              mesh.frustumCulled = false;
            }
            return {
              meshes,
              geometry,
              indexWidth,
              attributes,
              triangles,
              slots: triangles.slots,
              slotIDs: triangles.ids,
              level: 0,
              vertexCount: p.baseVertices,
            };
          });
          // These plugins retain material references before PAX bootstrap completes.
          // Keep their original materials instead of cloning them for a morph shader.
          if (
            renderer &&
            reuseMorphTextures &&
            !gltf.variantMaterials?.length &&
            !bootstrapJSON.extensionsUsed?.some((name) =>
              ["KHR_animation_pointer", "KHR_interactivity"].includes(name),
            ) &&
            !this.extensions.size
          )
            for (const state of states) {
              if (
                state &&
                (state.geometry.morphAttributes.position ||
                  state.geometry.morphAttributes.normal ||
                  state.geometry.morphAttributes.color) &&
                !state.meshes.some((mesh) => mesh.isInstancedMesh)
              ) {
                state.morphStorage = new MorphStorage(
                  state.geometry,
                  state.meshes,
                  gltf.parser,
                  renderer,
                  metrics,
                );
                await state.morphStorage.update(0, state.vertexCount, budget);
              }
            }
          // The parser also owns textures used by extension materials (transmission, sheen, etc.).
          const textures = await gltf.parser.getDependencies("texture");
          textures.forEach((texture, i) => {
            const source = gltf.parser.json.textures[i].source;
            if (imageStates[source] && texture)
              imageStates[source].textures.push(texture);
          });
          // Include texture clones created for UV-channel / KHR_texture_transform variants.
          const materials = [
            ...(await gltf.parser.getDependencies("material")),
            ...objects.flatMap((o) =>
              Array.isArray(o.material) ? o.material : [o.material],
            ),
            ...(gltf.variantMaterials || []),
          ];
          for (const material of materials)
            for (const value of Object.values(material || {})) {
              if (!value?.isTexture) continue;
              const association = gltf.parser.associations.get(value);
              const source =
                association?.textures !== undefined
                  ? gltf.parser.json.textures[association.textures].source
                  : undefined;
              if (
                imageStates[source] &&
                !imageStates[source].textures.includes(value)
              )
                imageStates[source].textures.push(value);
            }
          // Use the same raw RGBA upload path for bootstrap and refinements.
          // PNG/ImageBitmap decoding must not reinterpret linear material-map channels.
          for (const [image, state] of imageStates.entries()) {
            if (manifest.textures[image].codec === "tile-lattice") {
              const spec = manifest.textures[image];
              Object.assign(state, {
                fullWidth: spec.width,
                fullHeight: spec.height,
                baseWidth: state.width,
                baseHeight: state.height,
                basePixels: state.pixels,
                tiles: new Map(),
                finishedTiles: new Set(),
              });
              const init = {
                image,
                fullWidth: state.fullWidth,
                fullHeight: state.fullHeight,
                baseWidth: state.baseWidth,
                baseHeight: state.baseHeight,
                basePixels: state.basePixels,
                tileCount: spec.tileCount,
              };
              if (decoder) await decoder.run("tile-init", init);
              else tileWorkspace.init(init);
              state.pixels = decoder
                ? await decoder.run("expand", {
                    pixels: state.pixels,
                    width: state.width,
                    height: state.height,
                    fullWidth: spec.width,
                    fullHeight: spec.height,
                  })
                : await budget.run(() =>
                    expandInto(
                      state.pixels,
                      state.width,
                      state.height,
                      new Uint8Array(spec.width * spec.height * 4),
                      spec.width,
                      spec.height,
                    ),
                  );
              metrics.textureReservedBytes += state.pixels.byteLength;
              state.sampling = state.textures.map((texture) => ({
                texture,
                minFilter: texture.minFilter,
                generateMipmaps: texture.generateMipmaps,
              }));
              for (const texture of state.textures) {
                texture.isDataTexture = true;
                texture.image = {
                  data: state.pixels,
                  width: spec.width,
                  height: spec.height,
                };
                if (!renderer) {
                  texture.generateMipmaps = false;
                  texture.minFilter = THREE.LinearFilter;
                }
                texture.needsUpdate = true;
                if (renderer)
                  await budget.run(
                    () => renderer.initTexture(texture),
                    state.pixels.byteLength,
                  );
              }
              if (renderer) {
                state.uploadSource = new THREE.DataTexture(
                  state.pixels,
                  spec.width,
                  spec.height,
                );
                state.uploadRegion = new THREE.Box2();
                state.uploadPosition = new THREE.Vector2();
              }
              continue;
            }
            const canvas = document.createElement("canvas");
            canvas.width = state.width;
            canvas.height = state.height;
            canvas
              .getContext("2d")
              .putImageData(
                new ImageData(
                  new Uint8ClampedArray(state.pixels),
                  state.width,
                  state.height,
                ),
                0,
                0,
              );
            for (const texture of state.textures) {
              texture.image = canvas;
              texture.needsUpdate = true;
            }
          }
          if (!pendingBootstrap) await publishScene();
        } else if (type === TYPES.geometry) {
          if (!gltf || !scenePublished)
            throw new Error("Geometry before complete bootstrap");
          const packet = unpackPayload(data);
          if (
            entry &&
            (packet.meta.level !== entry.level ||
              packet.meta.primitives.length !== 1 ||
              packet.meta.primitives[0].id !== entry.resource)
          )
            throw new Error("Geometry directory mismatch");
          level = Math.max(level, packet.meta.level);
          for (const p of packet.meta.primitives) {
            const description = manifest.primitives[p.id],
              state = states[p.id];
            if (!description) throw new Error("Unknown primitive");
            if (state && packet.meta.level !== state.level + 1)
              throw new Error("Out-of-order geometry");
            if (
              p.start + p.count > description.finalVertices ||
              (state && p.start !== state.vertexCount)
            )
              throw new Error("Invalid vertex append");
            for (let i = 0; i < description.attributes.length; i++) {
              const a = description.attributes[i],
                values = packet.take(
                  COMPONENTS[a.componentType],
                  p.count * a.itemSize,
                );
              if (state)
                for (let offset = 0; offset < values.length; offset += 65536) {
                  const end = Math.min(offset + 65536, values.length);
                  await budget.run(
                    () => {
                      const attribute = state.attributes[i];
                      attribute.array.set(
                        values.subarray(offset, end),
                        p.start * a.itemSize + offset,
                      );
                      attribute.addUpdateRange(
                        p.start * a.itemSize + offset,
                        end - offset,
                      );
                      attribute.needsUpdate = true;
                    },
                    (end - offset) * values.BYTES_PER_ELEMENT,
                  );
                }
            }
            if (state?.morphStorage)
              await state.morphStorage.update(p.start, p.count, budget);
            const removed = packet.take(Uint32Array, p.removed),
              added = packet.take(Uint32Array, p.added),
              order = packet.take(Uint32Array, p.order || 0);
            if (!state) continue;
            if (added.length % (state.indexWidth + 1))
              throw new Error("Invalid triangle patch length");
            // All appended attributes are ready before topology can expose them.
            state.geometry.userData.paxVertexCount = p.start + p.count;
            const topology = state.triangles;
            const flush = () => {
              topology.flush(state.geometry.index);
              state.geometry.setDrawRange(0, topology.size * state.indexWidth);
            };
            for (let offset = 0; offset < removed.length; offset += 1024)
              await budget.run(
                () => {
                  for (
                    let i = offset;
                    i < Math.min(offset + 1024, removed.length);
                    i++
                  )
                    topology.remove(removed[i]);
                  flush();
                },
                Math.min(1024, removed.length - offset) * state.indexWidth * 4,
              );
            const step = state.indexWidth + 1;
            for (let offset = 0; offset < added.length; offset += 1024 * step)
              await budget.run(
                () => {
                  for (
                    let i = offset;
                    i < Math.min(offset + 1024 * step, added.length);
                    i += step
                  )
                    topology.add(added, i, p.start + p.count);
                  flush();
                },
                Math.min(1024, (added.length - offset) / step) *
                  state.indexWidth *
                  4,
              );
            if (topology.size !== p.triangles)
              throw new Error("Triangle count mismatch");
            if (order.length) {
              if (order.length !== topology.size)
                throw new Error("Invalid final primitive order");
              for (let offset = 0; offset < order.length; offset += 1024)
                await budget.run(
                  () => {
                    for (
                      let i = offset;
                      i < Math.min(offset + 1024, order.length);
                      i++
                    )
                      topology.order(order[i], i);
                    flush();
                  },
                  Math.min(1024, order.length - offset) * state.indexWidth * 8,
                );
            }
            // Three.js caches morph targets as a texture; attribute update flags alone do not refresh it.
            if (
              !state.morphStorage &&
              Object.keys(state.geometry.morphAttributes).length
            ) {
              state.geometry.dispose();
              metrics.geometryDisposals++;
            }
            state.geometry.setDrawRange(
              0,
              state.triangles.size * state.indexWidth,
            );
            state.vertexCount += p.count;
            state.level = packet.meta.level;
            state.geometry.userData.paxVertexCount = state.vertexCount;
          }
          await notify("onRefine", { kind: "geometry", level });
          onRefine({
            kind: "geometry",
            level,
            bytes,
            triangles: states.reduce((n, s) => n + (s?.triangles.size || 0), 0),
          });
        } else if (type === TYPES.texture) {
          if (!gltf) throw new Error("Texture before bootstrap");
          const packet = unpackPayload(data),
            { image, width, height } = packet.meta,
            state = imageStates[image];
          if (
            entry &&
            (entry.resource !== image ||
              (packet.meta.codec === "tile-lattice" &&
                entry.tile !== packet.meta.tile))
          )
            throw new Error("Texture directory mismatch");
          if (
            !state ||
            (!["tile-lattice", "ktx2-mip"].includes(packet.meta.codec) &&
              (width < state.width || height < state.height))
          )
            throw new Error("Invalid texture refinement");
          let imageData;
          if (packet.meta.codec === "tile-lattice") {
            const meta = packet.meta,
              filtered = packet.take(Uint8Array, meta.filteredLength);
            const patch = decoder
              ? await decoder.run("tile", { meta, filtered }, [filtered.buffer])
              : await budget.run(() => tileWorkspace.patch(meta, filtered));
            await budget.run(() => {
              for (let y = 0; y < meta.tileHeight; y++) {
                const start = ((meta.y + y) * state.fullWidth + meta.x) * 4;
                state.pixels.set(
                  patch.subarray(
                    y * meta.tileWidth * 4,
                    (y + 1) * meta.tileWidth * 4,
                  ),
                  start,
                );
                if (!renderer)
                  for (const texture of state.textures)
                    texture.addUpdateRange(start, meta.tileWidth * 4);
              }
            });
            if (meta.final) state.finishedTiles.add(meta.tile);
            const finished =
              state.finishedTiles.size === manifest.textures[image].tileCount;
            if (renderer) {
              state.uploadRegion.min.set(meta.x, meta.y);
              state.uploadRegion.max.set(
                meta.x + meta.tileWidth,
                meta.y + meta.tileHeight,
              );
              state.uploadPosition.set(meta.x, meta.y);
              for (const texture of state.textures)
                await budget.run(
                  () => {
                    const generate = texture.generateMipmaps;
                    texture.generateMipmaps = finished && generate;
                    try {
                      renderer.copyTextureToTexture(
                        state.uploadSource,
                        texture,
                        state.uploadRegion,
                        state.uploadPosition,
                      );
                      metrics.textureRectUploads++;
                    } finally {
                      texture.generateMipmaps = generate;
                    }
                  },
                  meta.tileWidth * meta.tileHeight * 4,
                );
            } else
              for (const texture of state.textures) texture.needsUpdate = true;
            if (decoder) decoder.release(patch.buffer);
            else tileWorkspace.release(patch.buffer);
            if (finished) {
              state.width = state.fullWidth;
              state.height = state.fullHeight;
              if (!renderer)
                for (const {
                  texture,
                  minFilter,
                  generateMipmaps,
                } of state.sampling) {
                  texture.dispose();
                  metrics.textureReplacements++;
                  texture.minFilter = minFilter;
                  texture.generateMipmaps = generateMipmaps;
                  texture.clearUpdateRanges();
                  texture.needsUpdate = true;
                }
            }
            await notify("onRefine", {
              kind: "texture",
              image,
              width,
              height,
              level,
            });
            onRefine({ kind: "texture", image, width, height, level, bytes });
            continue;
          } else if (packet.meta.codec === "lattice") {
            if (
              width !== state.width * (packet.meta.axis === "x" ? 2 : 1) ||
              height !== state.height * (packet.meta.axis === "y" ? 2 : 1)
            )
              throw new Error("Out-of-order lattice");
            const missing = packet.take(Uint8Array, packet.meta.filteredLength);
            state.pixels = decoder
              ? await decoder.run(
                  "lattice",
                  {
                    pixels: state.pixels,
                    width: state.width,
                    height: state.height,
                    filtered: missing,
                    axis: packet.meta.axis,
                  },
                  [state.pixels.buffer, missing.buffer],
                )
              : mergeAxis(
                  state.pixels,
                  state.width,
                  state.height,
                  unfilterRows(missing, state.width, state.height),
                  packet.meta.axis,
                );
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas
              .getContext("2d")
              .putImageData(
                new ImageData(
                  new Uint8ClampedArray(state.pixels.buffer),
                  width,
                  height,
                ),
                0,
                0,
              );
            imageData = canvas;
          } else if (packet.meta.codec === "ktx2-mip") {
            if (!this.gltfLoader.ktx2Loader)
              throw new Error("KTX2 mip requires a configured KTX2Loader");
            if (packet.meta.templateLength) {
              if (state.ktxTemplate) throw new Error("Duplicate KTX template");
              state.ktxTemplate = packet
                .take(Uint8Array, packet.meta.templateLength)
                .slice();
              state.mips = [];
              state.nextMip = manifest.textures[image].levels - 2;
            }
            if (packet.meta.mip !== state.nextMip--)
              throw new Error("Out-of-order KTX mip");
            const encoded = mipContainer(
              state.ktxTemplate,
              packet.meta.mip,
              packet.take(Uint8Array, packet.meta.byteLength),
            );
            const decoded = await new Promise((resolve, reject) =>
              this.gltfLoader.ktx2Loader.parse(encoded.buffer, resolve, reject),
            );
            state.mips.unshift(decoded.mipmaps[0]);
            for (const texture of state.textures) {
              for (const key of [
                "format",
                "type",
                "internalFormat",
                "isCompressedTexture",
              ])
                texture[key] = decoded[key];
              texture.mipmaps = state.mips.slice();
              texture.generateMipmaps = false;
            }
            imageData = decoded.image;
            state.pixels = null;
          } else if (packet.meta.codec === "ktx2") {
            if (!this.gltfLoader.ktx2Loader)
              throw new Error(
                "KTX2 refinement requires setKTX2Loader() configured with renderer support",
              );
            const encoded = packet.take(Uint8Array, packet.meta.byteLength);
            const decoded = await new Promise((resolve, reject) =>
              this.gltfLoader.ktx2Loader.parse(
                encoded.slice().buffer,
                resolve,
                reject,
              ),
            );
            for (const texture of state.textures) {
              for (const key of [
                "format",
                "type",
                "internalFormat",
                "mipmaps",
                "generateMipmaps",
                "isCompressedTexture",
              ])
                texture[key] = decoded[key];
            }
            imageData = decoded.image;
            state.pixels = null;
          } else if (packet.meta.codec === "source") {
            const original = packet.take(Uint8Array, packet.meta.byteLength);
            imageData = await createImageBitmap(
              new Blob([original], { type: packet.meta.mimeType }),
              { premultiplyAlpha: "none", colorSpaceConversion: "none" },
            );
            state.pixels = null;
          } else throw new Error("Unsupported texture codec");
          state.width = width;
          state.height = height;
          // Commit aliases together, then submit the upload inside the work budget.
          // Deferring needsUpdate to an arbitrary render frame defeats upload pacing.
          await budget.run(
            () => {
              for (const texture of state.textures) {
                texture.dispose();
                metrics.textureReplacements++;
              }
              for (const texture of state.textures) {
                texture.image = imageData;
                texture.needsUpdate = true;
              }
              if (renderer)
                for (const texture of state.textures)
                  renderer.initTexture(texture);
            },
            width * height * 4 * state.textures.length,
          );
          await notify("onRefine", {
            kind: "texture",
            image,
            width,
            height,
            level,
          });
          onRefine({ kind: "texture", image, width, height, level, bytes });
        } else if (type === TYPES.extension) {
          if (!gltf) throw new Error("Extension packet before bootstrap");
          const packet = unpackPayload(data),
            extension = this.extensions.get(packet.meta.extension);
          if (packet.meta.level !== level)
            throw new Error("Out-of-order extension packet");
          if (!extension?.onPacket)
            throw new Error(
              `Missing progressive packet handler: ${packet.meta.extension}`,
            );
          await extension.onPacket({
            packet,
            gltf,
            manifest,
            states,
            imageStates,
          });
          if (level === 0 && !scenePublished) {
            if (--pendingBootstrap === 0) await publishScene();
          }
          onRefine({
            kind: "extension",
            extension: packet.meta.extension,
            level,
            bytes,
          });
        } else if (type === TYPES.end) {
          if (
            !gltf ||
            !scenePublished ||
            level !== manifest.levels - 1 ||
            states.some(
              (s, i) =>
                s &&
                (s.level !== manifest.primitives[i].levels - 1 ||
                  s.vertexCount !== manifest.primitives[i].finalVertices ||
                  s.triangles.size !== manifest.primitives[i].finalTriangles),
            ) ||
            imageStates.some(
              (s, i) =>
                s.width !== manifest.textures[i].width ||
                s.height !== manifest.textures[i].height,
            )
          )
            throw new Error("Incomplete asset");
          if (JSON.parse(new TextDecoder().decode(data)).complete !== true)
            throw new Error("Invalid end marker");
          complete = true;
        } else throw new Error(`Unknown packet type ${type}`);
      }
    };
    const result = () => ({
      metrics,
      gltf,
      manifest,
      states,
      imageStates,
      bytes,
      complete,
      refine,
      dispose,
    });
    let busy = false;
    const dispose = () => {
      lifetime.abort();
      decoder?.dispose();
      gltf?.interactivity?.dispose();
    };
    const refine = async (options = {}) => {
      signal.throwIfAborted();
      if (!range) throw new Error("Resume requires range transport");
      if (busy) throw new Error("A refinement is already running");
      busy = true;
      try {
        await consume(range.packets(options));
        if (complete) await notify("onComplete", { kind: "complete" });
        if (decoder) Object.assign(metrics, await decoder.run("stats", {}));
        else Object.assign(metrics, tileWorkspace.metrics);
        return result();
      } catch (error) {
        dispose();
        throw error;
      } finally {
        busy = false;
      }
    };
    try {
      await consume(packets);
      if (!range && !complete) throw new Error("Missing end packet");
      if (complete) await notify("onComplete", { kind: "complete" });
      if (decoder) Object.assign(metrics, await decoder.run("stats", {}));
      else Object.assign(metrics, tileWorkspace.metrics);
      if (!range) decoder?.dispose();
      return result();
    } catch (error) {
      dispose();
      throw error;
    }
  }
}

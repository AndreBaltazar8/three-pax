import {
  DataArrayTexture,
  DataTexture,
  FloatType,
  Vector2,
  Vector3,
  Box3,
  ShaderChunk,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  RGBADepthPacking,
} from "three";
/** Stable morph texture; native influence uniforms and CPU raycasting stay intact. */
export class MorphStorage {
  constructor(geometry, meshes, parser, renderer, metrics) {
    this.geometry = geometry;
    this.renderer = renderer;
    this.metrics = metrics;
    const attrs = geometry.morphAttributes;
    this.attrs = attrs;
    this.count = (attrs.position || attrs.normal || attrs.color).length;
    this.stride = attrs.color ? 3 : attrs.normal ? 2 : 1;
    const texels = geometry.attributes.position.count * this.stride;
    this.width = Math.min(texels, renderer.capabilities.maxTextureSize);
    this.height = Math.ceil(texels / this.width);
    this.data = new Float32Array(this.width * this.height * 4 * this.count);
    metrics.morphReservedBytes =
      (metrics.morphReservedBytes || 0) + this.data.byteLength;
    this.texture = new DataArrayTexture(
      this.data,
      this.width,
      this.height,
      this.count,
    );
    this.texture.type = FloatType;
    this.texture.needsUpdate = true;
    this.source = new DataTexture(this.data, this.width, this.height);
    this.source.type = FloatType;
    this.region = new Box3();
    this.position = new Vector3();
    const uniform = { value: this.texture },
      size = { value: new Vector2(this.width, this.height) };
    for (const mesh of meshes) {
      const patch = (material) => {
        const clone = material.clone(),
          before = material.onBeforeCompile,
          key = material.customProgramCacheKey.bind(material);
        parser.associations.set(clone, parser.associations.get(material));
        clone.onBeforeCompile = function (shader, r) {
          before.call(this, shader, r);
          shader.uniforms.paxMorphTexture = uniform;
          shader.uniforms.paxMorphSize = size;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <morphtarget_pars_vertex>",
            ShaderChunk.morphtarget_pars_vertex
              .replaceAll("morphTargetsTextureSize", "paxMorphSize")
              .replaceAll("morphTargetsTexture", "paxMorphTexture"),
          );
        };
        clone.customProgramCacheKey = () => `${key()}:pax-morph-storage`;
        return clone;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(patch)
        : patch(mesh.material);
      // Shadow passes use the same custom morph texture and native skinning chunks.
      mesh.customDepthMaterial = patch(
        mesh.customDepthMaterial ||
          new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
      );
      mesh.customDistanceMaterial = patch(
        mesh.customDistanceMaterial || new MeshDistanceMaterial(),
      );
      geometry.addEventListener("dispose", () => {
        mesh.customDepthMaterial.dispose();
        mesh.customDistanceMaterial.dispose();
      });
    }
    geometry.addEventListener("dispose", () => this.texture.dispose());
  }
  write(start, count) {
    for (let target = 0; target < this.count; target++)
      for (const [name, offset] of [
        ["position", 0],
        ["normal", 1],
        ["color", 2],
      ]) {
        const attribute = this.attrs[name]?.[target];
        if (!attribute) continue;
        for (let vertex = start; vertex < start + count; vertex++) {
          const index =
            (target * this.width * this.height +
              vertex * this.stride +
              offset) *
            4;
          for (let c = 0; c < attribute.itemSize; c++)
            this.data[index + c] = attribute.getComponent(vertex, c);
          if (name === "color" && attribute.itemSize === 3)
            this.data[index + 3] = 1;
        }
      }
  }
  async update(start, count, budget) {
    for (let offset = start; offset < start + count; offset += 1024)
      await budget.run(() =>
        this.write(offset, Math.min(1024, start + count - offset)),
      );
    if (!this.initialized) {
      await budget.run(
        () => this.renderer.initTexture(this.texture),
        this.data.byteLength,
      );
      this.initialized = true;
      return;
    }
    const first = Math.floor((start * this.stride) / this.width),
      end = Math.ceil(((start + count) * this.stride) / this.width);
    for (let target = 0; target < this.count; target++)
      for (let row = first; row < end; row += 16) {
        const bottom = Math.min(row + 16, end);
        await budget.run(
          () => {
            this.region.min.set(0, row, target);
            this.region.max.set(this.width, bottom, target + 1);
            this.position.set(0, row, target);
            this.renderer.copyTextureToTexture(
              this.source,
              this.texture,
              this.region,
              this.position,
            );
          },
          this.width * (bottom - row) * 16,
        );
      }
  }
}

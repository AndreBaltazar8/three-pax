import { diffuseTransmission } from "./diffuse-transmission.js";
import { gaussianSplatting } from "./gaussian-splatting.js";
import { interactivity } from "./interactivity.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "meshoptimizer";
import { materialVariants, nodeVisibility } from "./extensions.js";
import { animationPointer } from "./animation-pointer.js";
import { extendedAttributes } from "./geometry-features.js";
export function createGLTFLoader(manager) {
  const loader = new GLTFLoader(manager);
  // Material type selection uses the first matching plugin, before native physical extensions.
  loader.pluginCallbacks.unshift(diffuseTransmission);
  return loader
    .register(gaussianSplatting)
    .register(interactivity)
    .register(extendedAttributes)
    .register(materialVariants)
    .register(nodeVisibility)
    .register(animationPointer)
    .register(() => ({ name: "KHR_node_selectability" }))
    .register(() => ({ name: "KHR_node_hoverability" }));
}
export function configureDecoders(loader, renderer) {
  loader.paxRenderer = renderer;
  loader.setDRACOLoader(
    new DRACOLoader().setDecoderPath("/decoders/draco/").setWorkerLimit(2),
  );
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(
    new KTX2Loader()
      .setTranscoderPath("/decoders/basis/")
      .detectSupport(renderer)
      .setWorkerLimit(2),
  );
  return loader;
}

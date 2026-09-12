import { geometryFeatures } from './geometry-features.js';
// Progressive runtime hooks augment GLTFLoader plugins. Factories receive the
// live parser; hooks run after each applied packet, never before its dependencies.
export function materialVariants(parser) {
  return {
    name: 'KHR_materials_variants',
    async afterRoot(result) {
      const definitions = parser.json.extensions?.KHR_materials_variants?.variants || [];
      const meshes = await parser.getDependencies('mesh'), entries = [];
      for (let m=0;m<meshes.length;m++) {
        const canonical = meshes[m].isGroup ? meshes[m].children : [meshes[m]];
        for (let p=0;p<canonical.length;p++) {
          const mappings = parser.json.meshes[m].primitives[p].extensions?.KHR_materials_variants?.mappings;
          if (!mappings) continue;
          const variants = new Map();
          for (const mapping of mappings) for (const id of mapping.variants) variants.set(id, await parser.getDependency('material', mapping.material));
          const objects = new Set();
          for (const scene of result.scenes) scene.traverse(o => { if(o.geometry === canonical[p].geometry) objects.add(o); });
          for (const object of objects) {
            const original = object.material, adapted = new Map();
            for (const [id, material] of variants) { object.material=material; parser.assignFinalMaterial(object); geometryFeatures(object,parser); adapted.set(id,object.material); }
            object.material=original; entries.push({object,original,variants:adapted});
          }
        }
      }
      result.variants = definitions.map((v,index) => ({ ...v, index }));
      result.variantMaterials = entries.flatMap(e => [...e.variants.values()]);
      result.selectVariant = value => {
        const index = value === null ? null : typeof value === 'number' ? value : definitions.findIndex(v => v.name === value);
        if (index !== null && (!Number.isInteger(index) || index < 0 || index >= definitions.length)) throw new Error(`Unknown material variant: ${value}`);
        for (const e of entries) e.object.material = index === null ? e.original : e.variants.get(index) || e.original;
      };
    }
  };
}
export function nodeVisibility(parser) {
  return { name: 'KHR_node_visibility', async afterRoot(result) {
    const nodes = await parser.getDependencies('node');
    for(let i=0;i<result.cameras.length;i++)if(parser.json.cameras[i].type==='perspective'&&parser.json.cameras[i].perspective.zfar===undefined){result.cameras[i].far=Infinity;result.cameras[i].updateProjectionMatrix();}
    result.cameraInstances=[];
    nodes.forEach((node,i)=>{const cameraIndex=parser.json.nodes[i].camera;if(cameraIndex===undefined)return;const camera=node.isCamera?node:node.children.find(o=>o.isCamera);if(camera){result.cameraInstances.push({camera,cameraIndex,nodeIndex:i});if(parser.json.cameras[cameraIndex].type==='perspective'&&parser.json.cameras[cameraIndex].perspective.zfar===undefined){camera.far=Infinity;camera.updateProjectionMatrix();}}});
    nodes.forEach((node,i) => {
      const ext=parser.json.nodes[i].extensions || {};
      if(ext.KHR_node_visibility?.visible!==undefined)node.visible=ext.KHR_node_visibility.visible;
      node.userData.paxSelectable=ext.KHR_node_selectability?.selectable ?? true;
      node.userData.paxHoverable=ext.KHR_node_hoverability?.hoverable ?? true;
    });
    result.raycast=(raycaster,{scene=result.scene,kind='select'}={})=>{
      if(!['select','hover'].includes(kind))throw new Error('Unknown picking kind');
      const key=kind==='select'?'paxSelectable':'paxHoverable';
      return raycaster.intersectObject(scene,true).filter(hit=>{
        for(let node=hit.object;node;node=node.parent)if(node.userData[key]===false)return false;
        return true;
      });
    };
  } };
}
export const nativeExtensions = new Set([
  'KHR_interactivity','KHR_gaussian_splatting','KHR_materials_diffuse_transmission',
  'KHR_lights_punctual','KHR_materials_unlit','KHR_materials_clearcoat',
  'KHR_materials_sheen','KHR_materials_transmission','KHR_materials_volume',
  'KHR_materials_ior','KHR_materials_specular','KHR_materials_iridescence',
  'KHR_materials_anisotropy','KHR_materials_emissive_strength','KHR_materials_dispersion',
  'EXT_materials_bump','KHR_texture_transform','KHR_mesh_quantization','EXT_mesh_gpu_instancing',
  'KHR_animation_pointer','KHR_materials_variants','KHR_node_visibility','KHR_node_selectability','KHR_node_hoverability','KHR_xmp_json_ld',
]);

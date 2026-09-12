import { tangentMorph } from './tangent-morph.js';
import { ShaderChunk, Matrix4, Vector3, BufferAttribute } from 'three';
export function geometryFeatures(mesh, parser) {
  const geometry=mesh.geometry;
  for(const name of Object.keys(geometry.attributes)) if(/^texcoord_\d+$/.test(name))geometry.setAttribute(`uv${name.slice(9)}`,geometry.getAttribute(name));
  const uvSets=Object.keys(geometry.attributes).filter(n=>/^uv\d+$/.test(n)&&Number(n.slice(2))>3);
  const skinSets=Object.keys(geometry.attributes).filter(n=>/^joints_\d+$/.test(n)).map(n=>Number(n.slice(7))).filter(i=>i>0&&geometry.hasAttribute(`weights_${i}`)).sort((a,b)=>a-b);
  if(!uvSets.length && (!mesh.isSkinnedMesh || !skinSets.length)){tangentMorph(mesh,parser);return;}
  const modify=material=>{
    const clone=material.clone();parser.associations.set(clone,parser.associations.get(material));
    const previous=material.onBeforeCompile;
    clone.onBeforeCompile=(shader,renderer)=>{
      previous.call(clone,shader,renderer);
      const declarations=[...uvSets.map(n=>`attribute vec2 ${n};`),...(mesh.isSkinnedMesh?skinSets.flatMap(i=>[`attribute vec4 joints_${i};`,`attribute vec4 weights_${i};`]):[])].join('\n');
      shader.vertexShader=declarations+'\n'+shader.vertexShader;
      if(mesh.isSkinnedMesh&&skinSets.length){
        let base=ShaderChunk.skinbase_vertex,skin=ShaderChunk.skinning_vertex,normal=ShaderChunk.skinnormal_vertex;
        const matrices=skinSets.flatMap(i=>['x','y','z','w'].map(c=>`mat4 paxBone${i}${c}=getBoneMatrix(joints_${i}.${c});`)).join('\n');
        base=base.replace('#endif',matrices+'\n#endif');
        const weights=skinSets.flatMap(i=>['x','y','z','w'].map(c=>`skinned += paxBone${i}${c} * skinVertex * weights_${i}.${c};`)).join('\n');
        skin=skin.replace('transformed =',weights+'\ntransformed =');
        const normals=skinSets.flatMap(i=>['x','y','z','w'].map(c=>`skinMatrix += weights_${i}.${c} * paxBone${i}${c};`)).join('\n');
        normal=normal.replace('skinMatrix = bindMatrixInverse',normals+'\nskinMatrix = bindMatrixInverse');
        shader.vertexShader=shader.vertexShader.replace('#include <skinbase_vertex>',base).replace('#include <skinning_vertex>',skin).replace('#include <skinnormal_vertex>',normal);
      }
    };
    clone.customProgramCacheKey=()=>`pax-attributes:${uvSets.join(',')}:${mesh.isSkinnedMesh?skinSets.join(','):''}`;
    return clone;
  };
  mesh.material=Array.isArray(mesh.material)?mesh.material.map(modify):modify(mesh.material);
  tangentMorph(mesh,parser);
  if(mesh.isSkinnedMesh&&skinSets.length){
    const matrix=new Matrix4(),base=new Vector3(),temp=new Vector3();
    mesh.applyBoneTransform=function(index,target){
      base.copy(target).applyMatrix4(this.bindMatrix);target.set(0,0,0);
      for(const set of [0,...skinSets]) {
        const joints=geometry.getAttribute(set?`joints_${set}`:'skinIndex'),weights=geometry.getAttribute(set?`weights_${set}`:'skinWeight');
        for(let c=0;c<4;c++){const weight=weights.getComponent(index,c);if(!weight)continue;const bone=joints.getComponent(index,c);matrix.multiplyMatrices(this.skeleton.bones[bone].matrixWorld,this.skeleton.boneInverses[bone]);target.addScaledVector(temp.copy(base).applyMatrix4(matrix),weight);}
      }
      return target.applyMatrix4(this.bindMatrixInverse);
    };
  }
}

export function extendedAttributes(parser) {
  return {name:'PAX_extended_attributes',beforeRoot(){
    const load=parser.loadMesh.bind(parser);
    parser.loadMesh=async index=>{
      const snapshots=await Promise.all(parser.json.meshes[index].primitives.map(async p=>{
        if(p.attributes.WEIGHTS_1===undefined || p.attributes.WEIGHTS_0===undefined)return null;
        const attribute=await parser.getDependency('accessor',p.attributes.WEIGHTS_0);return attribute.array.slice();
      }));
      const root=await load(index),objects=root.isGroup?root.children:[root];
      for(let p=0;p<objects.length;p++){
        const targets=parser.json.meshes[index].primitives[p].targets || [],geometry=objects[p].geometry;
        if(!targets.length)continue;
        const vertexCount=geometry.attributes.position.count;
        if(!geometry.morphAttributes.position)geometry.morphAttributes.position=targets.map(()=>new BufferAttribute(new Float32Array(vertexCount*3),3));
        for(const semantic of ['POSITION','NORMAL','COLOR_0']) {
          const name={POSITION:'position',NORMAL:'normal',COLOR_0:'color'}[semantic];
          if(!geometry.morphAttributes[name])continue;
          targets.forEach((t,i)=>{if(t[semantic]===undefined)geometry.morphAttributes[name][i]=new BufferAttribute(new Float32Array(vertexCount*(name==='color'?geometry.getAttribute('color').itemSize:3)),name==='color'?geometry.getAttribute('color').itemSize:3);});
        }
        if(targets.some(t=>t.TANGENT!==undefined))geometry.morphAttributes.tangent=await Promise.all(targets.map(t=>t.TANGENT===undefined?new BufferAttribute(new Float32Array(vertexCount*3),3):parser.getDependency('accessor',t.TANGENT)));
        const previousInfluences=objects[p].morphTargetInfluences?.slice();
        objects[p].updateMorphTargets();
        objects[p].morphTargetInfluences=(parser.json.meshes[index].weights || previousInfluences || objects[p].morphTargetInfluences).slice();
      }
      snapshots.forEach((values,i)=>{if(values)objects[i].geometry.getAttribute('skinWeight').array.set(values);});return root;
    };
  },async afterRoot(result){
    const canonical=await parser.getDependencies('mesh'),objects=new Set();
    for(const root of [...result.scenes,...canonical])root.traverse(o=>{if(o.geometry)objects.add(o);});
    for(const object of objects)geometryFeatures(object,parser);
  }};
}

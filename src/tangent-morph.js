import { DataArrayTexture, FloatType, Vector2 } from 'three';
const caches=new WeakMap();
export function tangentMorph(mesh,parser){
  if(!mesh.geometry.morphAttributes.tangent?.length)return;
  const clone=m=>{const c=m.clone();parser.associations.set(c,parser.associations.get(m));c.onBeforeCompile=m.onBeforeCompile;c.customProgramCacheKey=m.customProgramCacheKey;return c;};
  mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material);
  const geometry=mesh.geometry,count=geometry.morphAttributes.tangent.length;
  const uniform={value:null},size={value:new Vector2(1,1)};
  const previousRender=mesh.onBeforeRender;
  mesh.onBeforeRender=function(renderer,...args){
    previousRender.call(this,renderer,...args);
    const attrs=geometry.morphAttributes.tangent,vertices=geometry.attributes.position.count;
    const versions=attrs.map(a=>a.version).join(','),width=Math.min(vertices,renderer.capabilities.maxTextureSize),height=Math.ceil(vertices/width);
    let cache=caches.get(geometry);
    if(!cache||cache.width!==width||cache.height!==height||cache.count!==count){
      cache?.texture.dispose();
      const texture=new DataArrayTexture(new Float32Array(width*height*4*count),width,height,count);texture.type=FloatType;
      cache={texture,width,height,count,versions:null};caches.set(geometry,cache);
      geometry.addEventListener('dispose',()=>{cache.texture.dispose();caches.delete(geometry);});
    }
    if(cache.versions!==versions){
      const buffer=cache.texture.image.data;
      for(let t=0;t<count;t++)for(let v=0;v<vertices;v++)for(let c=0;c<3;c++)buffer[(t*width*height+v)*4+c]=attrs[t].getComponent(v,c);
      cache.versions=versions;cache.texture.needsUpdate=true;
    }
    uniform.value=cache.texture;size.value.set(width,height);
  };
  const patch=material=>{
    const before=material.onBeforeCompile,key=material.customProgramCacheKey.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      before.call(this,shader,renderer);shader.uniforms.paxTangentMorph=uniform;shader.uniforms.paxTangentSize=size;
      shader.vertexShader='uniform sampler2DArray paxTangentMorph;\nuniform ivec2 paxTangentSize;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <morphnormal_vertex>',`#include <morphnormal_vertex>
#ifdef USE_TANGENT
for(int i=0;i<${count};i++)objectTangent+=texelFetch(paxTangentMorph,ivec3(gl_VertexID%paxTangentSize.x,gl_VertexID/paxTangentSize.x,i),0).xyz*morphTargetInfluences[i];
#endif`);
    };
    material.customProgramCacheKey=()=>`${key()}:pax-tangents:${count}`;
  };
  for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])patch(material);
}

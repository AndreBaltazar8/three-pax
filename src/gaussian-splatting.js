import {Mesh, ShaderMaterial, InstancedBufferGeometry, InstancedBufferAttribute, Float32BufferAttribute, DataTexture, RGBAFormat, FloatType, NearestFilter, GLSL3, Vector2, Vector3, Matrix4} from 'three';
import {SPLAT_EXTENSION,validateSplatPrimitive} from './splat-validation.js';
export {SPLAT_EXTENSION,validateSplatPrimitive} from './splat-validation.js';
const vertex=`
precision highp float; precision highp int;
uniform sampler2D splatData; uniform int dataWidth; uniform vec2 viewport; uniform vec3 localEye; uniform int shDegree;
in float splatIndex; out vec2 gaussianUV; out vec4 gaussianColor;
vec4 readSplat(int id,int slot){int offset=id*19+slot;return texelFetch(splatData,ivec2(offset%dataWidth,offset/dataWidth),0);}
mat3 quatMatrix(vec4 q){q=normalize(q);float x=q.x,y=q.y,z=q.z,w=q.w;return mat3(1.-2.*(y*y+z*z),2.*(x*y+z*w),2.*(x*z-y*w),2.*(x*y-z*w),1.-2.*(x*x+z*z),2.*(y*z+x*w),2.*(x*z+y*w),2.*(y*z-x*w),1.-2.*(x*x+y*y));}
void main(){int id=int(splatIndex);vec4 center=readSplat(id,0);vec3 scale=readSplat(id,1).xyz;vec4 q=readSplat(id,2);vec4 view=modelViewMatrix*vec4(center.xyz,1.);vec4 clip=projectionMatrix*view;
if(clip.w<=0.||clip.z < -clip.w||clip.z>clip.w){gl_Position=vec4(2.,2.,2.,1.);gaussianColor=vec4(0.);gaussianUV=vec2(4.);return;}
mat3 rs=mat3(modelViewMatrix)*quatMatrix(q)*mat3(scale.x,0.,0.,0.,scale.y,0.,0.,0.,scale.z);mat3 covariance=rs*transpose(rs);
vec3 jx=vec3(projectionMatrix[0][0]/clip.w,0.,-projectionMatrix[0][0]*view.x*projectionMatrix[2][3]/(clip.w*clip.w))*viewport.x*.5;
vec3 jy=vec3(0.,projectionMatrix[1][1]/clip.w,-projectionMatrix[1][1]*view.y*projectionMatrix[2][3]/(clip.w*clip.w))*viewport.y*.5;
float a=dot(jx,covariance*jx)+.3,b=dot(jx,covariance*jy),c=dot(jy,covariance*jy)+.3;
float mid=.5*(a+c),radius=length(vec2(.5*(a-c),b));float l1=max(mid+radius,.0001),l2=max(mid-radius,.0001);vec2 axis=abs(b)>.00001?normalize(vec2(b,l1-a)):(a>=c?vec2(1.,0.):vec2(0.,1.));
vec2 delta=3.*(sqrt(l1)*axis*position.x+sqrt(l2)*vec2(-axis.y,axis.x)*position.y);gl_Position=clip;gl_Position.xy+=delta*2./viewport*clip.w;gaussianUV=position.xy*3.;
vec3 dir=normalize(center.xyz-localEye);float x=dir.x,y=dir.y,z=dir.z;vec3 color=.5+0.2820947918*readSplat(id,3).rgb;
if(shDegree>0){color+=0.4886025119*(-y*readSplat(id,4).rgb+z*readSplat(id,5).rgb-x*readSplat(id,6).rgb);}
if(shDegree>1){color+=1.0925484306*x*y*readSplat(id,7).rgb-1.0925484306*y*z*readSplat(id,8).rgb+0.3153915653*(2.*z*z-x*x-y*y)*readSplat(id,9).rgb-1.0925484306*x*z*readSplat(id,10).rgb+0.5462742153*(x*x-y*y)*readSplat(id,11).rgb;}
if(shDegree>2){color+=-0.5900435899*y*(3.*x*x-y*y)*readSplat(id,12).rgb+2.8906114426*x*y*z*readSplat(id,13).rgb-0.4570457995*y*(4.*z*z-x*x-y*y)*readSplat(id,14).rgb+0.3731763326*z*(2.*z*z-3.*x*x-3.*y*y)*readSplat(id,15).rgb-0.4570457995*x*(4.*z*z-x*x-y*y)*readSplat(id,16).rgb+1.4453057213*z*(x*x-y*y)*readSplat(id,17).rgb-0.5900435899*x*(x*x-3.*y*y)*readSplat(id,18).rgb;}
gaussianColor=vec4(max(color,vec3(0.)),center.a);
}`;
const fragment=`precision highp float; in vec2 gaussianUV; in vec4 gaussianColor; uniform bool sourceSRGB; out vec4 outColor;
#define gl_FragColor outColor
void main(){float radius=dot(gaussianUV,gaussianUV);if(radius>9.)discard;float opacity=min(.99,gaussianColor.a*exp(-.5*radius));if(opacity<1./255.)discard;vec3 color=gaussianColor.rgb;if(sourceSRGB)color=mix(color/12.92,pow((color+.055)/1.055,vec3(2.4)),step(vec3(.04045),color));gl_FragColor=vec4(color,opacity);
#include <colorspace_fragment>
}`;
function attachSplat(source,definition){
  source.material=source.material.clone();source.material.visible=false;source.userData.paxGaussian=true;
  const geometry=new InstancedBufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));geometry.setIndex([0,1,2,0,2,3]);geometry.setAttribute('splatIndex',new InstancedBufferAttribute(Float32Array.from({length:source.geometry.attributes.position.count},(_,i)=>i),1));
  const uniforms={splatData:{value:null},dataWidth:{value:1},viewport:{value:new Vector2()},localEye:{value:new Vector3()},shDegree:{value:0},sourceSRGB:{value:definition.colorSpace==='srgb_rec709_display'}};
  const material=new ShaderMaterial({glslVersion:GLSL3,uniforms,vertexShader:vertex,fragmentShader:fragment,transparent:true,depthWrite:false,toneMapped:false});
  const mesh=new Mesh(geometry,material);mesh.frustumCulled=false;mesh.userData.paxSplatRenderer=true;source.add(mesh);
  const cameraWorld=new Vector3(),inverse=new Matrix4(),world=new Vector3();let packedVertices=0,lastSignature='',lastSort='',busy=false,wantedSort='',readySort=null;
  const sorter=new Worker(new URL('./splat-sort.worker.js',import.meta.url),{type:'module'});
  sorter.onmessage=({data})=>{busy=false;readySort=data;};
  material.addEventListener('dispose',()=>sorter.terminate());
  mesh.onBeforeRender=(renderer,scene,camera)=>{
    const input=source.geometry,attrs=input.attributes;const signature=(input.userData.paxVertexCount??attrs.position.count)+':'+Object.values(attrs).map(a=>`${a.count}:${a.version}`).join(',');
    if(signature!==lastSignature){
      const count=attrs.position.count,width=Math.min(renderer.capabilities.maxTextureSize,2048),height=Math.ceil(count*19/width);if(height>renderer.capabilities.maxTextureSize)throw new Error('Gaussian field exceeds this GPU texture capacity');
      const existing=uniforms.splatData.value;const data=existing?.image.data.length===width*height*4?existing.image.data:new Float32Array(width*height*4);const read=(name)=>attrs[`${SPLAT_EXTENSION}:${name}`.toLowerCase()];
      let degree=0;for(let d=1;d<=3;d++)if(read(`SH_DEGREE_${d}_COEF_0`))degree=d;uniforms.shDegree.value=degree;
      const known=input.userData.paxVertexCount??count,start=existing?.image.data===data?packedVertices:0;
      for(let i=start;i<known;i++){
        let offset=i*76;data.set([attrs.position.getX(i),attrs.position.getY(i),attrs.position.getZ(i),read('OPACITY').getX(i)],offset);
        for(const [slot,name]of [[1,'SCALE'],[2,'ROTATION']]){const a=read(name);for(let c=0;c<a.itemSize;c++)data[offset+slot*4+c]=a.getComponent(i,c);}
        let slot=3;for(let d=0;d<=degree;d++)for(let j=0;j<2*d+1;j++){const a=read(`SH_DEGREE_${d}_COEF_${j}`);data.set([a.getX(i),a.getY(i),a.getZ(i)],offset+slot++*4);}
      }
      const texture=existing?.image.data===data?existing:new DataTexture(data,width,height,RGBAFormat,FloatType);if(texture!==existing)existing?.dispose();texture.minFilter=texture.magFilter=NearestFilter;texture.needsUpdate=true;uniforms.splatData.value=texture;uniforms.dataWidth.value=width;if(existing===texture){let offset=start*76,remaining=(known-start)*76;while(remaining){const amount=Math.min(remaining,width*4-offset%(width*4));texture.addUpdateRange(offset,amount);offset+=amount;remaining-=amount;}}
      lastSignature=signature;lastSort='';const positions=Float32Array.from(attrs.position.array.subarray(start*3,known*3));sorter.postMessage({positions,start:start*3,capacity:attrs.position.array.length},[positions.buffer]);packedVertices=known;
    }
    renderer.getDrawingBufferSize(uniforms.viewport.value);camera.getWorldPosition(cameraWorld);inverse.copy(source.matrixWorld).invert();uniforms.localEye.value.copy(cameraWorld).applyMatrix4(inverse);
    const count=Math.min(input.drawRange.count,input.index?.count??attrs.position.count);const sortKey=[...cameraWorld,...source.matrixWorld.elements,count,input.index?.version].join(',');
    wantedSort=sortKey;
    if(readySort){if(readySort.key===sortKey){geometry.getAttribute('splatIndex').array.set(readySort.order);geometry.getAttribute('splatIndex').needsUpdate=true;lastSort=sortKey;}readySort=null;}
    geometry.instanceCount=count;source.userData.paxLoadedSplats=count;
    if(sortKey!==lastSort&&!busy){const order=Uint32Array.from({length:count},(_,i)=>input.index?input.index.getX(i+input.drawRange.start):i);if(geometry.userData.sortedCount!==count){geometry.getAttribute('splatIndex').array.set(order);geometry.getAttribute('splatIndex').needsUpdate=true;geometry.userData.sortedCount=count;}busy=true;sorter.postMessage({order,matrix:source.matrixWorld.elements,eye:cameraWorld.toArray(),key:sortKey},[order.buffer]);}
    source.userData.paxSortPending=busy||lastSort!==sortKey;
  };
  source.geometry.addEventListener('dispose',()=>uniforms.splatData.value?.dispose());
  return ()=>{geometry.setAttribute('splatIndex',new InstancedBufferAttribute(Float32Array.from({length:source.geometry.attributes.position.count},(_,i)=>source.geometry.index?.getX(i)??i),1));lastSort='';};
}
export function gaussianSplatting(parser){return {name:SPLAT_EXTENSION,beforeRoot(){for(const m of parser.json.meshes||[])for(const p of m.primitives)validateSplatPrimitive(p,parser.json);},async afterRoot(result){const reserve=[];result.prepareGaussianFields=()=>reserve.forEach(fn=>fn());const canonical=await parser.getDependencies('mesh');for(let m=0;m<canonical.length;m++){const primitives=parser.json.meshes[m].primitives;for(let p=0;p<primitives.length;p++){const e=primitives[p].extensions?.[SPLAT_EXTENSION];if(!e)continue;const base=canonical[m].isGroup?canonical[m].children[p]:canonical[m];const objects=new Set([base]);for(const scene of result.scenes)scene.traverse(o=>{if(o.geometry===base.geometry)objects.add(o);});for(const source of objects)reserve.push(attachSplat(source,e));}}}};}

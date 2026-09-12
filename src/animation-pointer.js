import { Object3D, VectorKeyframeTrack, QuaternionKeyframeTrack, InterpolateDiscrete, InterpolateLinear } from 'three';
import {pointerDescription,materialFields,textureSlots} from './pointer-description.js';
export {pointerDescription,materialFields,textureSlots} from './pointer-description.js';
export function animationPointer(parser) {
  return { name:'KHR_animation_pointer', async afterRoot(result) {
    const materials = [...await parser.getDependencies('material'), ...(result.variantMaterials || [])];
    for (const scene of result.scenes) scene.traverse(o => { if(o.material) materials.push(...(Array.isArray(o.material)?o.material:[o.material])); });
    for(let a=0;a<(parser.json.animations || []).length;a++) {
      const definition=parser.json.animations[a], clip=result.animations[a];
      for(let c=0;c<definition.channels.length;c++) {
        const channel=definition.channels[c], pointer=channel.target.extensions?.KHR_animation_pointer?.pointer;
        if(!pointer) continue;
        const d=pointerDescription(pointer), sampler=definition.samplers[channel.sampler];
        const input=await parser.getDependency('accessor',sampler.input), output=await parser.getDependency('accessor',sampler.output);
        if(d.kind==='nodes') {
          const node=await parser.getDependency('node',d.id);
          clip.tracks.push(...parser._createAnimationTracks(node,input,output,sampler,{node:d.id,path:d.property})); continue;
        }
        let targets;
        if(d.kind==='nodeFlags')targets=[await parser.getDependency('node',d.id)];
        else if(d.kind==='materials') targets=[...new Set(materials.filter(m=>parser.associations.get(m)?.materials===d.id))];
        else if(d.kind==='cameras') {
          targets=[]; for(const n of parser.json.nodes || []) if(n.camera===d.id) { const node=await parser.getDependency('node',parser.json.nodes.indexOf(n)); node.traverse(o=>{if(o.isCamera)targets.push(o);}); }
          if(!targets.length) targets=[await parser.getDependency('camera',d.id)];
        } else {
          targets=[]; for(let n=0;n<(parser.json.nodes || []).length;n++) if(parser.json.nodes[n].extensions?.KHR_lights_punctual?.light===d.id) { const node=await parser.getDependency('node',n); node.traverse(o=>{if(o.isLight)targets.push(o);}); }
        }
        if(!targets.length) throw new Error(`Animation pointer has no runtime target: ${pointer}`);
        const size=output.itemSize, initial=Array.from(parser._getArrayFromAccessor(output).subarray(sampler.interpolation==='CUBICSPLINE'?size:0,sampler.interpolation==='CUBICSPLINE'?size*2:size));
        const apply = values => {
          for(const target of targets) {
            applyPointerTarget(d,target,values);
          }
        };
        const name=`pax_pointer_${a}_${c}`;
        for(const scene of result.scenes) { const proxy=new Object3D();proxy.name=name;let current=initial.slice();proxy.value={toArray(array,offset){for(let i=0;i<size;i++)array[offset+i]=current[i];},fromArray(array,offset){current=Array.from(array.slice(offset,offset+size));apply(current);}};scene.add(proxy); }
        const Track=d.property==='rotation'&&!d.texture?QuaternionKeyframeTrack:VectorKeyframeTrack;
        const track=new Track(`${name}.value`,input.array,parser._getArrayFromAccessor(output),sampler.interpolation==='STEP'?InterpolateDiscrete:InterpolateLinear);
        if(sampler.interpolation==='CUBICSPLINE')parser._createCubicSplineTrackInterpolant(track);
        clip.tracks.push(track);
      }
      clip.resetDuration();
    }
  } };
}

export function applyPointerTarget(d,target,values){
            if(d.kind==='nodeFlags'){if(d.property==='visible')target.visible=!!values[0];else target.userData[d.property==='selectable'?'paxSelectable':'paxHoverable']=!!values[0];}
            else if(d.texture) {
              const slots=d.texture==='metalnessMap'?['metalnessMap','roughnessMap']:[d.texture];
              for(const slot of slots) { const t=target[slot]; if(!t)continue; if(d.property==='rotation')t.rotation=values[0];else t[d.property==='scale'?'repeat':'offset'].fromArray(values); t.updateMatrix(); }
            } else if(d.kind==='materials') {
              if(d.property==='colorAlpha') { target.color.fromArray(values); target.opacity=values[3]; }
              else if(d.property.endsWith('NormalScale')||d.property==='normalScale')target[d.property].set(values[0],values[0]);
              else if(d.property==='iridescenceThicknessMinimum')target.iridescenceThicknessRange[0]=values[0];
              else if(d.property==='iridescenceThicknessMaximum')target.iridescenceThicknessRange[1]=values[0];
              else if(target[d.property]?.fromArray)target[d.property].fromArray(values); else target[d.property]=values[0];
            } else if(d.kind==='cameras') {
              const v=values[0];
              if(d.property==='yfov')target.fov=v*180/Math.PI;
              else if(d.property==='xmag'){target.left=-v;target.right=v;}
              else if(d.property==='ymag'){target.bottom=-v;target.top=v;}
              else target[{znear:'near',zfar:'far',aspectRatio:'aspect'}[d.property]]=v;
              target.updateProjectionMatrix();
            } else {
              if(d.property==='color')target.color.fromArray(values);
              else if(d.property==='range')target.distance=values[0];
              else if(d.property==='spot/innerConeAngle'){target.userData.paxInnerAngle=values[0];target.penumbra=1-values[0]/target.angle;}
              else if(d.property==='spot/outerConeAngle'){const inner=target.userData.paxInnerAngle ?? target.angle*(1-target.penumbra);target.angle=values[0];target.penumbra=1-inner/target.angle;}
              else target.intensity=values[0];
            }
}

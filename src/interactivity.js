import {AnimationMixer, Vector3} from 'three';
import {GlTFObjectModelDecorator, DOMEventBus} from './vendor/interactivity.js';
import {createBehaviorEngine,validateInteractivity} from './interactivity-validation.js';
import {pointerDescription,applyPointerTarget} from './animation-pointer.js';
// Isolated by default. A host can share a bus explicitly for cross-asset events.
// This prevents the baseline and PAX comparison from sending events to each other.
export class LocalEventBus extends DOMEventBus {
  constructor(){super();this.target=new EventTarget();}
  addCustomEventListener=(name,fn)=>{if(!this.customEventListeners[name]){this.customEventListeners[name]=[];const handler=e=>{for(const callback of this.customEventListeners[name])this.eventList.push({func:()=>callback(e),inSocketId:name});};this.target.addEventListener(name,handler);this.eventListeners[name]=handler;}this.customEventListeners[name].push(fn);}
  dispatchCustomEvent=(name,values)=>{this.target.dispatchEvent(new CustomEvent(name,{detail:values}));}
  clearCustomEventListeners=()=>{for(const [name,handler]of Object.entries(this.eventListeners))this.target.removeEventListener(name,handler);this.eventListeners={};this.customEventListeners={};}
}
function readTarget(d,t){
  if(d.kind==='nodes'){if(d.property==='weights'){let weights=[];t.traverse(o=>{if(o.morphTargetInfluences)weights=o.morphTargetInfluences.slice();});return weights;}return t[{translation:'position',rotation:'quaternion',scale:'scale'}[d.property]].toArray();}
  if(d.kind==='nodeFlags')return [d.property==='visible'?t.visible:t.userData[d.property==='selectable'?'paxSelectable':'paxHoverable']];
  if(d.texture){const texture=t[d.texture];if(!texture)return null;return d.property==='rotation'?[texture.rotation]:texture[d.property==='scale'?'repeat':'offset'].toArray();}
  if(d.kind==='materials'){if(d.property==='colorAlpha')return [...t.color.toArray(),t.opacity];if(d.property==='normalScale'||d.property.endsWith('NormalScale'))return [t[d.property].x];if(d.property.startsWith('iridescenceThickness'))return [t.iridescenceThicknessRange[d.property.endsWith('Minimum')?0:1]];const value=t[d.property];return value?.toArray?value.toArray():[value];}
  if(d.kind==='cameras')return [{yfov:t.fov*Math.PI/180,znear:t.near,zfar:t.far,aspectRatio:t.aspect,xmag:t.right,ymag:t.top}[d.property]];
  if(d.kind==='lights'){if(d.property==='color')return t.color.toArray();return [d.property==='range'?t.distance:d.property==='spot/innerConeAngle'?t.angle*(1-t.penumbra):d.property==='spot/outerConeAngle'?t.angle:t.intensity];}
}
function writeTarget(d,t,value){if(d.kind==='nodes'){if(d.property==='weights')t.traverse(o=>{if(o.morphTargetInfluences)o.morphTargetInfluences.splice(0,value.length,...value);});else {t[{translation:'position',rotation:'quaternion',scale:'scale'}[d.property]].fromArray(value);t.updateMatrix();}return;}applyPointerTarget(d,t,value);}
export function interactivity(parser){return {name:'KHR_interactivity',beforeRoot(){validateInteractivity(parser.json);},async afterRoot(result){
  const ext=parser.json.extensions?.KHR_interactivity;if(!ext)return;
  const engine=createBehaviorEngine(new LocalEventBus());
  const json=structuredClone(parser.json);
  // Three.js samples animation data (including pointer tracks); the object model
  // supplies references and duration queries, never a second animation decoder.
  json.animations=(json.animations||[]).map((a,i)=>({...a,runtimeChannels:[],minTime:0,maxTime:result.animations[i].duration}));
  const model=new GlTFObjectModelDecorator(engine,json),world=model.getWorld();
  const nodes=await parser.getDependencies('node'),materials=[...await parser.getDependencies('material'),...(result.variantMaterials||[])];
  for(const scene of result.scenes)scene.traverse(o=>{if(o.material)materials.push(...(Array.isArray(o.material)?o.material:[o.material]));});
  const ownsWeights=new Set(json.nodes.map((n,i)=>n.weights!==undefined?i:-1));
  const setPath=engine.setPathValue;
  engine.setPathValue=(path,value)=>{setPath(path,value);const node=path.match(/^\/nodes\/(\d+)\/weights(?:\/\d+)?$/);if(node)ownsWeights.add(+node[1]);const mesh=path.match(/^\/meshes\/(\d+)\/weights\/(\d+)$/);if(mesh)json.nodes.forEach((n,i)=>{if(n.mesh===+mesh[1]&&!ownsWeights.has(i)&&world.nodes[i].weights)world.nodes[i].weights[+mesh[2]]=value[0];});};
  const bindings=[];
  for(const path of model.getRegisteredJsonPointers()){
    let d;try{d=pointerDescription(path);}catch{continue;}
    let targets=[];
    if(d.kind==='nodes'||d.kind==='nodeFlags')targets=[nodes[d.id]];
    else if(d.kind==='materials')targets=[...new Set(materials.filter(m=>parser.associations.get(m)?.materials===d.id))];
    else if(d.kind==='cameras')for(let n=0;n<nodes.length;n++){if(json.nodes[n].camera===d.id)nodes[n].traverse(o=>{if(o.isCamera)targets.push(o);});}
    else if(d.kind==='lights')for(let n=0;n<nodes.length;n++){if(json.nodes[n].extensions?.KHR_lights_punctual?.light===d.id)nodes[n].traverse(o=>{if(o.isLight)targets.push(o);});}
    if(targets[0]&&readTarget(d,targets[0])?.every(v=>v!==undefined))bindings.push({path,d,targets});
  }
  const mixers=result.scenes.map(scene=>new AnimationMixer(scene)),active=new Map();
  engine.startAnimation=(index,start,end,speed,done)=>{engine.stopAnimation(index);const data=world.animations[index];Object.assign(data,{isPlaying:true,playhead:start,virtualPlayhead:start});active.set(index,{time:start,end,speed,direction:end>=start?1:-1,done,actions:mixers.map(m=>{const a=m.clipAction(result.animations[index]);a.reset().play();a.paused=true;return a;})});};
  engine.stopAnimation=index=>{const a=active.get(index);if(a)for(const action of a.actions)action.stop();active.delete(index);if(world.animations[index])world.animations[index].isPlaying=false;};
  engine.stopAnimationAt=(index,time,done)=>{const a=active.get(index);if(a){a.end=time;a.done=done;a.direction=time>=a.time?1:-1;}};
  let started=false,disposed=false;
  const runtime={engine,model,bindings,get started(){return started;},
    setEventBus(bus){if(started)throw new Error('Set the event bus before starting the graph');engine.eventBus=bus;return runtime;},
    start(){if(started||disposed)return;started=true;engine.loadBehaveGraph(structuredClone(ext.graphs[ext.graph??0]),false);},
    update(delta=0){if(!started||disposed)return;
      for(const b of bindings)model.setPathValue(b.path,readTarget(b.d,b.targets[0]));
      engine.executeEventQueueTick();
      for(const b of bindings){const v=model.getPathValue(b.path);if(v)for(const target of b.targets)writeTarget(b.d,target,v);}
      for(const [index,a]of active){a.time+=Math.max(0,delta)*a.speed*a.direction;const finished=Number.isFinite(a.end)&&(a.direction>0?a.time>=a.end:a.time<=a.end);if(finished)a.time=a.end;const duration=result.animations[index].duration;for(const action of a.actions)action.time=duration?((a.time%duration)+duration)%duration:0;if(finished&&a.time===duration)for(const action of a.actions)action.time=duration;Object.assign(world.animations[index],{playhead:a.actions[0]?.time??0,virtualPlayhead:a.time});for(const mixer of mixers)mixer.update(0);if(finished){active.delete(index);world.animations[index].isPlaying=false;a.done();}}
    },
    select(index,point,origin,controller=0){engine.select(index,controller,point,origin);},hover(index,controller=0){engine.hoverOn(index,controller);},
    attach(element,camera,raycast){const pointer=new Vector3();const pick=(event,kind)=>{const rect=element.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2,0);return raycast(pointer,camera(),kind);};const indexOf=object=>{for(let o=object;o;o=o.parent){const index=nodes.indexOf(o);if(index>=0)return index;}return undefined;};const click=e=>{const hit=pick(e,'select');if(hit){const i=indexOf(hit.object);if(i!==undefined)runtime.select(i,hit.point.toArray(),camera().getWorldPosition(new Vector3()).toArray());}};const move=e=>{const hit=pick(e,'hover');runtime.hover(hit?indexOf(hit.object):undefined);};const leave=()=>runtime.hover(undefined);element.addEventListener('click',click);element.addEventListener('pointermove',move);element.addEventListener('pointerleave',leave);return ()=>{element.removeEventListener('click',click);element.removeEventListener('pointermove',move);element.removeEventListener('pointerleave',leave);};},
    dispose(){disposed=true;for(const index of active.keys())engine.stopAnimation(index);for(const mixer of mixers){mixer.stopAllAction();mixer.uncacheRoot(mixer.getRoot());}model.dispose();runtime.detach?.();}
  };
  result.interactivity=runtime;
}};}

import './style.css';
import { fetchAsset } from './network.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGLTFLoader, configureDecoders } from './gltf-loader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PAXLoader } from './PAXLoader.js';
const $ = s => document.querySelector(s);
const mb = n => `${(n / 1e6).toFixed(2)} MB`, seconds = ms => `${(ms / 1000).toFixed(2)} s`;
const panes = {}, metrics = {}, history = [];
let controller, running = false, start = 0, activeAsset, selectedFrame, animationTime = 0, frozen = false;
let syncLock = false, choicesReady = false;
function createPane(id) {
  const element = $(`#${id}`), canvas = element.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7)); renderer.setClearColor(0xd9dfd9); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, .001, 10000); camera.position.set(3, 1.4, 4);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment(); const environment = pmrem.fromScene(room, .04); scene.environment = environment.texture; room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9eac99, 2.3)); const light = new THREE.DirectionalLight(0xfff8eb, 2.5); light.position.set(3, 5, 4); scene.add(light);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = false;
  const pane = { id, element, renderer, scene, camera, controls, asset: null, mixer: null, result: null, afterFrame: [] };
  controls.addEventListener('change', () => {
    if (syncLock) return; syncLock = true;
    for (const other of Object.values(panes)) if (other !== pane) { other.camera.position.copy(camera.position); other.camera.quaternion.copy(camera.quaternion); other.camera.near = camera.near; other.camera.far = camera.far; other.camera.updateProjectionMatrix(); other.controls.target.copy(controls.target); other.controls.update(); }
    syncLock = false;
  });
  new ResizeObserver(() => { const r = canvas.parentElement.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); if(pane.activeCamera?.isPerspectiveCamera&&pane.activeCameraViewportAspect){pane.activeCamera.aspect=camera.aspect;pane.activeCamera.updateProjectionMatrix();} }).observe(canvas.parentElement);
  return pane;
}
for (const id of ['baseline', 'progressive']) panes[id] = createPane(id);
function resetPane(pane) {
  pane.gltf?.interactivity?.dispose();
  if (pane.asset) {
    pane.mixer?.stopAllAction(); pane.mixer?.uncacheRoot(pane.asset);
    pane.scene.remove(pane.asset); const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
    pane.asset.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.skeleton) skeletons.add(o.skeleton); if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) materials.add(m); });
    for (const m of materials) { for (const value of Object.values(m)) if (value?.isTexture) textures.add(value); m.dispose(); }
    for (const g of geometries) g.dispose(); for (const t of textures) { t.image?.close?.(); t.dispose(); } for (const s of skeletons) s.dispose();
  }
  pane.asset = pane.mixer = pane.result = pane.gltf = pane.activeCamera = null; pane.controls.enabled=true; pane.afterFrame = [];
  pane.element.querySelector('.empty').style.display = 'flex';
  pane.element.querySelector('.first').textContent = '—'; pane.element.querySelector('.complete').textContent = '—';
  pane.element.querySelector('.detail').textContent = 'Waiting for data';
  setStatus(pane, 'Ready'); metrics[pane.id] = { first: null, complete: null, bytes: 0, total: 0, triangles: 0, events: [], network: [], networkComplete: null, frameGapsMs: [], stallsOver50ms:0, error: null };
  updateProgress(pane, 0, 0);
}
function setStatus(pane, text) { pane.element.querySelector('.status').textContent = text; }
function updateProgress(pane, bytes, total, event) {
  const m = metrics[pane.id]; m.bytes = bytes; m.total = total;
  if (event?.timestamp) { const time = event.timestamp - performance.timeOrigin - start; m.network.push({ time, bytes }); if (event.done) m.networkComplete = time; }
  pane.element.querySelector('.received').textContent = mb(bytes);
  const percent = total ? Math.min(100, bytes / total * 100) : 0;
  pane.element.querySelector('.progress>div').style.width = `${percent}%`; pane.element.querySelector('.percent').textContent = `${percent.toFixed(0)}%`;
}
function frame(pane) { return new Promise(resolve => pane.afterFrame.push(resolve)); }
function frameScene(gltf) {
  const box = new THREE.Box3().setFromObject(gltf.scene), center = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;
  if (!Number.isFinite(radius) || radius <= 0) return;
  selectedFrame = { center, radius };
  for (const pane of Object.values(panes)) {
    pane.controls.target.copy(center); pane.camera.position.copy(center).add(new THREE.Vector3(.85, .35, 1.6).normalize().multiplyScalar(radius * 3.5)); pane.camera.near = radius / 1000; pane.camera.far = radius * 100; pane.camera.updateProjectionMatrix(); pane.controls.update();
  }
}
function applyWireframe() { for (const pane of Object.values(panes)) pane.asset?.traverse(o => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.wireframe = $('#wireframe').checked; }); }
async function showScene(pane, gltf) {
  pane.gltf=gltf;
  if(gltf.interactivity){gltf.interactivity.start();const raycaster=new THREE.Raycaster();gltf.interactivity.detach=gltf.interactivity.attach(pane.renderer.domElement,()=>pane.activeCamera||pane.camera,(pointer,camera,kind)=>{raycaster.setFromCamera(pointer,camera);return gltf.raycast(raycaster,{scene:pane.asset,kind})[0];});}
  pane.asset = gltf.scene; pane.scene.add(gltf.scene); pane.element.querySelector('.empty').style.display = 'none';
  if (!selectedFrame) frameScene(gltf);
  if (gltf.animations.length) { pane.mixer = new THREE.AnimationMixer(gltf.scene); pane.mixer.clipAction(gltf.animations[0]).play(); }
  populateChoices(gltf);applyChoices(pane);
  applyWireframe(); await frame(pane);
  const time = performance.now() - start; metrics[pane.id].first = time; metrics[pane.id].events.push({ time, kind: 'first-render', bytes: metrics[pane.id].bytes });
  pane.element.querySelector('.first').textContent = seconds(time); setStatus(pane, 'Renderable');
}
async function loadGLB(pane, url, signal) {
  const response = await fetchAsset(url, { signal, onProgress: e => updateProgress(pane, e.bytes, e.total, e) }); if (!response.ok) throw new Error(`GLB HTTP ${response.status}`);
  const reader = response.body.getReader(), parts = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; parts.push(value); size += value.length; } } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0; for (const p of parts) { buffer.set(p, offset); offset += p.length; }
  setStatus(pane, 'Decoding'); const gltf = await (pane.gltfLoader ||= configureDecoders(createGLTFLoader(),pane.renderer)).parseAsync(buffer.buffer, ''); signal.throwIfAborted();
  await showScene(pane, gltf); pane.result = { gltf };
  updateSceneDetail(pane);

}
async function loadPAX(pane, url, signal) {
  const loader = new PAXLoader();
  loader.gltfLoader = pane.gltfLoader ||= configureDecoders(createGLTFLoader(),pane.renderer);
  pane.result = await loader.load(url, {
    signal, onProgress: event => updateProgress(pane, event.bytes, event.total, event),
    onScene: gltf => showScene(pane, gltf),
    onRefine(event) {
      metrics[pane.id].events.push({ ...event, time: performance.now() - start });
      updateSceneDetail(pane);
      if (event.kind === 'texture') pane.element.querySelector('.stage').textContent = `TEXTURE ${event.image + 1} · ${event.width} × ${event.height}`;
      else pane.element.querySelector('.stage').textContent = `GEOMETRY ${event.level + 1}`;
      updateSceneDetail(pane);
    },
  });
  pane.element.querySelector('.stage').textContent = 'FULL DETAIL · RECONSTRUCTED';
  updateSceneDetail(pane);
}
function updateSceneDetail(pane){
  let triangles=0,lines=0,points=0;
  pane.asset?.traverseVisible(o=>{
    if(!o.geometry)return;
    const geometry=o.geometry,available=geometry.index?.count||geometry.attributes.position?.count||0;
    const count=Math.max(0,Math.min(available-geometry.drawRange.start,geometry.drawRange.count)),instances=o.isInstancedMesh?o.count:1;
    if(o.userData.paxSplatRenderer)return;
    if(o.isMesh)triangles+=Math.floor(count/3)*instances;
    else if(o.isPoints)points+=count*instances;
    else if(o.isLine)lines+=(o.isLineSegments?Math.floor(count/2):o.isLineLoop?count:Math.max(0,count-1))*instances;
  });
  Object.assign(metrics[pane.id],{triangles,lines,points});
  const labels=[[triangles,'triangles'],[lines,'segments'],[points,'points']].filter(([n])=>n).map(([n,label])=>`${n.toLocaleString()} ${label}`);
  pane.element.querySelector('.detail').textContent=[...labels,`${pane.gltf?.animations.length||0} animation clip(s)`].join(' · ');
}
function populateChoices(gltf){
  if(choicesReady)return;choicesReady=true;
  const fill=(id,options,selected)=>{const el=$('#'+id);el.replaceChildren(...options.map(([value,label])=>new Option(label,value)));el.value=selected;el.disabled=options.length<2;};
  fill('scene-choice',gltf.scenes.map((s,i)=>[String(i),s.name||`Scene ${i+1}`]),String(Math.max(0,gltf.scenes.indexOf(gltf.scene))));
  fill('camera-choice',[['orbit','Orbit camera'],...gltf.cameras.map((c,i)=>[String(i),c.name||`Camera ${i+1}`])],'orbit');
  fill('clip-choice',[['none','No animation'],...gltf.animations.map((c,i)=>[String(i),c.name||`Animation ${i+1}`])],gltf.animations.length&&!gltf.interactivity?'0':'none');
  fill('variant-choice',[['default','Default materials'],...(gltf.variants||[]).map((v,i)=>[String(i),v.name||`Variant ${i+1}`])],'default');
}
function applyChoices(pane){
  const gltf=pane.gltf;if(!gltf)return;
  const scene=gltf.scenes[+$('#scene-choice').value]||gltf.scene;
  if(pane.asset!==scene){pane.scene.remove(pane.asset);pane.asset=scene;pane.scene.add(scene);}
  pane.mixer?.stopAllAction();pane.mixer?.uncacheRoot(pane.mixer.getRoot());
  pane.mixer=gltf.animations.length?new THREE.AnimationMixer(scene):null;
  const clip=$('#clip-choice').value;if(clip!=='none'&&gltf.animations[+clip])pane.mixer.clipAction(gltf.animations[+clip]).play();
  const camera=$('#camera-choice').value;
  if(camera==='orbit')pane.activeCamera=null;
  else {
    const definition=gltf.parser.json.cameras[+camera];
    const selected=gltf.cameraInstances?.find(entry=>entry.cameraIndex===+camera&&scene.getObjectById(entry.camera.id))?.camera;
    pane.activeCamera=selected||gltf.cameras[+camera];
    pane.activeCameraViewportAspect=definition?.type==='perspective'&&definition.perspective.aspectRatio===undefined;
    if(pane.activeCameraViewportAspect){pane.activeCamera.aspect=pane.camera.aspect;pane.activeCamera.updateProjectionMatrix();}
    if(pane.activeCamera?.isPerspectiveCamera && definition?.perspective?.zfar===undefined){pane.activeCamera.far=Infinity;pane.activeCamera.updateProjectionMatrix();}
  }
  pane.controls.enabled=!pane.activeCamera;
  gltf.selectVariant?.($('#variant-choice').value==='default'?null:+$('#variant-choice').value);
  applyWireframe();updateSceneDetail(pane);
}
for(const id of ['scene-choice','camera-choice','clip-choice','variant-choice'])$('#'+id).addEventListener('change',()=>{for(const pane of Object.values(panes))applyChoices(pane);});
function updateObservation() {
  const a = metrics.baseline, b = metrics.progressive;
  if (a.first && b.first) {
    const ratio = a.first / b.first, saved = a.first - b.first;
    $('#observation').textContent = ratio >= 1 ? `A visible model ${ratio.toFixed(1)}× sooner.` : `GLB rendered first in this run.`;
    const bytes = (activeAsset.streamBytes / activeAsset.sourceBytes - 1) * 100;
    $('#interpretation').textContent = `${seconds(Math.abs(saved))} ${saved >= 0 ? 'earlier' : 'later'} with PAX. The complete stream is ${Math.abs(bytes).toFixed(1)}% ${bytes >= 0 ? 'larger' : 'smaller'} than GLB, within the +5% cap. ${activeAsset.latticeTextures} textures reuse samples; ${activeAsset.sourceTextures} use a tiny preview + original.${a.complete && b.complete ? ` Full detail: GLB ${seconds(a.complete)}, PAX ${seconds(b.complete)}.` : ' Full-detail transfer is still in progress.'}`;
  }
}
function timeline(el, m, now) {
  const scale = Math.max(now, 1000), first = m.first ?? now, complete = m.complete ?? now;
  el.innerHTML = `<i class="segment" style="left:0;width:${Math.min(first, now) / scale * 100}%"></i>${m.first !== null ? `<i class="segment renderable" style="left:${first / scale * 100}%;width:${Math.max(0, complete - first) / scale * 100}%"></i>` : ''}${m.complete !== null ? `<i class="segment complete" style="left:${complete / scale * 100}%;width:${Math.max(.4, (now - complete) / scale * 100)}%"></i>` : ''}`;
}
let last = performance.now(), lastUI = 0;
function render(now) {
  requestAnimationFrame(render);if(running)for(const m of Object.values(metrics)){const gap=now-last;m.frameGapsMs.push(gap);if(gap>50)m.stallsOver50ms++;} const delta = Math.min(.1, (now - last) / 1000); last = now;
  if (!frozen && $('#animate').checked) animationTime += delta;
  if ($('#rotate').checked && !frozen && selectedFrame) { const p = panes.baseline, v = p.camera.position.clone().sub(p.controls.target); v.applyAxisAngle(new THREE.Vector3(0, 1, 0), delta * .2); p.camera.position.copy(p.controls.target).add(v); p.controls.update(); }
  for (const pane of Object.values(panes)) { if (pane.mixer) pane.mixer.setTime(animationTime); if(!frozen)pane.gltf?.interactivity?.update(delta); pane.renderer.render(pane.scene, pane.activeCamera || pane.camera); const callbacks = pane.afterFrame.splice(0); for (const fn of callbacks) fn(); }
  if (running && now - lastUI > 100) { const elapsed = now - start; $('#elapsed').textContent = seconds(elapsed); timeline($('#glb-track'), metrics.baseline, elapsed); timeline($('#pax-track'), metrics.progressive, elapsed); updateObservation(); lastUI = now; }
}
requestAnimationFrame(render);
async function run() {
  if (running) return; running = true; controller = new AbortController(); selectedFrame = null; animationTime = 0; frozen = false; choicesReady=false;
  for(const id of ['scene-choice','camera-choice','clip-choice','variant-choice'])$('#'+id).disabled=true;
  activeAsset = catalog.find(a => a.id === $('#asset').value); for (const pane of Object.values(panes)) resetPane(pane);
  $('#run').disabled = true; $('#cancel').disabled = false; $('#asset').disabled = true; $('#rate').disabled = true; $('#latency').disabled = true; $('#export').disabled = true;
  $('#observation').textContent = 'Watching the first bytes arrive.'; $('#interpretation').textContent = 'An equal, independent bandwidth budget for each asset. Both measurements include decoding and rendering.'; $('#run-status').textContent = 'Streaming two uncached responses…';
  const rate = $('#rate').value, latency = $('#latency').value, nonce = crypto.randomUUID(); start = performance.now();
  await Promise.all(Object.values(panes).map(async pane => {
    setStatus(pane, 'Transferring');
    pane.element.querySelector('.empty>span:last-child').textContent = pane.id === 'baseline' ? 'Downloading the complete asset…' : 'Waiting for the renderable bootstrap…';
    try {
      const url = `/stream/${activeAsset.id}.${pane.id === 'baseline' ? 'glb' : 'pax'}?kbps=${rate}&latency=${latency}&run=${nonce}`;
      await (pane.id === 'baseline' ? loadGLB : loadPAX)(pane, url, controller.signal); controller.signal.throwIfAborted(); await frame(pane);
      const time = performance.now() - start; metrics[pane.id].complete = time; metrics[pane.id].events.push({ time, kind: 'complete' }); pane.element.querySelector('.complete').textContent = seconds(time); setStatus(pane, 'Complete');
    } catch (error) { metrics[pane.id].error = controller.signal.aborted ? 'Stopped' : error.message; setStatus(pane, metrics[pane.id].error); if (!controller.signal.aborted) console.error(error); }
  }));
  const elapsed = performance.now() - start; running = false; $('#run').disabled = false; $('#cancel').disabled = true; $('#asset').disabled = false; $('#rate').disabled = false; $('#latency').disabled = false; $('#export').disabled = false;
  $('#run').innerHTML = 'Run again <span>↗</span>'; const failed = Object.values(metrics).some(m => m.error); $('#run-status').textContent = failed ? 'Run stopped or failed. Partial measurements retained.' : 'Complete. Repeat the experiment or export this run.';
  updateObservation(); $('#elapsed').textContent = seconds(elapsed); timeline($('#glb-track'), metrics.baseline, elapsed); timeline($('#pax-track'), metrics.progressive, elapsed);
  const record = { date: new Date().toISOString(), asset: activeAsset, rateKiBps: +rate, latencyMs: +latency, elapsedMs: elapsed, device: navigator.userAgent, viewport: [innerWidth, innerHeight], metrics: structuredClone(metrics), conditions: 'Two concurrent, no-store streams; independent server pacing and network-reader workers. Shared browser CPU/GPU. First rendered frame; not pixel-readback presentation latency.' }; history.push(record); return record;
}
const catalog = await fetch('/assets/catalog.json').then(r => { if (!r.ok) throw new Error('Run npm run assets first'); return r.json(); });
for (const a of catalog) $('#asset').add(new Option(a.name, a.id));
function selectAsset() { const a = catalog.find(a => a.id === $('#asset').value); $('#asset-info').textContent = `${a.kind} · ${a.triangles.toLocaleString()} triangles · ${mb(a.sourceBytes)} GLB / ${mb(a.streamBytes)} PAX · ${a.overheadPercent > 0 ? '+' : ''}${a.overheadPercent.toFixed(1)}%`; $('#source').href = a.sourcePage; }
$('#asset').addEventListener('change', selectAsset); selectAsset();
$('#run').addEventListener('click', run); $('#cancel').addEventListener('click', () => controller?.abort()); $('#wireframe').addEventListener('change', applyWireframe);
$('#export').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = `strata-${activeAsset.id}-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
for (const pane of Object.values(panes)) resetPane(pane);
window.lab = { run, metrics, history, panes, catalog, get running() { return running; }, freeze(time = 0) { frozen = true; animationTime = time; }, frame: () => Promise.all(Object.values(panes).map(frame)) };

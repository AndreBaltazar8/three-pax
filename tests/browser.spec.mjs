import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import sharp from 'sharp';
test.beforeAll(async()=>{await fs.mkdir('artifacts',{recursive:true});});
async function open(page) { await page.goto('/'); await page.waitForFunction(() => !!window.lab); }
async function pixels(page) {
  return page.evaluate(async () => {
    window.lab.freeze(0); await window.lab.frame();for(let i=0;i<240;i++){let pending=false;for(const p of Object.values(window.lab.panes))p.asset?.traverse(o=>{pending ||= !!o.userData.paxSortPending;});if(!pending)break;await window.lab.frame();}
    await window.lab.frame();return Object.values(window.lab.panes).map(p => p.renderer.domElement.toDataURL().split(',')[1]);
  });
}
async function compareImages(images) {
  const [a, b] = await Promise.all(images.map(image => sharp(Buffer.from(image, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  expect(a.info.width).toBe(b.info.width); expect(a.info.height).toBe(b.info.height);
  let difference = 0, foreground = 0;
  for (let i = 0; i < a.data.length; i += 4) { for (let c = 0; c < 3; c++) difference += Math.abs(a.data[i + c] - b.data[i + c]); if (Math.abs(a.data[i] - 217) + Math.abs(a.data[i + 1] - 223) + Math.abs(a.data[i + 2] - 217) > 30) foreground++; }
  const mae = difference / (a.data.length / 4 * 3); expect(foreground).toBeGreaterThan(1000); expect(mae).toBeLessThan(.15); return { mae, foreground, width: a.info.width, height: a.info.height };
}
for (const asset of ['BoomBox', 'BrainStem', 'FlightHelmet']) test(`${asset}: early visibility, completion, pixel agreement and size budget`, async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' || /GL_INVALID|WebGL.*error/.test(m.text())) errors.push(m.text()); });
  // A slow link keeps this a progressive-network test even on a software-rendered CI host.
  await open(page); await page.selectOption('#asset', asset); await page.selectOption('#rate', process.env.CI ? '512' : '8192');
  const record = await page.evaluate(() => window.lab.run());
  expect(record.metrics.baseline.error).toBeNull(); expect(record.metrics.progressive.error).toBeNull();
  expect(record.metrics.progressive.first).toBeLessThan(record.metrics.baseline.first);
  expect(record.metrics.progressive.complete).toBeGreaterThan(record.metrics.progressive.first);
  expect(record.metrics.progressive.bytes).toBeLessThanOrEqual(record.metrics.baseline.bytes * 1.05);
  expect(record.metrics.progressive.events.find(e => e.kind === 'first-render').bytes).toBeLessThan(record.metrics.progressive.bytes);
  const stats=await (await page.request.get(`/assets/${asset}.stats.json`)).json();expect(record.metrics.progressive.events.filter(e => e.kind === 'geometry')).toHaveLength(stats.primitives.reduce((n,p)=>n+p.levels-1,0));
  const finalPixels = await pixels(page); const comparison = await compareImages(finalPixels);
  for (let i = 0; i < 2; i++) await fs.writeFile(`artifacts/${asset}-${i ? 'progressive' : 'baseline'}-canvas.png`, Buffer.from(finalPixels[i], 'base64'));
  if (asset === 'BrainStem') {
    const animation = await page.evaluate(async () => {
      const snapshot = () => Object.values(window.lab.panes).map(p => { const positions = []; p.asset.traverse(o => { if (o.isBone) positions.push(...o.matrixWorld.elements); }); return positions; });
      const before = snapshot(); window.lab.freeze(.7); await window.lab.frame(); return { before, after: snapshot(), clips: window.lab.panes.progressive.result.gltf.animations.length };
    });
    expect(animation.clips).toBeGreaterThan(0); expect(animation.after[0]).not.toEqual(animation.before[0]); expect(animation.after[0]).toEqual(animation.after[1]);
    await pixels(page);
  }
  expect(errors).toEqual([]);
  await fs.writeFile(`artifacts/${asset}-verified.json`, JSON.stringify({ record, comparison, errors }, null, 2));
  await page.screenshot({ path: `artifacts/${asset}-desktop.png`, fullPage: true });
});
test('partial rendering, cancellation, rerun, controls, export and mobile', async ({ page }) => {
  await open(page); await page.selectOption('#asset', 'FlightHelmet'); await page.selectOption('#rate', '512');
  await page.click('#run'); await page.waitForFunction(() => window.lab.metrics.progressive.first !== null && window.lab.metrics.progressive.events.some(e => e.kind === 'geometry'));
  expect(await page.evaluate(() => window.lab.metrics.baseline.first)).toBeNull();
  await page.screenshot({ path: 'artifacts/partial-stream.png', fullPage: true });
  await page.click('#cancel'); await page.waitForFunction(() => !window.lab.running, { timeout: 10000 });
  expect(await page.evaluate(() => window.lab.metrics.progressive.error)).toBe('Stopped');
  await page.selectOption('#asset', 'BrainStem'); await page.selectOption('#rate', '8192'); await page.click('#run'); await page.waitForFunction(() => !window.lab.running);
  expect(await page.evaluate(() => window.lab.metrics.progressive.error)).toBeNull();
  await page.check('#wireframe');
  expect(await page.evaluate(() => { let ok = true; window.lab.panes.progressive.asset.traverse(o => { if (o.isMesh) ok &&= o.material.wireframe; }); return ok; })).toBeTruthy();
  await page.uncheck('#wireframe');
  const downloadPromise = page.waitForEvent('download'); await page.click('#export'); const download = await downloadPromise; await download.saveAs('artifacts/export-verified.json');
  const exported = JSON.parse(await fs.readFile('artifacts/export-verified.json', 'utf8')); expect(exported.length).toBe(2); expect(exported.at(-1).asset.id).toBe('BrainStem');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
});
test('invalid PAX reports failure and leaves the conventional result usable', async ({ page }) => {
  await page.route('**/stream/*.pax?*', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'NOPE' }));
  await open(page); await page.selectOption('#asset', 'BrainStem'); await page.selectOption('#rate', '8192');
  const record = await page.evaluate(() => window.lab.run()); expect(record.metrics.progressive.error).toMatch(/Truncated PAX stream/); expect(record.metrics.baseline.complete).toBeGreaterThan(0); await expect(page.locator('#run')).toBeEnabled();
});
test('morph target appends update the GPU and retain animation at full detail', async ({ page }) => {
  const { makeMorphFixture } = await import('./morph-fixture.mjs'); const fixture = await makeMorphFixture();
  await page.route('**/assets/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([fixture]) }));
  await open(page); await page.selectOption('#rate', '8192'); const record = await page.evaluate(() => window.lab.run());
  expect(record.metrics.progressive.error).toBeNull(); expect(record.metrics.baseline.error).toBeNull();
  await compareImages(await pixels(page));
  const animated = await page.evaluate(async () => { window.lab.freeze(1); await window.lab.frame(); return { images: Object.values(window.lab.panes).map(p => p.renderer.domElement.toDataURL().split(',')[1]), influences: Object.values(window.lab.panes).map(p => { let value; p.asset.traverse(o => { if (o.isMesh) value = o.morphTargetInfluences; }); return value; }) }; });
  expect(animated.influences).toEqual([[1], [1]]); await compareImages(animated.images);
});
test('network readers continue receiving during a main-thread stall', async ({ page }) => {
  await open(page); await page.selectOption('#asset', 'FlightHelmet'); await page.selectOption('#rate', '2048');
  await page.click('#run'); await page.waitForFunction(() => window.lab.metrics.progressive.first !== null);
  const stall = await page.evaluate(() => { const start = performance.now(); while (performance.now() - start < 600) {} return { start, end: performance.now() }; });
  await page.waitForTimeout(200);
  const proof = await page.evaluate(() => ({ start: window.lab.metrics.progressive.network[0].time, a: window.lab.metrics.baseline.network, b: window.lab.metrics.progressive.network }));
  // Consecutive worker-clock samples must exist throughout the stall, rather than
  // one fabricated jump after the UI is released. Each stream is drained independently.
  for (const samples of [proof.a, proof.b]) {
    const recent = samples.slice(-45); expect(recent.length).toBeGreaterThan(10);
    const gaps = recent.slice(1).map((s, i) => s.time - recent[i].time);
    expect(Math.max(...gaps)).toBeLessThan(250);
  }
  expect(stall.end - stall.start).toBeGreaterThanOrEqual(600);
  await page.click('#cancel'); await page.waitForFunction(() => !window.lab.running);
});

test('BoomBox bootstrap preserves the final material colors', async ({ page }) => {
  await open(page); await page.selectOption('#asset', 'BoomBox'); await page.selectOption('#rate', '8192');
  const images = await page.evaluate(async () => {
    const loaderURL = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/PAXLoader.js').name;
    const { PAXLoader } = await import(loaderURL);
    const load = PAXLoader.prototype.load; let first;
    PAXLoader.prototype.load = function (url, options) {
      return load.call(this, url, { ...options, onScene: async (...args) => {
        await options.onScene(...args);
        first = window.lab.panes.progressive.renderer.domElement.toDataURL().split(',')[1];
      } });
    };
    try {
      await window.lab.run(); await window.lab.frame();
      return [first, window.lab.panes.progressive.renderer.domElement.toDataURL().split(',')[1]];
    } finally { PAXLoader.prototype.load = load; }
  });
  const [early, final] = await Promise.all(images.map(x => sharp(Buffer.from(x, 'base64')).ensureAlpha().raw().toBuffer()));
  let error = 0, count = 0;
  for (let i = 0; i < final.length; i += 4) {
    // Compare the bright casing, excluding the flat scene background.
    if (Math.min(...final.subarray(i, i + 3)) < 150 || Math.abs(final[i] - 217) + Math.abs(final[i+1] - 223) + Math.abs(final[i+2] - 217) < 35) continue;
    for (let c = 0; c < 3; c++) error += Math.abs(early[i+c] - final[i+c]);
    count++;
  }
  expect(count).toBeGreaterThan(500);
  console.log('Bootstrap casing color MAE', error / (count * 3));
  expect(error / (count * 3)).toBeLessThan(45);
});

test('progressive extension combinations retain scenes, instances, variants and animation pointers', async ({ page }) => {
  await open(page);
  const proof = await page.evaluate(async () => {
    const { PAXLoader } = await import('/src/PAXLoader.js');
    const THREE = await import('/node_modules/three/build/three.module.js');
    let early, refinements=0;
    const result = await new PAXLoader().load('/stream/TestCompatibility.pax?kbps=2048&latency=80', {
      onScene(gltf,manifest) {
        gltf.selectVariant('Green');
        early={scenes:gltf.scenes.length,variants:gltf.variants.length,vertices:manifest.primitives.map(p=>p.baseVertices)};
      },onRefine(e){if(e.kind==='geometry')refinements++;}
    });
    const {gltf,states,manifest}=result;gltf.selectVariant(null);
    const mixer = new THREE.AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations[0]).play();mixer.setTime(.5);
    const canonical=await gltf.parser.getDependencies('mesh');
    const roughness=canonical[0].material.roughness;
    const instances=[];gltf.scene.traverse(o=>{if(o.isInstancedMesh)instances.push(o.count);});
    const modes=[];gltf.scenes[1].traverse(o=>{if(o.geometry)modes.push(o.isPoints?'points':o.isLine?'lines':'triangles');});
    return {expectedRefinements:manifest.primitives.reduce((n,p)=>n+p.levels-1,0),early,refinements,instances,modes,roughness,complete:states.every((s,i)=>s.vertexCount===manifest.primitives[i].finalVertices && s.geometry.drawRange.count===manifest.primitives[i].finalTriangles*(manifest.primitives[i].indexWidth||3)),textures:result.imageStates.map(s=>[s.width,s.height])};
  });
  expect(proof.early.scenes).toBe(2);expect(proof.early.variants).toBe(1);
  expect(proof.refinements).toBe(proof.expectedRefinements);expect(proof.instances).toEqual([2]);
  expect(proof.modes).toEqual(['points','lines','lines','lines','triangles','triangles','triangles']);
  expect(proof.roughness).toBeCloseTo(.5);expect(proof.complete).toBe(true);expect(proof.textures).toEqual([[256,256]]);
});

for (const id of ['TestDraco','TestMeshopt','TestBasis','TestSkinSets','TestTangents','TestQuantized','TestDiffuseTransmission','TestGaussianSplats','TestInteractivity']) test(`${id}: adapted features render progressively and matches its glTF baseline`, async ({ page }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||/INVALID_OPERATION/.test(m.text()))errors.push(m.text());});
  const stats=JSON.parse(await fs.readFile(`public/assets/${id}.stats.json`,'utf8'));
  await open(page);
  await page.evaluate(({id,stats})=>{window.lab.catalog.push({...stats,id,name:id,kind:'Extension fixture',sourcePage:'#',triangles:stats.primitives.reduce((n,p)=>n+p.finalTriangles,0)});document.querySelector('#asset').add(new Option(id,id));},{id,stats});
  await page.selectOption('#asset',id);await page.selectOption('#rate','2048');
  const record=await page.evaluate(()=>window.lab.run());
  expect(record.metrics.baseline.error).toBeNull();expect(record.metrics.progressive.error).toBeNull();
  expect(record.metrics.progressive.first).toBeLessThan(record.metrics.progressive.complete);
  expect(record.metrics.progressive.events.some(e=>e.kind==='geometry')).toBe(true);
  const comparison=await compareImages(await pixels(page));console.log(id,comparison);expect(errors).toEqual([]);
  if(id==='TestTangents'){
    await page.evaluate(async()=>{window.lab.freeze(.7);await window.lab.frame();});
    const images=await page.evaluate(()=>Object.values(window.lab.panes).map(p=>p.renderer.domElement.toDataURL().split(',')[1]));
    await compareImages(images);
  }
  if(id==='TestSkinSets'){
    const position=await page.evaluate(()=>{let mesh;window.lab.panes.progressive.asset.traverse(o=>{if(o.isSkinnedMesh)mesh=o;});const base=mesh.geometry.getAttribute('position');const vertex=mesh.position.clone().fromBufferAttribute(base,0);const y=vertex.y;mesh.applyBoneTransform(0,vertex);return vertex.y-y;});
    expect(position).toBeCloseTo(1);
  }
});

test('custom extension packets apply at each level and before the first exposed scene', async ({page})=>{
  await open(page);
  const result=await page.evaluate(async()=>{
    const {PAXLoader}=await import('/src/PAXLoader.js');const levels=[];let first;
    const loader=new PAXLoader().registerExtension('TEST_progressive',{
      gltfPlugin:()=>({name:'TEST_progressive'}),
      onPacket({packet,gltf}){const value=packet.take(Uint32Array,1)[0];if(value!==packet.meta.data.value*7)throw new Error('Bad custom payload');levels.push(packet.meta.level);gltf.userData.value=value;}
    });
    const complete=await loader.load('/stream/TestExtension.pax?kbps=2048&latency=80',{onScene(gltf){first={value:gltf.userData.value,packets:levels.length};}});
    return {first,levels,expectedLevels:complete.manifest.levels,final:complete.gltf.userData.value};
  });
  expect(result.first).toEqual({value:0,packets:1});expect(result.levels).toEqual(Array.from({length:result.expectedLevels},(_,i)=>i));expect(result.final).toBe((result.expectedLevels-1)*7);
});

test('viewer can select scenes, source cameras, clips and variants after loading',async({page})=>{
  const stats=JSON.parse(await fs.readFile('public/assets/TestCompatibility.stats.json','utf8'));
  await open(page);await page.evaluate(stats=>{if(!window.lab.catalog.some(a=>a.id==='TestCompatibility')){window.lab.catalog.push({...stats,id:'TestCompatibility',name:'Combined features',kind:'Fixture',sourcePage:'#',triangles:0});document.querySelector('#asset').add(new Option('Combined features','TestCompatibility'));}},stats);
  await page.selectOption('#asset','TestCompatibility');await page.selectOption('#rate','8192');
  const result=await page.evaluate(()=>window.lab.run());expect(result.metrics.progressive.error).toBeNull();
  await page.selectOption('#variant-choice','0');await page.selectOption('#clip-choice','none');
  await page.selectOption('#scene-choice','1');
  expect(await page.evaluate(()=>Object.values(window.lab.panes).every(p=>p.asset===p.gltf.scenes[1]))).toBe(true);
  await page.selectOption('#scene-choice','0');await page.selectOption('#camera-choice','0');
  expect(await page.evaluate(()=>Object.values(window.lab.panes).every(p=>p.activeCamera.far===Infinity&&p.activeCamera.aspect===p.camera.aspect))).toBe(true);
  await page.selectOption('#camera-choice','1');
  expect(await page.evaluate(()=>Object.values(window.lab.panes).every(p=>p.activeCamera.isOrthographicCamera))).toBe(true);
  await page.selectOption('#camera-choice','orbit');
  expect(await page.evaluate(()=>Object.values(window.lab.panes).every(p=>p.controls.enabled))).toBe(true);
});

test('interactivity starts on partial data and keeps selection state through every refinement',async({page})=>{
  await open(page);
  const report=await page.evaluate(async()=>{
    const {PAXLoader}=await import('/src/PAXLoader.js');let runtime,node,first,selected,baseBytes;const positions=[];
    const result=await new PAXLoader().load('/stream/TestInteractivity.pax?kbps=256&latency=20',{onScene:async gltf=>{runtime=gltf.interactivity;node=await gltf.parser.getDependency('node',0);for(let i=0;i<3;i++)runtime.update(0);first=node.scale.toArray();runtime.select(0,[0,0,0],[0,0,3]);for(let i=0;i<3;i++)runtime.update(0);selected=node.position.toArray();},onRefine:event=>{if(event.kind==='base')baseBytes=event.bytes;if(event.kind==='geometry'){runtime.update(0);positions.push(node.position.toArray());}}});
    const done=node.position.toArray();runtime.dispose();return {expectedRefinements:result.manifest.primitives.reduce((n,p)=>n+p.levels-1,0),first,selected,done,positions,baseBytes,total:result.bytes};
  });
  expect(report.first[0]).toBeCloseTo(.8);expect(report.selected).toEqual([.5,0,0]);expect(report.done).toEqual(report.selected);expect(report.positions).toHaveLength(report.expectedRefinements);expect(report.positions.every(v=>v[0]===.5)).toBe(true);expect(report.baseBytes).toBeLessThan(report.total);
});

test('diffuse transmission uses the opposite hemisphere, its own color, and preserves the metal exclusion',async({page})=>{
  const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await open(page);
  const samples=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');const {DiffuseTransmissionMaterial}=await import('/src/diffuse-transmission.js');
    const renderer=new T.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(64,64);renderer.outputColorSpace=T.LinearSRGBColorSpace;renderer.toneMapping=T.NoToneMapping;
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(45,1,.1,10);camera.position.z=3;
    const material=new DiffuseTransmissionMaterial({color:0x0000ff,roughness:1,metalness:0});material.diffuseTransmissionColor.setRGB(1,0,0);
    scene.add(new T.Mesh(new T.PlaneGeometry(2,2),material));const light=new T.DirectionalLight(0xffffff,Math.PI);scene.add(light);const gl=renderer.getContext(),pixel=new Uint8Array(4);
    const sample=(factor,z,metalness=0)=>{material.diffuseTransmission=factor;material.metalness=metalness;light.position.z=z;renderer.render(scene,camera);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return Array.from(pixel);};
    const result={opaqueFront:sample(0,3),opaqueBack:sample(0,-3),transmittedBack:sample(1,-3),transmittedFront:sample(1,3),metalBack:sample(1,-3,1)};const map=new T.DataTexture(new Uint8Array([255,0,0,64]),1,1);map.needsUpdate=true;material.diffuseTransmissionMap=map;material.needsUpdate=true;result.alphaMap=sample(1,-3);renderer.dispose();material.dispose();map.dispose();return result;
  });
  expect(samples.opaqueFront[2]).toBeGreaterThan(150);expect(samples.opaqueBack[0]+samples.opaqueBack[2]).toBeLessThan(5);expect(samples.transmittedBack[0]).toBeGreaterThan(150);expect(samples.transmittedBack[2]).toBeLessThan(5);expect(samples.transmittedFront[2]).toBeLessThan(30);expect(samples.metalBack[0]).toBeLessThan(5);expect(samples.alphaMap[0]).toBeGreaterThan(45);expect(samples.alphaMap[0]).toBeLessThan(80);expect(errors).toEqual([]);
});

test('interactivity animation controls sample live nodes and signal completion',async({page})=>{
 await open(page);const result=await page.evaluate(async()=>{const {PAXLoader}=await import('/src/PAXLoader.js');const {gltf}=await new PAXLoader().load('/stream/TestInteractivity.pax?kbps=8192&latency=0');const runtime=gltf.interactivity,node=await gltf.parser.getDependency('node',0);runtime.update(0);let done=false;runtime.engine.startAnimation(0,.25,.75,1,()=>done=true);runtime.update(.25);const middle=node.position.y;runtime.update(.25);const end=node.position.y;runtime.dispose();return {middle,end,done};});expect(result.middle).toBeCloseTo(.5);expect(result.end).toBeCloseTo(.75);expect(result.done).toBe(true);
});

test('v0 HTTP range bootstrap, selective resource loading and resume fetch each packet once',async({page})=>{
 await open(page);const result=await page.evaluate(async()=>{
  const {PAXLoader}=await import('/src/PAXLoader.js');let exposed=0;
  let session=await new PAXLoader().load('/stream/TestCompatibility.pax?kbps=65536',{transport:'range',maxLevel:0,onScene(){exposed++;}});
  const first={complete:session.complete,bytes:session.bytes,counts:session.states.map(s=>s.vertexCount)};
  session=await session.refine({primitives:[0],images:[]});const selected={complete:session.complete,bytes:session.bytes,counts:session.states.map(s=>s.vertexCount)};
  session=await session.refine();const final={complete:session.complete,bytes:session.bytes,counts:session.states.map(s=>s.vertexCount)};
  const again=await session.refine();session.dispose();return {first,selected,final,again:again.bytes,expected:session.manifest.primitives.map(p=>p.finalVertices),exposed};
 });
 const bytes=(await page.request.get('/assets/TestCompatibility.pax')).body();expect(result.first.complete).toBe(false);expect(result.first.bytes).toBeLessThan(result.final.bytes);expect(result.final.complete).toBe(true);expect(result.final.bytes).toBe((await bytes).length);expect(result.again).toBe(result.final.bytes);expect(result.final.counts).toEqual(result.expected);expect(result.exposed).toBe(1);
});

test('v0 texture tiles can refine a selected region and resume to exact final pixels',async({page})=>{
 await open(page);const report=await page.evaluate(async()=>{
  const {PAXLoader}=await import('/src/PAXLoader.js');let s=await new PAXLoader().load('/stream/TestInteractivity.pax?kbps=65536',{transport:'range',maxLevel:0});
  const tile=s.manifest.textures[0];s=await s.refine({primitives:[],images:[0],tiles:[0]});const partial=s.bytes;s=await s.refine();const pixels=s.imageStates[0].pixels;const hash=pixels?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))).map(v=>v.toString(16).padStart(2,'0')).join(''):null;const result={tileCount:tile.tileCount,codec:tile.codec,hash,complete:s.complete,partial,total:s.bytes};s.dispose();return result;
 });
 const stats=await(await page.request.get('/assets/TestInteractivity.stats.json')).json();expect(report.codec).toBe('tile-lattice');expect(report.complete).toBe(true);expect(report.hash).toBe(stats.verification.textures[0].hash);expect(report.tileCount).toBe(4);expect(report.partial).toBeLessThan(report.total);
});

test('native morph option supports override materials',async({page})=>{
 const {makeMorphFixture}=await import('./morph-fixture.mjs');const fixture=await makeMorphFixture();
 await page.route('**/assets/catalog.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify([fixture])}));
 await open(page);await page.selectOption('#rate','8192');await page.evaluate(async()=>{const {PAXLoader}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/PAXLoader.js').name);const load=PAXLoader.prototype.load;PAXLoader.prototype.load=function(url,options){return load.call(this,url,{...options,reuseMorphTextures:false});};try{await window.lab.run();}finally{PAXLoader.prototype.load=load;}});
 const images=await page.evaluate(async()=>{const T=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/three.js')).name);for(const p of Object.values(window.lab.panes))p.scene.overrideMaterial=new T.MeshNormalMaterial();window.lab.freeze(1);await window.lab.frame();return Object.values(window.lab.panes).map(p=>p.renderer.domElement.toDataURL().split(',')[1]);});
 await compareImages(images);
});

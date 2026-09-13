import fs from "node:fs/promises";
import { test, expect } from "@playwright/test";
for (const asset of ["TestInteractivity", "TestMorph"])
  test(`${asset}: stable GPU storage during progressive refinement`, async ({
    page,
  }) => {
    if (asset === "TestMorph")
      await page.route("**/stream/TestMorph.pax?*", async (route) =>
        route.fulfill({
          contentType: "application/octet-stream",
          body: await fs.readFile(
            new URL("./fixtures/TestMorph.pax", import.meta.url),
          ),
        }),
      );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/examples/profile.html?asset=${asset}&format=pax`);
    const report = await page.evaluate(() => window.profileDone);
    expect(errors).toEqual([]);
    expect(report.geometryReplacements).toBe(0);
    expect(report.counts.deleteBuffer || 0).toBe(0);
    expect(report.counts.deleteTexture || 0).toBe(0);
    expect(report.loader.geometryDisposals).toBe(0);
    if (asset === "TestInteractivity") {
      expect(report.loader.textureRectUploads).toBeGreaterThan(0);
      expect(report.counts.texSubImage2D).toBeLessThan(100);
      expect(report.loader.patchReuses).toBeGreaterThan(0);
    }
  });
test("slow consumer bounds read-ahead and cancellation stops the network worker", async ({
  page,
}) => {
  await page.goto("/examples/profile.html?asset=TestInteractivity");
  await page.evaluate(() => window.profileDone);
  const result = await page.evaluate(async () => {
    const { fetchAsset } = await import("/src/network.js");
    const metrics = {},
      maxBufferedBytes = 256 * 1024;
    let progress = 0;
    const response = await fetchAsset("/stream/BoomBox.pax?kbps=1048576", {
      maxBufferedBytes,
      metrics,
      onProgress: () => progress++,
    });
    const reader = response.body.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 150));
    const peak = metrics.networkQueuePeakBytes;
    await reader.cancel();
    const before = progress;
    await new Promise((r) => setTimeout(r, 100));
    return { peak, maxBufferedBytes, before, after: progress };
  });
  expect(result.peak).toBe(result.maxBufferedBytes);
  expect(result.after).toBe(result.before);
});

test('splat packing includes vertices published across scheduling yields',async({page})=>{
 await page.goto('/');await page.waitForFunction(()=>!!window.lab);
 const report=await page.evaluate(async()=>{
  const {PAXLoader}=await import('/src/PAXLoader.js');const pane=window.lab.panes.progressive;
  const result=await new PAXLoader().load('/stream/TestGaussianSplats.pax?kbps=65536',{renderer:pane.renderer,uploadBudgetBytes:1,onScene(gltf){pane.scene.add(gltf.scene);}});
  await window.lab.frame();let checked=0,errors=0;
  for(const state of result.states)for(const source of state.meshes){const mesh=source.children.find(o=>o.userData.paxSplatRenderer);if(!mesh)continue;const data=mesh.material.uniforms.splatData.value.image.data,position=state.geometry.attributes.position;for(let i=0;i<state.vertexCount;i++)for(let c=0;c<3;c++){checked++;if(data[i*76+c]!==position.getComponent(i,c))errors++;}}
  result.dispose();return {checked,errors};
 });
 expect(report.checked).toBeGreaterThan(100);expect(report.errors).toBe(0);
});

test('cancelled bootstrap releases GPU textures before exposing a scene',async({page})=>{
 await page.goto('/');await page.waitForFunction(()=>!!window.lab);
 const result=await page.evaluate(async()=>{
  const {PAXLoader}=await import('/src/PAXLoader.js'),renderer=window.lab.panes.progressive.renderer,controller=new AbortController();
  const before=renderer.info.memory.textures,init=renderer.initTexture;let exposed=false,rejected=false,allocated=false;
  renderer.initTexture=function(texture){init.call(this,texture);allocated=true;controller.abort();};
  try{await new PAXLoader().load('/stream/TestInteractivity.pax?kbps=65536',{renderer,signal:controller.signal,onScene(){exposed=true;}});}catch(error){rejected=error.name==='AbortError';}finally{renderer.initTexture=init;}
  return {before,after:renderer.info.memory.textures,exposed,rejected,allocated};
 });
 expect(result.allocated).toBe(true);expect(result.rejected).toBe(true);expect(result.exposed).toBe(false);expect(result.after).toBe(result.before);
});

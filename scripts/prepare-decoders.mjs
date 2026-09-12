import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const root=path.dirname(path.dirname(require.resolve('three')));
for(const [folder,files] of Object.entries({basis:['basis_transcoder.js','basis_transcoder.wasm'],draco:['draco_wasm_wrapper.js','draco_decoder.wasm']})) {
  const dest=new URL(`../public/decoders/${folder}/`,import.meta.url);await fs.mkdir(dest,{recursive:true});
  for(const file of files)await fs.copyFile(path.join(root,'examples/jsm/libs',folder,folder==='draco'?'gltf':'',file),new URL(file,dest));
}
await fs.copyFile(path.join(root,'LICENSE'),new URL('../public/decoders/LICENSE-three.txt',import.meta.url));

// Exercise the actual distributable, including installation lifecycle and exports.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'three-pax-package-'));
const run=(args,cwd=process.cwd())=>{const result=spawnSync('npm',args,{cwd,encoding:'utf8'});if(result.status!==0)throw new Error(result.stdout+result.stderr);return result.stdout;};
try{
 const [packed]=JSON.parse(run(['pack','--pack-destination',temp,'--json']));
 const consumer=path.join(temp,'consumer');await fs.mkdir(consumer);await fs.writeFile(path.join(consumer,'package.json'),JSON.stringify({name:'pax-package-verification',private:true,type:'module',dependencies:{'three-pax':`file:${path.join(temp,packed.filename)}`,three:'0.186.0'}}));
 run(['install'],consumer);const root=path.join(consumer,'node_modules/three-pax');
 const {VERSION,PAXLoader}=await import(pathToFileURL(path.join(root,'src/index.js')));if(VERSION!==0||typeof new PAXLoader().load!=='function')throw new Error('Broken package entrypoint');
 for(const name of ['decoder.worker.js','network.worker.js','splat-sort.worker.js'])await fs.access(path.join(root,'src',name));
 console.log('Packed package installs, exports PAX version 0, and contains all runtime workers.');
}finally{await fs.rm(temp,{recursive:true,force:true});}

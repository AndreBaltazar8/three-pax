import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const revision='14f172a158c19933fa74119602641b272aee9673';
try{if((await fs.readFile('.cache/converter-revision','utf8')).trim()===revision){await import('convert-pax');process.exit(0);}}catch{}
const result=spawnSync('npm',['install','--no-save','--package-lock=false',`git+ssh://git@github.com/AndreBaltazar8/convert-pax.git#${revision}`],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);
await fs.mkdir('.cache',{recursive:true});await fs.writeFile('.cache/converter-revision',revision+'\n');

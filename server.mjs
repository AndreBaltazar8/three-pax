import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
let vite;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/stream/')) return vite.middlewares(req, res);
  const file = url.pathname.slice('/stream/'.length);
  if (!/^[a-zA-Z0-9_-]+\.(glb|pax)$/.test(file)) { res.writeHead(400).end('Invalid asset'); return; }
  const rate = Math.max(64, Math.min(1048576, Number(url.searchParams.get('kbps')) || 2048)) * 1024;
  const latency = Math.max(0, Math.min(2000, Number(url.searchParams.get('latency')) || 0));
  let stream, timer, resolveDelay; let closed = false;
  const delay = ms => new Promise(resolve => { resolveDelay = resolve; timer = setTimeout(() => { resolveDelay = null; resolve(); }, ms); });
  res.on('close', () => { closed = true; clearTimeout(timer); resolveDelay?.(); resolveDelay = null; stream?.destroy(); });
  try {
    const filename = path.join(root, 'public/assets', file), stat = await fsp.stat(filename);
    let start=0,end=stat.size-1,status=200;
    const etag=`"${stat.size}-${stat.mtimeMs}"`;
    if(req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)){
      const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      if(!match||Number(match[1])>Number(match[2])||Number(match[2])>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return;}
      start=Number(match[1]);end=Number(match[2]);status=206;
    }
    res.writeHead(status, { 'Accept-Ranges':'bytes',ETag:etag,...(status===206?{'Content-Range':`bytes ${start}-${end}/${stat.size}`} : {}), 'Content-Type': 'application/octet-stream', 'Content-Length': end-start+1, 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Benchmark-Rate': rate }); res.flushHeaders();
    if(req.method==='HEAD'){res.end();return;}
    await delay(latency); if (closed) return;
    // Equal independent bandwidth per asset; bytes are paced on the server, not hidden by a UI timer.
    const chunkSize = Math.min(65536, Math.max(1024, Math.round(rate / 40)));
    stream = fs.createReadStream(filename, { highWaterMark: chunkSize, start, end }); let sent = 0; const began = performance.now();
    for await (const chunk of stream) {
      const target = (sent + chunk.length) / rate * 1000;
      await delay(Math.max(0, target - (performance.now() - began)));
      if (closed) break;
      if (!res.write(chunk)) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); }); sent += chunk.length;
    }
    if (!closed) res.end();
  } catch (err) { if (!closed) { if (!res.headersSent) res.writeHead(404); res.end('Asset unavailable'); } }
});
const port = Number(process.env.PORT || 4186);
vite = await createViteServer({ root, server: { middlewareMode: true, hmr:{server} }, appType: 'spa' });
server.listen(port, '0.0.0.0', () => console.log(`Progressive Asset Lab → http://localhost:${port}`));

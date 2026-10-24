import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const port = Number(process.env.PREVIEW_PORT || 4178);
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Chemin refusé.');
    const file = (await stat(target)).isDirectory() ? path.join(target, 'index.html') : target;
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Ressource absente : lancer npm run build.'); }
}).listen(port, '127.0.0.1', () => console.log('Aperçu local : http://127.0.0.1:' + port + '/'));

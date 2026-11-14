// Petit serveur local sans dépendance : node serve.mjs  ->  http://localhost:8132
// (Le Bluetooth du navigateur exige localhost ou https.)
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8132;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/** Date de la dernière modification de l'appli (pour proposer de recharger). */
async function appVersion() {
  let max = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else max = Math.max(max, (await stat(p)).mtimeMs);
    }
  };
  await walk(join(ROOT, 'js'));
  await walk(join(ROOT, 'css'));
  max = Math.max(max, (await stat(join(ROOT, 'index.html'))).mtimeMs);
  return Math.round(max);
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/__version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ v: await appVersion() }));
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    // no-store : le navigateur reprend toujours la dernière version des fichiers
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Introuvable');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Paddock : http://localhost:${PORT}`);
});

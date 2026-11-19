// Sirve ui/ en http://localhost:5174 para probar la pantalla en el navegador (sin la parte nativa).
// /dev/catalog.json trae el catálogo publicado en GitHub (en la app lo baja la parte nativa).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../ui/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT) || 5174;
const catalogFile = process.argv.includes('--catalog') ? process.argv[process.argv.indexOf('--catalog') + 1] : null;
const CATALOG_URL = 'https://github.com/mmunozpatino/lp-store/releases/download/catalogo/catalog.json';

createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  if (name === 'dev/catalog.json') {
    try {
      // --catalog <archivo> usa uno local (por ejemplo, el que arma scripts/catalog.mjs).
      const body = catalogFile ? await readFile(catalogFile) : Buffer.from(await (await fetch(CATALOG_URL)).arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    } catch {
      return res.writeHead(502).end();
    }
  }
  const file = path.join(root, name);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] ?? 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`http://localhost:${port}`));

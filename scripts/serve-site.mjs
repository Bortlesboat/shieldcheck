import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SITE_FILES, within } from './build-site.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const allowed = new Set([...SITE_FILES, '.nojekyll']);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.png': 'image/png' };

export function createSiteServer({ directory = root, basePath = '/' } = {}) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('invalid_site_base_path');
  return createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    let path;
    try { path = decodeURIComponent(request.url.split('?')[0]); }
    catch { return send(400, 'Invalid path.'); }
    if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) return send(400, 'Invalid path.');
    if (basePath !== '/' && path === basePath.slice(0, -1)) return send(308, 'Use the site directory.', { Location: basePath });
    if (!path.startsWith(basePath)) return send(404, 'Not found.');
    const name = path.slice(basePath.length) || 'index.html';
    if (!allowed.has(name)) return send(404, 'Not found.');
    try {
      const site = await realpath(directory);
      const target = await realpath(resolve(site, name));
      if (!within(site, target)) return send(404, 'Not found.');
      const bytes = await readFile(target);
      const type = types[extname(name)] || 'text/plain';
      return send(200, bytes, { 'Content-Type': type.startsWith('video/') || type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'Content-Length': bytes.length });
    } catch { return send(404, 'Not found.'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let port = 4173;
    let basePath = '/';
    const seen = new Set();
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      const value = process.argv[index + 1];
      if (seen.has(flag) || !value || !['--port', '--base-path'].includes(flag)) throw new Error('invalid_site_arguments');
      seen.add(flag);
      if (flag === '--port') {
        if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('invalid_site_port');
        port = Number(value);
      } else basePath = value;
    }
    await realpath(root);
    const server = createSiteServer({ basePath });
    server.on('error', () => { console.error('Unable to start the static site server.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Static site: http://127.0.0.1:${port}${basePath}`));
  } catch {
    console.error('Build the site first. Usage: node scripts/serve-site.mjs [--port 4173] [--base-path /shieldcheck/]');
    process.exitCode = 1;
  }
}

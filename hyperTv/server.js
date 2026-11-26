// 本地开发/验证服务器（仅 Node 环境使用；Edge 入口仍为 api/index.js）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 7100);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serveStatic(res, file) {
  try {
    const buf = await readFile(path.join(PUBLIC, file));
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  if (urlPath === '/configure' || urlPath === '/configure.html') {
    await serveStatic(res, 'configure.html');
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  try {
    const request = new Request(`http://${HOST}:${PORT}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await handler(request);
    const outHeaders = Object.fromEntries(response.headers);
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: e?.message || 'internal error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HypeTv addon running at http://${HOST}:${PORT}`);
  console.log(`Configure: http://${HOST}:${PORT}/configure`);
});

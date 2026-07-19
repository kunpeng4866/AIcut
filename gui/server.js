// Dev server: bridges browser GUI ↔ Rust engine CLI
// Run: node server.js
const { spawn } = require('child_process');
const { readFile, writeFile, unlink } = require('fs/promises');
const { createServer } = require('http');
const { join } = require('path');
const { tmpdir } = require('os');

const PORT = 3456;
const ENGINE = join(__dirname, '..', 'target', 'debug', 'aicut-engine.exe');

function callEngine(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
    child.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.tsx': 'text/plain', '.ts': 'text/plain' };

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API endpoints
  if (url.pathname === '/api/render' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tmp = join(tmpdir(), `aicut-${Date.now()}.json`);
      await writeFile(tmp, body, 'utf8');
      const cmd = await callEngine('render', tmp);
      await unlink(tmp).catch(() => {});
      json(res, 200, { success: true, command: cmd });
    } catch (e) { json(res, 500, { success: false, error: e.message }); }
    return;
  }

  if (url.pathname === '/api/probe' && req.method === 'POST') {
    try {
      const { path } = JSON.parse(await readBody(req));
      const info = JSON.parse(await callEngine('probe', path));
      json(res, 200, { success: true, info });
    } catch (e) { json(res, 500, { success: false, error: e.message }); }
    return;
  }

  if (url.pathname === '/api/presets') {
    try {
      const list = JSON.parse(await callEngine('presets'));
      json(res, 200, list);
    } catch (e) { json(res, 500, []); }
    return;
  }

  if (url.pathname === '/api/version') {
    try { json(res, 200, { version: await callEngine('version') }); }
    catch (e) { json(res, 500, { version: 'unknown' }); }
    return;
  }

  // Static files from dist/
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const content = await readFile(join(__dirname, 'dist', filePath));
    const ext = filePath.match(/\.[a-z]+$/)?.[0] || '';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    // Fallback: serve from root
    try {
      const content = await readFile(join(__dirname, filePath));
      const ext = filePath.match(/\.[a-z]+$/)?.[0] || '';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  }
});

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`AIcut GUI: http://localhost:${PORT}`);
  console.log(`Engine: ${ENGINE}`);
});

// Simple local API server for development — run with: node dev-api.cjs
// Mirrors what Vercel runs in production for the /api routes.
require('dotenv').config();

const http = require('http');
const { execSync } = require('child_process');

// Compile TypeScript API file on-the-fly using esbuild
let handler;
try {
  const esbuild = require('esbuild');
  const result = esbuild.buildSync({
    entryPoints: ['api/review-text.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['openai', '@supabase/supabase-js'],
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
  handler = mod.exports.default ?? mod.exports;
} catch (e) {
  console.error('Could not compile API route. Make sure esbuild is available:', e.message);
  console.error('Run: npm install -D esbuild');
  process.exit(1);
}

const PORT = 3001;

const server = http.createServer((req, res) => {
  if (req.url === '/api/review-text' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const parsedBody = JSON.parse(body || '{}');
      const fakeReq = { method: req.method, body: parsedBody };
      const fakeRes = {
        _status: 200,
        status(code) { this._status = code; return this; },
        end() { res.writeHead(this._status); res.end(); },
        json(data) {
          res.writeHead(this._status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(data));
        },
      };
      try {
        await handler(fakeReq, fakeRes);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Local API server running on http://localhost:${PORT}`);
  console.log('POST http://localhost:3001/api/review-text');
});

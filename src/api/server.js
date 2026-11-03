// http.createServer + serveIndex + 静态文件服务（源 server.js:793-803、804 实例创建）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { htmlCache } = require('../state');
const routes = require('./routes');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// 只读静态服务仅允许的白名单扩展名与对应 Content-Type
const ALLOWED_EXT = new Set(['.html', '.css', '.js']);
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
function serveIndex(res) {
  const f = path.join(PUBLIC_DIR, 'index.html');
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== htmlCache.mtime || !htmlCache.content) {
      htmlCache.mtime = st.mtimeMs;
      htmlCache.content = fs.readFileSync(f, 'utf8');
    }
  } catch (e) {
    if (!htmlCache.content) htmlCache.content = '<h1>public/index.html 缺失</h1>';
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlCache.content);
}
// 只读静态文件服务: 归一化路径后必须仍位于 public/ 内, 越界返回 403; 非白名单扩展名返回 false(交由调用方 404)
function serveStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return false;
  }
  const rel = path.posix.normalize(decoded).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  const ext = path.extname(full).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return false;
  let content;
  try {
    content = fs.readFileSync(full);
  } catch (e) {
    return false;
  }
  res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] });
  res.end(content);
  return true;
}
function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const json = (d, s = 200) => {
      res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(d));
    };
    try {
      if (p === '/' || p === '/index.html') return serveIndex(res);
      if (p.startsWith('/api/')) return await routes.handle(p, req, res, json);
      if (serveStatic(res, p)) return;
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  });
}
module.exports = { createServer, serveIndex };

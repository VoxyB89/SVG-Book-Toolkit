#!/usr/bin/env node
/**
 * server.js — local helper for the SVG Book Toolkit
 *
 *   1) Cookie / CORS proxy   →  GET /proxy?url=...
 *   2) Large-book PDF build  →  POST /convert
 *
 * Requires (once):
 *   npm install pdf-lib sharp
 *
 * Usage:
 *   node server.js [port]     default 8788
 *
 * Copyright (c) 2026 Avrixfal (GitHub: VoxyB89)
 * See LICENSE for terms.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { URL } = require('url');

const port = process.argv[2] ? parseInt(process.argv[2], 10) : 8788;
const MAX_REDIRECTS = 5;

let PDFDocument;
let sharp;
let depsOk = false;
try {
  ({ PDFDocument } = require('pdf-lib'));
  sharp = require('sharp');
  depsOk = true;
} catch (_) {
  console.warn('Note: pdf-lib / sharp not installed. Proxy still works.');
  console.warn('For /convert run:  npm install pdf-lib sharp');
}

let converting = false;
let convertStartedAt = 0;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Inject-Cookie');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Convert-Log, Content-Disposition');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------- cookie / CORS proxy ---------------- */

function fetchThroughRedirects(targetUrl, injectCookie, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      reject(new Error('Invalid URL'));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const opts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'SVG-Book-Toolkit-Proxy/1.0',
        Accept: '*/*'
      }
    };
    if (injectCookie) opts.headers.Cookie = injectCookie;

    const req = lib.request(opts, (res) => {
      const loc = res.headers.location;
      if (loc && res.statusCode >= 300 && res.statusCode < 400 && redirectsLeft > 0) {
        res.resume();
        let next;
        try {
          next = new URL(loc, targetUrl).href;
        } catch (_) {
          reject(new Error('Bad redirect'));
          return;
        }
        fetchThroughRedirects(next, injectCookie, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 500,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function handleProxy(req, res, urlObj) {
  const target = urlObj.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url=');
    return;
  }
  const inject = req.headers['x-inject-cookie'] || '';
  try {
    const result = await fetchThroughRedirects(target, inject, MAX_REDIRECTS);
    const headers = { ...result.headers };
    delete headers['access-control-allow-origin'];
    delete headers['access-control-allow-headers'];
    delete headers['content-encoding'];
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    setCors(res);
    res.writeHead(result.status, {
      'Content-Type': headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(result.body);
  } catch (err) {
    setCors(res);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  }
}

/* ---------------- PDF convert (large books) ---------------- */

const PRESETS = {
  a4p: { w: 595.28, h: 841.89 },
  a4l: { w: 841.89, h: 595.28 },
  letterp: { w: 612, h: 792 },
  letterl: { w: 792, h: 612 }
};

const ASSET_DIR_RE = /(^|\/)(img|images|image|shade|shades|assets|asset|media|pics|pictures|resources)(\/|$)/i;
const PAGE_EXT_RE = /\.(svg|png|jpe?g|gif|webp|bmp)$/i;
const RASTER_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function naturalCompare(a, b) {
  const ax = [];
  const bx = [];
  String(a).replace(/(\d+)|(\D+)/g, (_, d, s) => {
    ax.push([d ? parseInt(d, 10) : Infinity, s || '']);
    return '';
  });
  String(b).replace(/(\d+)|(\D+)/g, (_, d, s) => {
    bx.push([d ? parseInt(d, 10) : Infinity, s || '']);
    return '';
  });
  while (ax.length && bx.length) {
    const an = ax.shift();
    const bn = bx.shift();
    const nc = an[0] - bn[0];
    if (nc) return nc;
    const sc = an[1].localeCompare(bn[1]);
    if (sc) return sc;
  }
  return ax.length - bx.length;
}

async function walkDir(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isPageFile(relPosix) {
  if (!PAGE_EXT_RE.test(relPosix)) return false;
  if (ASSET_DIR_RE.test(relPosix)) return false;
  const parts = relPosix.split('/');
  if (parts.length >= 3 && RASTER_EXT_RE.test(parts[parts.length - 1])) return false;
  if (parts.length === 2 && RASTER_EXT_RE.test(parts[1])) return false;
  return true;
}

function dirOf(rel) {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i + 1) : '';
}

function stemOf(rel) {
  const base = rel.split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '');
}

function resolveAssetCandidates(svgRel, href, assetSet) {
  if (!href || href.startsWith('data:') || href.startsWith('#') || /^https?:\/\//i.test(href)) {
    return [];
  }
  let h = href.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^\.\//, '');
  const base = dirOf(svgRel);
  const stem = stemOf(svgRel);
  function join(baseDir, rel) {
    const parts = (baseDir + rel).split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join('/');
  }
  const candidates = [];
  candidates.push(join(base, h));
  candidates.push(h);
  if (stem && !base && !h.startsWith(stem + '/')) candidates.push(join(stem + '/', h));
  if (stem && base) candidates.push(join(base, stem + '/' + h));
  const found = [];
  for (const c of candidates) {
    if (c && assetSet.has(c)) found.push(c);
  }
  const bn = h.split('/').pop();
  if (bn) {
    const matches = [...assetSet].filter((p) => p.split('/').pop() === bn);
    if (matches.length === 1) found.push(matches[0]);
    else {
      const pref = matches.find((p) => p.startsWith(stem + '/'));
      if (pref) found.push(pref);
    }
  }
  return [...new Set(found)];
}

async function inlineLocalAssets(svgText, svgRel, absRoot, assetSet) {
  let out = svgText;
  const hrefRe = /((?:xlink:)?href\s*=\s*["'])([^"']+)(["'])/gi;
  const replacements = [];
  const seen = new Set();
  let m;
  while ((m = hrefRe.exec(svgText)) !== null) {
    const href = m[2];
    if (seen.has(href)) continue;
    seen.add(href);
    const hits = resolveAssetCandidates(svgRel, href, assetSet);
    if (!hits.length) continue;
    const abs = path.join(absRoot, hits[0].split('/').join(path.sep));
    try {
      const buf = await fsp.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      let mime = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.svg') mime = 'image/svg+xml';
      replacements.push({ from: href, to: `data:${mime};base64,${buf.toString('base64')}` });
    } catch (_) {}
  }
  for (const { from, to } of replacements) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('((?:xlink:)?href\\s*=\\s*["\'])' + esc + '(["\'])', 'gi'), '$1' + to + '$2');
    out = out.replace(new RegExp('url\\(\\s*[\'"]?' + esc + '[\'"]?\\s*\\)', 'gi'), 'url(' + to + ')');
  }
  return out;
}

function parseSvgSize(svgText) {
  let w = 0;
  let h = 0;
  const wm = svgText.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const hm = svgText.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  if (wm) w = parseFloat(wm[1]);
  if (hm) h = parseFloat(hm[1]);
  const vb = svgText.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      if (!w || !isFinite(w)) w = parts[2];
      if (!h || !isFinite(h)) h = parts[3];
    }
  }
  return { w: w || 800, h: h || 600 };
}

async function rasterizePage(absPath, relPosix, absRoot, assetSet, dpi) {
  const ext = path.extname(absPath).toLowerCase();
  const scale = Math.max(1, (dpi || 150) / 72);

  if (ext === '.svg') {
    let svgText = await fsp.readFile(absPath, 'utf8');
    svgText = await inlineLocalAssets(svgText, relPosix, absRoot, assetSet);
    const { w, h } = parseSvgSize(svgText);
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    if (!/\bwidth\s*=/i.test(svgText)) {
      svgText = svgText.replace(/<svg\b/i, `<svg width="${w}" height="${h}"`);
    }
    const png = await sharp(Buffer.from(svgText), { density: Math.round(72 * scale) })
      .resize(outW, outH, { fit: 'fill' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { buffer: png, widthPx: outW, heightPx: outH };
  }

  const img = sharp(absPath).rotate();
  const meta = await img.metadata();
  let w = meta.width || 800;
  let h = meta.height || 600;
  const maxEdge = Math.round(2000 * (dpi / 150));
  if (Math.max(w, h) > maxEdge) {
    const s = maxEdge / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const buffer = await img
    .resize(w, h, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const outMeta = await sharp(buffer).metadata();
  return { buffer, widthPx: outMeta.width || w, heightPx: outMeta.height || h };
}

async function convertFolder(folder, options, onProgress) {
  if (!depsOk) throw new Error('Install deps first: npm install pdf-lib sharp');
  const absRoot = path.resolve(folder);
  const st = await fsp.stat(absRoot);
  if (!st.isDirectory()) throw new Error('Not a directory: ' + absRoot);

  const allFiles = await walkDir(absRoot);
  const assetSet = new Set();
  const pages = [];
  for (const full of allFiles) {
    const rel = toPosix(path.relative(absRoot, full));
    if (!rel || rel.startsWith('..')) continue;
    if (PAGE_EXT_RE.test(rel)) assetSet.add(rel);
    if (isPageFile(rel)) pages.push({ full, rel });
  }
  pages.sort((a, b) => naturalCompare(a.rel, b.rel));
  if (!pages.length) throw new Error('No page files found');

  onProgress && onProgress(`Found ${pages.length} pages, ${assetSet.size} media files`);

  const pageSize = options.pageSize || 'a4p';
  const dpi = options.dpi || 150;
  const preset = pageSize === 'own' ? null : PRESETS[pageSize] || PRESETS.a4p;
  const pdf = await PDFDocument.create();
  let done = 0;

  for (const page of pages) {
    try {
      const raster = await rasterizePage(page.full, page.rel, absRoot, assetSet, dpi);
      const embedded = await pdf.embedJpg(raster.buffer);
      let pageW, pageH, drawW, drawH;
      if (preset) {
        pageW = preset.w;
        pageH = preset.h;
        // stretch to fill — no white bars
        drawW = pageW;
        drawH = pageH;
      } else {
        pageW = raster.widthPx * (72 / dpi);
        pageH = raster.heightPx * (72 / dpi);
        drawW = pageW;
        drawH = pageH;
      }
      const pdfPage = pdf.addPage([pageW, pageH]);
      pdfPage.drawImage(embedded, { x: 0, y: 0, width: drawW, height: drawH });
    } catch (err) {
      onProgress && onProgress(`FAIL ${page.rel}: ${err.message}`);
    }
    done++;
    if (done % 10 === 0 || done === pages.length) {
      onProgress && onProgress(`Rasterized ${done}/${pages.length}`);
    }
  }

  if (pdf.getPageCount() === 0) throw new Error('No pages could be rendered');
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

/* ---------------- HTTP router ---------------- */

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://localhost:${port}`);

  if (req.method === 'GET' && urlObj.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        port,
        depsOk,
        busy: converting,
        runningForSec: converting ? Math.round((Date.now() - convertStartedAt) / 1000) : 0
      })
    );
    return;
  }

  if (req.method === 'GET' && urlObj.pathname === '/proxy') {
    await handleProxy(req, res, urlObj);
    return;
  }

  if (req.method === 'GET' && urlObj.pathname === '/open') {
    try {
      const filePath = urlObj.searchParams.get('path');
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing ?path=');
        return;
      }
      const abs = path.resolve(filePath);
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw new Error('Not a file');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': st.size,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(abs).pipe(res);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Cannot open: ' + err.message);
    }
    return;
  }

  if (req.method === 'POST' && urlObj.pathname === '/convert') {
    if (!depsOk) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Missing deps. Run: npm install pdf-lib sharp');
      return;
    }
    if (converting) {
      const secs = Math.round((Date.now() - convertStartedAt) / 1000);
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('Busy: convert already running (' + secs + 's). Wait for it to finish.');
      return;
    }
    converting = true;
    convertStartedAt = Date.now();
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const folder = body.folder;
      if (!folder || typeof folder !== 'string') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing JSON field "folder"');
        return;
      }
      console.log('Convert start:', folder);
      const logs = [];
      const pdfBuf = await convertFolder(
        folder,
        {
          pageSize: body.pageSize || 'a4p',
          dpi: body.dpi || 150,
          jpegQuality: body.jpegQuality || 85
        },
        (msg) => {
          console.log(' ', msg);
          logs.push(msg);
        }
      );
      console.log('Convert done:', pdfBuf.length, 'bytes');

      const outName = body.outputName && String(body.outputName).trim()
        ? String(body.outputName).trim().replace(/[<>:"|?*]/g, '_')
        : 'combined.pdf';
      const outPath = path.isAbsolute(outName)
        ? outName
        : path.join(path.resolve(folder), outName.endsWith('.pdf') ? outName : outName + '.pdf');
      await fsp.writeFile(outPath, pdfBuf);
      console.log('Wrote:', outPath);

      const payload = JSON.stringify({
        ok: true,
        bytes: pdfBuf.length,
        path: outPath,
        log: logs.slice(-30)
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    } catch (err) {
      console.error('Convert error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Convert error: ' + err.message);
      }
    } finally {
      converting = false;
      convertStartedAt = 0;
      console.log('Ready for next job.');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('SVG Book Toolkit server\nGET /health  GET /proxy?url=  POST /convert  GET /open?path=');
});

server.listen(port, () => {
  console.log('SVG Book Toolkit server  http://localhost:' + port);
  console.log('  GET  /health');
  console.log('  GET  /proxy?url=   (cookie/CORS proxy)');
  console.log('  POST /convert      (folder → PDF, writes file on disk)');
  console.log('  GET  /open?path=   (open saved PDF)');
  console.log('Leave this running while you use the HTML tool. Ctrl+C to stop.');
});

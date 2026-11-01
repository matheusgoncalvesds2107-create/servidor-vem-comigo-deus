import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export function createPopGospelAddon({ root }) {
  const dataDir = process.env.POP_GOSPEL_DATA_DIR || path.join(root, 'pop-gospel-data');
  const audioDir = path.join(dataDir, 'audio');
  const dbFile = path.join(dataDir, 'radio.json');
  const siteDir = path.join(root, 'pop-gospel-site');
  const panelToken = String(process.env.POP_GOSPEL_PANEL_TOKEN || '');
  const radioName = 'Radio Pop Gospel';
  const partnerName = 'Web Rádio Vem Comigo Deus';
  fs.mkdirSync(audioDir, { recursive: true });

  let sourceSocket = null;
  let sourceConnected = false;
  let sourceSince = null;
  let radioEnabled = true;
  let fallbackIndex = 0;
  let fallbackTrack = null;
  let fallbackVersion = 0;
  const listeners = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  function readDB() {
    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
    if (!Array.isArray(db.tracks)) db.tracks = [];
    if (!Array.isArray(db.playlists)) db.playlists = [];
    if (!Object.prototype.hasOwnProperty.call(db, 'selectedPlaylistId')) db.selectedPlaylistId = null;
    if (!db.settings || typeof db.settings !== 'object') db.settings = {};
    if (typeof db.settings.tagline !== 'string') db.settings.tagline = 'Louvor que toca o coração';
    const ids = new Set(db.tracks.map(t => t && t.id).filter(Boolean));
    db.playlists = db.playlists.filter(p => p && typeof p.id === 'string').map(p => ({
      ...p,
      name: String(p.name || 'Playlist'),
      trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter(id => ids.has(id)) : []
    }));
    if (db.selectedPlaylistId && !db.playlists.some(p => p.id === db.selectedPlaylistId)) db.selectedPlaylistId = null;
    return db;
  }

  function writeDB(db) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbFile);
  }

  function safeTrack(t) {
    return { id: t.id, title: t.title, artist: t.artist || '', size: t.size, createdAt: t.createdAt };
  }

  function equalSecret(a, b) {
    const aa = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  }

  function isPanel(req) {
    return !!panelToken && equalSecret(req.headers['x-pop-gospel-token'], panelToken);
  }

  function headers(res, type = 'application/json; charset=utf-8') {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pop-gospel-token, Range');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  function json(res, code, value) {
    headers(res);
    res.statusCode = code;
    res.end(JSON.stringify(value));
  }

  function unauthorized(res) {
    json(res, 401, { error: 'Token do painel inválido ou ausente.' });
  }

  function readBody(req, max = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > max) {
          reject(new Error('Arquivo ou requisição acima do limite permitido.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function parseMultipart(buffer, contentType) {
    const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) throw new Error('Formulário de upload inválido.');
    const boundary = Buffer.from('--' + (match[1] || match[2]));
    const fields = {};
    let file = null;
    let pos = 0;
    while (pos < buffer.length) {
      const start = buffer.indexOf(boundary, pos);
      if (start < 0) break;
      let partStart = start + boundary.length;
      if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
      if (buffer.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
      const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
      if (headerEnd < 0) break;
      const headerText = buffer.subarray(partStart, headerEnd).toString('utf8');
      const next = buffer.indexOf(boundary, headerEnd + 4);
      if (next < 0) break;
      let dataEnd = next;
      if (buffer.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
      const data = buffer.subarray(headerEnd + 4, dataEnd);
      const disp = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disp.match(/name="([^"]+)"/i)?.[1];
      const filename = disp.match(/filename="([^"]*)"/i)?.[1];
      if (name && filename !== undefined && filename !== '') {
        const mime = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream';
        file = { field: name, filename, mime, buffer: data };
      } else if (name) {
        fields[name] = data.toString('utf8');
      }
      pos = next;
    }
    return { fields, file };
  }

  function broadcast(chunk) {
    if (!radioEnabled || !chunk?.length) return;
    for (const res of [...listeners]) {
      try { if (!res.destroyed) res.write(chunk); else listeners.delete(res); }
      catch { listeners.delete(res); try { res.end(); } catch {} }
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function playFallbackFile(track) {
    const filename = path.basename(track.filename || '');
    const full = path.join(audioDir, filename);
    if (!fs.existsSync(full)) return;
    fallbackTrack = track.title || filename;
    const version = fallbackVersion;
    return new Promise(resolve => {
      const stream = fs.createReadStream(full, { highWaterMark: 32768 });
      let buffer = Buffer.alloc(0);
      let ended = false;
      let done = false;
      stream.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); stream.pause(); });
      stream.on('end', () => { ended = true; });
      stream.on('error', () => { ended = true; });
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        stream.destroy();
        resolve();
      };
      const timer = setInterval(() => {
        if (version !== fallbackVersion || !radioEnabled || sourceConnected) return finish();
        if (buffer.length) {
          const amount = Math.min(2500, buffer.length);
          broadcast(buffer.subarray(0, amount));
          buffer = buffer.subarray(amount);
        }
        if (!ended && buffer.length < 7500) stream.resume();
        if (ended && buffer.length === 0) finish();
      }, 250);
    });
  }

  async function fallbackLoop() {
    while (true) {
      const db = readDB();
      const playlist = db.playlists.find(p => p.id === db.selectedPlaylistId);
      const ids = playlist?.trackIds?.length ? playlist.trackIds : db.tracks.map(t => t.id);
      const tracks = ids.map(id => db.tracks.find(t => t.id === id)).filter(Boolean);
      if (!radioEnabled || sourceConnected || !tracks.length) {
        if (!radioEnabled || !tracks.length) fallbackTrack = null;
        await sleep(1000);
        continue;
      }
      if (fallbackIndex >= tracks.length) fallbackIndex = 0;
      const track = tracks[fallbackIndex];
      await playFallbackFile(track);
      if (radioEnabled && !sourceConnected && tracks.length) fallbackIndex = (fallbackIndex + 1) % tracks.length;
    }
  }

  function sendAudioFile(req, res, track) {
    const full = path.join(audioDir, path.basename(track.filename || ''));
    if (!fs.existsSync(full)) return json(res, 404, { error: 'Arquivo não encontrado.' });
    const stat = fs.statSync(full);
    const range = req.headers.range;
    headers(res, 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size);
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
        if (start <= end && start < stat.size) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('Content-Length', end - start + 1);
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(full, { start, end }).pipe(res);
        }
      }
    }
    res.statusCode = 200;
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  async function handleRequest(req, res, route) {
    if (route === '/pop-gospel' || route === '/pop-gospel/') {
      headers(res, 'text/html; charset=utf-8');
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      if (req.method === 'HEAD') return res.end();
      return res.end(fs.readFileSync(path.join(siteDir, 'index.html')));
    }
    if (route === '/pop-gospel/app.js' || route === '/pop-gospel/style.css') {
      const name = route.endsWith('app.js') ? 'app.js' : 'style.css';
      try {
        headers(res, name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        return res.end(fs.readFileSync(path.join(siteDir, name)));
      } catch { return json(res, 404, { error: 'Arquivo do site não encontrado.' }); }
    }
    if (!route.startsWith('/pop-gospel/')) return false;

    if (req.method === 'OPTIONS') { headers(res); res.statusCode = 204; return res.end(); }
    if (route === '/pop-gospel/radio.mp3' || route === '/pop-gospel/radio') {
      headers(res, 'audio/mpeg');
      res.setHeader('icy-name', radioName);
      res.setHeader('icy-genre', 'Gospel Pop');
      if (req.method === 'HEAD') return res.end();
      if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }
      listeners.add(res);
      const removeListener = () => listeners.delete(res);
      res.on('close', removeListener);
      res.on('error', removeListener);
      return;
    }
    if (route === '/pop-gospel/api/health') {
      return json(res, 200, { ok: true, service: 'radio-pop-gospel', centralPanel: !!panelToken, sourceConnected, listeners: listeners.size, onAir: radioEnabled && (sourceConnected || !!fallbackTrack), storage: 'persistent' });
    }
    if (route === '/pop-gospel/api/status') {
      return json(res, 200, { ok: true, radioEnabled, sourceConnected, sourceSince, listeners: listeners.size, currentTrack: sourceConnected ? 'Painel PC • AO VIVO' : fallbackTrack, onAir: radioEnabled && (sourceConnected || !!fallbackTrack) });
    }
    if (route === '/pop-gospel/api/control' && req.method === 'POST') {
      if (!isPanel(req)) return unauthorized(res);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body.action === 'start') {
        radioEnabled = true;
      } else if (body.action === 'stop') {
        radioEnabled = false;
        fallbackTrack = null;
        fallbackVersion++;
        if (sourceSocket) { try { sourceSocket.close(4002, 'Radio Pop Gospel desligada pelo painel'); } catch {} }
      } else if (body.action === 'next') {
        fallbackIndex++;
        fallbackVersion++;
      } else {
        return json(res, 400, { error: 'Ação inválida.' });
      }
      return json(res, 200, { ok: true, radioEnabled });
    }
    if (route === '/pop-gospel/api/public' && req.method === 'GET') {
      const db = readDB();
      return json(res, 200, {
        name: radioName, partner: partnerName, tagline: db.settings.tagline,
        live: radioEnabled && (sourceConnected || !!fallbackTrack),
        tracks: db.tracks.map(safeTrack),
        playlists: db.playlists.map(p => ({ id: p.id, name: p.name, trackIds: p.trackIds })),
        selectedPlaylistId: db.selectedPlaylistId
      });
    }
    const audioMatch = route.match(/^\/pop-gospel\/api\/audio\/([a-zA-Z0-9-]+)$/);
    if (audioMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const track = readDB().tracks.find(t => t.id === audioMatch[1]);
      if (!track) return json(res, 404, { error: 'Áudio não encontrado.' });
      return sendAudioFile(req, res, track);
    }

    if (route === '/pop-gospel/api/upload' && req.method === 'POST') {
      if (!isPanel(req)) return unauthorized(res);
      try {
        const body = await readBody(req, 42 * 1024 * 1024);
        const { fields, file } = parseMultipart(body, req.headers['content-type']);
        if (!file || file.field !== 'audio' || !/\.mp3$/i.test(file.filename) || !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(file.mime)) {
          return json(res, 400, { error: 'Envie um arquivo MP3 válido.' });
        }
        const filename = crypto.randomUUID() + '.mp3';
        fs.writeFileSync(path.join(audioDir, filename), file.buffer);
        const db = readDB();
        const track = {
          id: crypto.randomUUID(),
          title: String(fields.title || path.parse(file.filename).name).trim().slice(0, 120) || 'Faixa sem título',
          artist: String(fields.artist || '').trim().slice(0, 120),
          filename, size: file.buffer.length, createdAt: new Date().toISOString()
        };
        db.tracks.push(track); writeDB(db);
        return json(res, 200, { ok: true, track: safeTrack(track) });
      } catch (e) { return json(res, 400, { error: e.message || 'Falha no upload.' }); }
    }

    const trackDelete = route.match(/^\/pop-gospel\/api\/tracks\/([a-zA-Z0-9-]+)$/);
    if (trackDelete && req.method === 'DELETE') {
      if (!isPanel(req)) return unauthorized(res);
      const db = readDB();
      const idx = db.tracks.findIndex(t => t.id === trackDelete[1]);
      if (idx < 0) return json(res, 404, { error: 'Faixa não encontrada.' });
      const [track] = db.tracks.splice(idx, 1);
      try { fs.unlinkSync(path.join(audioDir, path.basename(track.filename))); } catch {}
      db.playlists.forEach(p => { p.trackIds = p.trackIds.filter(id => id !== track.id); });
      writeDB(db); return json(res, 200, { ok: true });
    }

    if (route === '/pop-gospel/api/playlists' && req.method === 'POST') {
      if (!isPanel(req)) return unauthorized(res);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return json(res, 400, { error: 'Informe o nome da playlist.' });
      const db = readDB();
      const playlist = { id: crypto.randomUUID(), name, trackIds: [] };
      db.playlists.push(playlist); if (!db.selectedPlaylistId) db.selectedPlaylistId = playlist.id;
      writeDB(db); return json(res, 200, { ok: true, playlist });
    }

    const playlistMatch = route.match(/^\/pop-gospel\/api\/playlists\/([a-zA-Z0-9-]+)$/);
    if (playlistMatch && req.method === 'PUT') {
      if (!isPanel(req)) return unauthorized(res);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const db = readDB(); const playlist = db.playlists.find(p => p.id === playlistMatch[1]);
      if (!playlist) return json(res, 404, { error: 'Playlist não encontrada.' });
      if (typeof body.name === 'string') playlist.name = body.name.trim().slice(0, 80) || playlist.name;
      if (Array.isArray(body.trackIds)) {
        const allowed = new Set(db.tracks.map(t => t.id));
        playlist.trackIds = [...new Set(body.trackIds.filter(id => allowed.has(id)))];
      }
      writeDB(db); return json(res, 200, { ok: true, playlist });
    }
    if (playlistMatch && req.method === 'DELETE') {
      if (!isPanel(req)) return unauthorized(res);
      const db = readDB(); db.playlists = db.playlists.filter(p => p.id !== playlistMatch[1]);
      if (db.selectedPlaylistId === playlistMatch[1]) db.selectedPlaylistId = db.playlists[0]?.id || null;
      writeDB(db); return json(res, 200, { ok: true });
    }
    const selectMatch = route.match(/^\/pop-gospel\/api\/playlists\/([a-zA-Z0-9-]+)\/select$/);
    if (selectMatch && req.method === 'POST') {
      if (!isPanel(req)) return unauthorized(res);
      const db = readDB();
      if (!db.playlists.some(p => p.id === selectMatch[1])) return json(res, 404, { error: 'Playlist não encontrada.' });
      db.selectedPlaylistId = selectMatch[1]; fallbackIndex = 0; fallbackVersion++;
      writeDB(db); return json(res, 200, { ok: true });
    }
    if (route === '/pop-gospel/api/settings' && req.method === 'PUT') {
      if (!isPanel(req)) return unauthorized(res);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const db = readDB();
      if (typeof body.tagline === 'string') db.settings.tagline = body.tagline.trim().slice(0, 160);
      writeDB(db); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Rota Pop Gospel não encontrada.' });
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/pop-gospel/source-ws') return false;
    const token = url.searchParams.get('token') || '';
    if (!panelToken || !equalSecret(token, panelToken)) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    return true;
  }

  wss.on('connection', ws => {
    if (!radioEnabled) { ws.close(4002, 'Radio Pop Gospel desligada'); return; }
    if (sourceSocket && sourceSocket !== ws) { try { sourceSocket.close(4000, 'Novo source Pop Gospel conectado'); } catch {} }
    sourceSocket = ws; sourceConnected = true; sourceSince = new Date().toISOString();
    fallbackVersion++;
    ws.on('message', data => {
      if (sourceSocket !== ws || !radioEnabled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      broadcast(chunk);
    });
    const close = () => {
      if (sourceSocket === ws) { sourceSocket = null; sourceConnected = false; sourceSince = null; }
    };
    ws.on('close', close); ws.on('error', close);
  });

  function start() { fallbackLoop().catch(err => console.error('[Pop Gospel fallback]', err)); }
  return { handleRequest, handleUpgrade, start };
}

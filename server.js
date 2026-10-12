import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "audio");
const PORT = Number(process.env.PORT || 10000);

let listeners = new Set();
let files = [];
let currentIndex = 0;
let currentTrack = null;
let fallbackRunning = false;

let sourceSocket = null;
let sourceConnected = false;
let sourceSince = null;

function refreshFiles() {
  try {
    files = fs.readdirSync(AUDIO_DIR)
      .filter(f => /\.(mp3|aac|m4a)$/i.test(f))
      .sort();
  } catch {
    files = [];
  }
}
refreshFiles();

function broadcast(chunk) {
  for (const res of [...listeners]) {
    try {
      res.write(chunk);
    } catch {
      listeners.delete(res);
      try { res.end(); } catch {}
    }
  }
}

async function playFallbackFile(file) {
  return new Promise(resolve => {
    currentTrack = file;

    const stream = fs.createReadStream(path.join(AUDIO_DIR, file), {
      highWaterMark: 32 * 1024
    });

    const bytesPerSecond = 24000; // ~192kbps
    const tickMs = 250;
    const target = Math.floor(bytesPerSecond * tickMs / 1000);

    let buffer = Buffer.alloc(0);
    let ended = false;

    stream.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      stream.pause();
    });

    stream.on("end", () => { ended = true; });
    stream.on("error", () => { ended = true; });

    const timer = setInterval(() => {
      if (buffer.length > 0) {
        const amount = Math.min(target, buffer.length);
        const piece = buffer.subarray(0, amount);
        buffer = buffer.subarray(amount);

        if (!sourceConnected) {
          broadcast(piece);
        }
      }

      if (!ended && buffer.length < target * 2) {
        stream.resume();
      }

      if (ended && buffer.length === 0) {
        clearInterval(timer);
        resolve();
      }
    }, tickMs);
  });
}

async function fallbackLoop() {
  if (fallbackRunning) return;
  fallbackRunning = true;

  while (true) {
    refreshFiles();

    if (!files.length) {
      if (!sourceConnected) currentTrack = null;
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (currentIndex >= files.length) currentIndex = 0;

    await playFallbackFile(files[currentIndex]);
    currentIndex = (currentIndex + 1) % files.length;
  }
}
fallbackLoop();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(u.pathname);

  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    return res.end(JSON.stringify({
      ok: true,
      service: "Servidor Próprio Vem Comigo Deus v3 WebSocket",
      listeners: listeners.size,
      onAir: sourceConnected || files.length > 0,
      sourceConnected,
      sourceSince,
      sourceTransport: "websocket",
      currentTrack: sourceConnected ? "Painel Web Rádio • AO VIVO" : currentTrack,
      files: files.length,
      routes: ["/", "/health", "/status", "/radio", "/radio.mp3", "wss://.../source-ws"]
    }));
  }

  if (pathname === "/status") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    return res.end(JSON.stringify({
      onAir: sourceConnected || files.length > 0,
      sourceConnected,
      sourceTransport: "websocket",
      listeners: listeners.size,
      currentTrack: sourceConnected ? "Painel Web Rádio • AO VIVO" : currentTrack,
      playlist: files
    }));
  }

  if (
    pathname === "/radio" ||
    pathname === "/radio.mp3" ||
    pathname.startsWith("/radio.")
  ) {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "icy-name": "Web Rádio Vem Comigo Deus",
      "icy-genre": "Gospel",
      "icy-description": "Louvor, Palavra e Fé 24 horas"
    });

    if (req.method === "HEAD") return res.end();

    listeners.add(res);

    req.on("close", () => {
      listeners.delete(res);
      try { res.end(); } catch {}
    });

    return;
  }

  if (pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    return res.end(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Rádio Vem Comigo Deus</title>
<style>
body{font-family:Arial;background:#071a33;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}
.card{width:min(92vw,440px);background:#0e2a4e;border:1px solid #F9B80055;border-radius:20px;padding:24px;text-align:center}
h1{color:#F9B800}audio{width:100%;margin:16px 0}a{color:#FFD600}
</style>
</head>
<body>
<div class="card">
<h1>Web Rádio Vem Comigo Deus</h1>
<p>Servidor próprio Render v3 • WebSocket</p>
<audio controls preload="none" src="/radio.mp3"></audio>
<p><a href="/health">Ver status</a></p>
</div>
</body>
</html>`);
  }

  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify({
    ok: false,
    error: "Rota não encontrada",
    path: pathname
  }));
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (u.pathname !== "/source-ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", ws => {
  if (sourceSocket && sourceSocket !== ws) {
    try { sourceSocket.close(4000, "Novo source conectado"); } catch {}
  }

  sourceSocket = ws;
  sourceConnected = true;
  sourceSince = new Date().toISOString();
  currentTrack = "Painel Web Rádio • AO VIVO";

  console.log("SOURCE WebSocket conectado.");

  ws.on("message", (data, isBinary) => {
    if (!sourceConnected || ws !== sourceSocket) return;

    const chunk = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);

    if (chunk.length) {
      broadcast(chunk);
    }
  });

  const close = () => {
    if (sourceSocket === ws) {
      sourceSocket = null;
      sourceConnected = false;
      sourceSince = null;
      console.log("SOURCE WebSocket desconectado; fallback retomado.");
    }
  };

  ws.on("close", close);
  ws.on("error", close);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor Vem Comigo Deus v3 WS ativo na porta ${PORT}`);
  console.log(`Fallback: ${files.length} arquivo(s)`);
});

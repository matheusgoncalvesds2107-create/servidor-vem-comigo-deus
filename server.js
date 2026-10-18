
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(ROOT, "audio");
const PANEL_FILE = path.join(ROOT, "painel-v4.html");

const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const adminToken = crypto.randomBytes(32).toString("hex");

let files = [];
let currentIndex = 0;
let currentTrack = null;
let radioEnabled = true;
let skipVersion = 0;

let sourceSocket = null;
let sourceConnected = false;
let sourceSince = null;

const listeners = new Set();

function refreshFiles() {
  try {
    files = fs.readdirSync(AUDIO_DIR)
      .filter(f => /\.(mp3|aac|m4a)$/i.test(f))
      .sort();
  } catch {
    files = [];
  }
  return files;
}

refreshFiles();

function isAdmin(req) {
  return (req.headers.cookie || "")
    .split(";")
    .map(s => s.trim())
    .includes("vcadmin=" + adminToken);
}

function send(res, code, content, type = "application/json") {
  res.writeHead(code, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(typeof content === "string" ? content : JSON.stringify(content));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1000000) {
        tooLarge = true;
        reject(new Error("Requisição muito grande"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!tooLarge) resolve(body);
    });
    req.on("error", reject);
  });
}

function statusObject() {
  refreshFiles();

  return {
    ok: true,
    service: "Web Rádio Vem Comigo Deus 4.0",
    radioEnabled,
    onAir: radioEnabled && (sourceConnected || files.length > 0),
    listeners: listeners.size,
    sourceConnected,
    sourceSince,
    currentTrack: sourceConnected
      ? "Painel do PC • AO VIVO"
      : currentTrack,
    files: files.length,
    playlist: files
  };
}

function broadcast(chunk) {
  if (!radioEnabled) return;

  for (const res of [...listeners]) {
    try {
      res.write(chunk);
    } catch {
      listeners.delete(res);
      try { res.end(); } catch {}
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function playFallbackFile(file) {
  return new Promise(resolve => {
    currentTrack = file;

    const version = skipVersion;
    const stream = fs.createReadStream(path.join(AUDIO_DIR, file), {
      highWaterMark: 32768
    });

    let buffer = Buffer.alloc(0);
    let ended = false;
    let finished = false;

    stream.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      stream.pause();
    });

    stream.on("end", () => { ended = true; });
    stream.on("error", () => { ended = true; });

    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      stream.destroy();
      resolve();
    }

    const timer = setInterval(() => {
      if (version !== skipVersion || !radioEnabled) {
        return finish();
      }

      if (sourceConnected) return;

      if (buffer.length) {
        const amount = Math.min(6000, buffer.length);
        const piece = buffer.subarray(0, amount);
        buffer = buffer.subarray(amount);
        broadcast(piece);
      }

      if (!ended && buffer.length < 12000) {
        stream.resume();
      }

      if (ended && buffer.length === 0) finish();
    }, 250);
  });
}

async function fallbackLoop() {
  while (true) {
    refreshFiles();

    if (!radioEnabled || sourceConnected || !files.length) {
      if (!radioEnabled) currentTrack = null;
      await sleep(1000);
      continue;
    }

    if (currentIndex >= files.length) currentIndex = 0;

    const file = files[currentIndex];
    await playFallbackFile(file);

    if (radioEnabled && !sourceConnected && files.length) {
      currentIndex = (currentIndex + 1) % files.length;
    }
  }
}

function loginPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login • Vem Comigo Deus</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#061426;color:white;font-family:Arial;padding:15px}
.card{width:min(100%,410px);background:#102e52;padding:24px;
border:1px solid #f9b80055;border-radius:22px}
h1{color:#f9b800;font-size:25px}
input,button{width:100%;padding:15px;border-radius:12px;margin-top:14px;font-size:16px}
input{background:#071a33;color:white;border:1px solid #ffffff30}
button{background:#f9b800;color:#071a33;border:0;font-weight:bold}
p{color:#bbcadb}
</style>
</head>
<body>
<form class="card" method="POST" action="/admin/login">
<h1>📻 Vem Comigo Deus</h1>
<p>Administração da rádio</p>
<input type="password" name="password" placeholder="Senha do painel" required>
<button type="submit">Entrar</button>
</form>
</body>
</html>`;
}

function oldPanel() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel da Rádio</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(#0a2342,#04101f);
color:white;font-family:Arial;min-height:100vh;padding:16px}
main{max-width:500px;margin:auto}
h1{color:#f9b800}
.card{background:#102e52;padding:20px;border-radius:20px;margin:14px 0}
.track{color:#f9b800;font-size:22px;font-weight:bold;overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button,a{padding:14px;border:0;border-radius:12px;font-weight:bold;
background:#f9b800;color:#071a33;text-decoration:none;text-align:center}
button{cursor:pointer}
small{color:#b6c9da}
.item{padding:12px 0;border-top:1px solid #ffffff22}
</style>
</head>
<body>
<main>
<h1>Web Rádio Vem Comigo Deus</h1>
<p>Controle da rádio pelo celular</p>
<div class="card">
<small>AGORA NA RÁDIO</small>
<p class="track" id="track">Carregando...</p>
<div class="grid">
<div>Ouvintes: <b id="listeners">0</b></div>
<div>Arquivos: <b id="files">0</b></div>
</div>
<p id="state"></p>
</div>
<div class="card">
<div class="grid">
<button onclick="action('start')">▶ Ligar rádio</button>
<button onclick="action('stop')">■ Parar rádio</button>
<button onclick="action('next')">⏭ Próxima faixa</button>
<button onclick="refresh()">↻ Atualizar</button>
</div>
</div>
<div class="card">
<h3>Playlist no servidor</h3>
<div id="playlist"></div>
</div>
<div class="card">
<a style="display:block" href="/admin/v4">Abrir painel 4.0</a>
</div>
</main>
<script>
async function refresh(){
try{
const r=await fetch('/admin/status',{cache:'no-store'});
if(r.status===401){location.href='/admin';return}
const d=await r.json();
document.getElementById('track').textContent=d.currentTrack||'Nenhuma faixa';
document.getElementById('listeners').textContent=d.listeners;
document.getElementById('files').textContent=d.files;
document.getElementById('state').textContent=d.radioEnabled?'● LIGADA':'● DESLIGADA';
const list=document.getElementById('playlist');
list.replaceChildren();
(d.playlist||[]).forEach((name,i)=>{
const div=document.createElement('div');
div.className='item';
div.textContent=(i+1)+'. '+name;
list.appendChild(div);
});
}catch(e){console.error(e)}
}
async function action(name){
if(name==='stop'&&!confirm('Parar a rádio?'))return;
const r=await fetch('/admin/action',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({action:name})
});
if(!r.ok)alert('Erro ao executar comando');
refresh();
}
refresh();
setInterval(refresh,10000);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/health" || route === "/status") {
      return send(res, 200, statusObject());
    }

    if (route === "/admin/login" && req.method === "POST") {
      const body = await readBody(req);
      const password = new URLSearchParams(body).get("password") || "";

      if (!ADMIN_PASSWORD) {
        return send(res, 500, "Configure ADMIN_PASSWORD no Render.", "text/plain");
      }

      const a = Buffer.from(password);
      const b = Buffer.from(ADMIN_PASSWORD);

      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return send(res, 401, "Senha incorreta. Volte e tente novamente.", "text/plain");
      }

      res.writeHead(302, {
        Location: "/admin",
        "Set-Cookie": "vcadmin=" + adminToken +
          "; Path=/; HttpOnly; Secure; SameSite=Lax"
      });
      return res.end();
    }

    if (route === "/admin" && req.method === "GET") {
      return send(res, 200, isAdmin(req) ? oldPanel() : loginPage(), "text/html");
    }

    if (route === "/admin/v4" && req.method === "GET") {
      if (!isAdmin(req)) {
        res.writeHead(302, { Location: "/admin" });
        return res.end();
      }

      try {
        const html = fs.readFileSync(PANEL_FILE, "utf8");
        return send(res, 200, html, "text/html");
      } catch {
        return send(res, 404,
          "Arquivo painel-v4.html não encontrado no GitHub.",
          "text/plain");
      }
    }

    if (route === "/admin/status" && req.method === "GET") {
      if (!isAdmin(req)) {
        return send(res, 401, { ok: false, error: "Não autorizado" });
      }
      return send(res, 200, statusObject());
    }

    if (route === "/admin/action" && req.method === "POST") {
      if (!isAdmin(req)) {
        return send(res, 401, { ok: false, error: "Não autorizado" });
      }

      const raw = await readBody(req);
      const data = JSON.parse(raw || "{}");

      if (data.action === "start") {
        radioEnabled = true;
      } else if (data.action === "stop") {
        radioEnabled = false;
        currentTrack = null;
        skipVersion++;

        if (sourceSocket) {
          try { sourceSocket.close(4001, "Rádio desligada"); } catch {}
        }
      } else if (data.action === "next") {
        refreshFiles();
        radioEnabled = true;
        currentIndex = files.length
          ? (currentIndex + 1) % files.length
          : 0;
        skipVersion++;
      } else {
        return send(res, 400, { ok: false, error: "Ação inválida" });
      }

      return send(res, 200, statusObject());
    }

    if (route === "/radio" || route === "/radio.mp3") {
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "icy-name": "Web Rádio Vem Comigo Deus",
        "icy-genre": "Gospel"
      });

      if (req.method === "HEAD") return res.end();

      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (route === "/" && req.method === "GET") {
      return send(res, 200, `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Rádio Vem Comigo Deus</title>
<style>
body{background:#071a33;color:white;font-family:Arial;text-align:center;padding:40px 15px}
h1{color:#f9b800}
audio{width:min(100%,450px)}
a{color:#f9b800}
</style>
</head>
<body>
<h1>📻 Web Rádio Vem Comigo Deus</h1>
<p>Rádio gospel</p>
<audio controls src="/radio.mp3"></audio>
<p><a href="/admin">Painel móvel</a></p>
</body>
</html>`, "text/html");
    }

    return send(res, 404, { ok: false, error: "Rota não encontrada" });

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return send(res, 500, { ok: false, error: "Erro interno" });
    }
    res.end();
  }
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname !== "/source-ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", ws => {
  if (!radioEnabled) {
    ws.close(4002, "Rádio desligada");
    return;
  }

  if (sourceSocket && sourceSocket !== ws) {
    try { sourceSocket.close(4000, "Novo source conectado"); } catch {}
  }

  sourceSocket = ws;
  sourceConnected = true;
  sourceSince = new Date().toISOString();
  currentTrack = "Painel do PC • AO VIVO";

  ws.on("message", data => {
    if (!radioEnabled || sourceSocket !== ws) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length) broadcast(chunk);
  });

  const close = () => {
    if (sourceSocket === ws) {
      sourceSocket = null;
      sourceConnected = false;
      sourceSince = null;
      currentTrack = null;
    }
  };

  ws.on("close", close);
  ws.on("error", close);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Web Rádio Vem Comigo Deus 4.0 na porta " + PORT);
});

fallbackLoop().catch(console.error);

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "audio");
const PORT = Number(process.env.PORT || 10000);

let clients = new Set();
let files = [];
let currentIndex = 0;
let currentTrack = null;
let running = false;

function refreshFiles() {
  try {
    files = fs
      .readdirSync(AUDIO_DIR)
      .filter((f) => /\.(mp3|aac|m4a)$/i.test(f))
      .sort();
  } catch {
    files = [];
  }
}

refreshFiles();

function sendChunk(chunk) {
  for (const res of [...clients]) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);

      try {
        res.end();
      } catch {}
    }
  }
}

async function playFile(file) {
  return new Promise((resolve) => {
    currentTrack = file;

    const stream = fs.createReadStream(
      path.join(AUDIO_DIR, file),
      {
        highWaterMark: 32 * 1024
      }
    );

    // Aproximadamente 192 kbps
    const bytesPerSecond = 24000;
    const tickMs = 250;

    const targetPerTick = Math.floor(
      bytesPerSecond * (tickMs / 1000)
    );

    let buffer = Buffer.alloc(0);
    let ended = false;

    stream.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        chunk
      ]);

      stream.pause();
    });

    stream.on("end", () => {
      ended = true;
    });

    stream.on("error", (err) => {
      console.error(
        "Erro ao ler áudio:",
        err.message
      );

      ended = true;
    });

    const timer = setInterval(() => {
      if (buffer.length > 0) {
        const amount = Math.min(
          targetPerTick,
          buffer.length
        );

        const piece = buffer.subarray(
          0,
          amount
        );

        buffer = buffer.subarray(amount);

        sendChunk(piece);
      }

      if (
        !ended &&
        buffer.length <
          targetPerTick * 2
      ) {
        stream.resume();
      }

      if (
        ended &&
        buffer.length === 0
      ) {
        clearInterval(timer);

        resolve();
      }
    }, tickMs);
  });
}

async function broadcastLoop() {
  if (running) {
    return;
  }

  running = true;

  while (true) {
    refreshFiles();

    if (!files.length) {
      currentTrack = null;

      await new Promise((r) =>
        setTimeout(r, 3000)
      );

      continue;
    }

    if (
      currentIndex >= files.length
    ) {
      currentIndex = 0;
    }

    const file =
      files[currentIndex];

    await playFile(file);

    currentIndex =
      (currentIndex + 1) %
      files.length;
  }
}

broadcastLoop();

const server = http.createServer(
  (req, res) => {
    const parsed = new URL(
      req.url || "/",
      `http://${
        req.headers.host ||
        "localhost"
      }`
    );

    let pathname =
      decodeURIComponent(
        parsed.pathname
      );

    // Remove barra final
    if (
      pathname.length > 1 &&
      pathname.endsWith("/")
    ) {
      pathname =
        pathname.slice(0, -1);
    }

    console.log(
      req.method,
      pathname
    );

    // CORS
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "*"
    );

    if (
      req.method === "OPTIONS"
    ) {
      res.writeHead(204);

      return res.end();
    }

    // HEALTH
    if (
      pathname === "/health"
    ) {
      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store"
        }
      );

      return res.end(
        JSON.stringify({
          ok: true,

          service:
            "Servidor Próprio Vem Comigo Deus",

          listeners:
            clients.size,

          currentTrack,

          files:
            files.length,

          routes: [
            "/",
            "/health",
            "/status",
            "/radio",
            "/radio.mp3"
          ]
        })
      );
    }

    // STATUS
    if (
      pathname === "/status"
    ) {
      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store"
        }
      );

      return res.end(
        JSON.stringify({
          onAir:
            files.length > 0,

          listeners:
            clients.size,

          currentTrack,

          playlist:
            files
        })
      );
    }

    // STREAM
    if (
      pathname === "/radio" ||
      pathname === "/radio.mp3" ||
      pathname.startsWith(
        "/radio."
      )
    ) {
      res.writeHead(
        200,
        {
          "Content-Type":
            "audio/mpeg",

          "Cache-Control":
            "no-store, no-cache, must-revalidate",

          "Connection":
            "keep-alive",

          "Access-Control-Allow-Origin":
            "*",

          "icy-name":
            "Web Rádio Vem Comigo Deus",

          "icy-genre":
            "Gospel",

          "icy-description":
            "Louvor, Palavra e Fé 24 horas"
        }
      );

      if (
        req.method === "HEAD"
      ) {
        return res.end();
      }

      clients.add(res);

      req.on(
        "close",
        () => {
          clients.delete(res);

          try {
            res.end();
          } catch {}
        }
      );

      return;
    }

    // PÁGINA PRINCIPAL
    if (
      pathname === "/"
    ) {
      res.writeHead(
        200,
        {
          "Content-Type":
            "text/html; charset=utf-8",

          "Cache-Control":
            "no-store"
        }
      );

      return res.end(`
<!doctype html>

<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Servidor Vem Comigo Deus
</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #071a33;
  color: #fff;
  display: grid;
  place-items: center;
  min-height: 100vh;
  margin: 0;
}

.card {
  width: min(92vw, 430px);
  background: #0e2a4e;
  border: 1px solid #F9B80055;
  border-radius: 20px;
  padding: 24px;
  text-align: center;
}

h1 {
  color: #F9B800;
}

audio {
  width: 100%;
  margin: 16px 0;
}

a {
  color: #FFD600;
}

</style>

</head>

<body>

<div class="card">

<h1>
Web Rádio Vem Comigo Deus
</h1>

<p>
Servidor próprio de teste no Render
</p>

<audio
controls
preload="none"
src="/radio.mp3">
</audio>

<p>

<a href="/health">
Ver status
</a>

</p>

</div>

</body>

</html>
`);
    }

    // 404
    res.writeHead(
      404,
      {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    );

    return res.end(
      JSON.stringify({
        ok: false,

        error:
          "Rota não encontrada",

        path:
          pathname,

        routes: [
          "/",
          "/health",
          "/status",
          "/radio",
          "/radio.mp3"
        ]
      })
    );
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Servidor Vem Comigo Deus ativo na porta ${PORT}`
    );

    console.log(
      `Arquivos encontrados: ${files.length}`
    );
  }
);

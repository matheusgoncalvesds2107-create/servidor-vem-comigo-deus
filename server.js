import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "audio");
const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

const adminToken = crypto.randomBytes(32).toString("hex");

let listeners = new Set();
let files = [];
let currentIndex = 0;
let currentTrack = null;
let radioEnabled = true;
let skipVersion = 0;

let sourceSocket = null;
let sourceConnected = false;
let sourceSince = null;

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

function isAdmin(req) {
  const cookie = req.headers.cookie || "";

  return cookie
    .split(";")
    .map((x) => x.trim())
    .includes(`vcadmin=${adminToken}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1000000) {
        reject(
          new Error("Payload muito grande")
        );

        req.destroy();
      }
    });

    req.on("end", () =>
      resolve(body)
    );

    req.on(
      "error",
      reject
    );
  });
}

function broadcast(chunk) {
  if (!radioEnabled) {
    return;
  }

  for (
    const res of [...listeners]
  ) {
    try {
      res.write(chunk);
    } catch {
      listeners.delete(res);

      try {
        res.end();
      } catch {}
    }
  }
}

async function playFallbackFile(file) {
  return new Promise((resolve) => {
    currentTrack = file;

    const mySkipVersion =
      skipVersion;

    const stream =
      fs.createReadStream(
        path.join(
          AUDIO_DIR,
          file
        ),
        {
          highWaterMark:
            32 * 1024
        }
      );

    const bytesPerSecond =
      24000;

    const tickMs =
      250;

    const target =
      Math.floor(
        (
          bytesPerSecond *
          tickMs
        ) / 1000
      );

    let buffer =
      Buffer.alloc(0);

    let ended =
      false;

    stream.on(
      "data",
      (chunk) => {
        buffer =
          Buffer.concat([
            buffer,
            chunk
          ]);

        stream.pause();
      }
    );

    stream.on(
      "end",
      () => {
        ended = true;
      }
    );

    stream.on(
      "error",
      () => {
        ended = true;
      }
    );

    const finish = () => {
      clearInterval(timer);

      try {
        stream.destroy();
      } catch {}

      resolve();
    };

    const timer =
      setInterval(
        () => {
          if (
            skipVersion !==
            mySkipVersion
          ) {
            return finish();
          }

          if (!radioEnabled) {
            currentTrack = null;

            return finish();
          }

          if (
            sourceConnected
          ) {
            return;
          }

          if (
            buffer.length >
            0
          ) {
            const amount =
              Math.min(
                target,
                buffer.length
              );

            const piece =
              buffer.subarray(
                0,
                amount
              );

            buffer =
              buffer.subarray(
                amount
              );

            broadcast(piece);
          }

          if (
            !ended &&
            buffer.length <
              target * 2
          ) {
            stream.resume();
          }

          if (
            ended &&
            buffer.length ===
              0
          ) {
            finish();
          }
        },
        tickMs
      );
  });
}

async function fallbackLoop() {
  while (true) {
    refreshFiles();

    if (!radioEnabled) {
      currentTrack =
        null;

      await new Promise(
        (r) =>
          setTimeout(
            r,
            1000
          )
      );

      continue;
    }

    if (
      sourceConnected
    ) {
      await new Promise(
        (r) =>
          setTimeout(
            r,
            1000
          )
      );

      continue;
    }

    if (!files.length) {
      currentTrack =
        null;

      await new Promise(
        (r) =>
          setTimeout(
            r,
            3000
          )
      );

      continue;
    }

    if (
      currentIndex >=
      files.length
    ) {
      currentIndex = 0;
    }

    const file =
      files[
        currentIndex
      ];

    await playFallbackFile(
      file
    );

    if (
      radioEnabled &&
      !sourceConnected
    ) {
      currentIndex =
        (
          currentIndex +
          1
        ) %
        files.length;
    }
  }
}

fallbackLoop();

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

function statusObject() {
  return {
    ok: true,

    service:
      "Servidor Próprio Vem Comigo Deus v4 Admin Mobile",

    radioEnabled,

    listeners:
      listeners.size,

    onAir:
      radioEnabled &&
      (
        sourceConnected ||
        files.length > 0
      ),

    sourceConnected,

    sourceSince,

    currentTrack:
      sourceConnected
        ? "Painel Web Rádio • AO VIVO"
        : currentTrack,

    files:
      files.length,

    playlist:
      files
  };
}

function adminPage(
  logged
) {
  if (!logged) {
    return `
<!doctype html>

<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Admin • Vem Comigo Deus
</title>

<style>

body {
  margin: 0;
  min-height: 100vh;

  display: grid;
  place-items: center;

  background: #061426;
  color: #fff;

  font-family: Arial;
}

.card {
  width:
    min(
      92vw,
      390px
    );

  background:
    #0e2a4e;

  border:
    1px solid
    #F9B80044;

  border-radius:
    22px;

  padding:
    22px;

  box-shadow:
    0 20px 60px
    #0006;
}

h1 {
  color:
    #F9B800;

  margin:
    0 0 8px;
}

.muted {
  color:
    #a9b7c9;

  font-size:
    12px;
}

.field {
  width:
    100%;

  box-sizing:
    border-box;

  margin:
    14px 0;

  padding:
    13px;

  border-radius:
    12px;

  border:
    1px solid
    #ffffff18;

  background:
    #071a33;

  color:
    #fff;
}

.btn {
  width:
    100%;

  padding:
    13px;

  border:
    0;

  border-radius:
    12px;

  background:
    #F9B800;

  color:
    #071a33;

  font-weight:
    900;
}

</style>

</head>

<body>

<form
class="card"
method="post"
action="/admin/login">

<h1>
Web Rádio
Vem Comigo Deus
</h1>

<div class="muted">
Painel móvel
</div>

<input
class="field"
type="password"
name="password"
placeholder="Senha do painel"
required>

<button
class="btn"
type="submit">
Entrar
</button>

</form>

</body>

</html>
`;
  }

  return `
<!doctype html>

<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1,viewport-fit=cover">

<meta
name="theme-color"
content="#071a33">

<title>
Painel Móvel • Vem Comigo Deus
</title>

<style>

:root {
  --bg:
    #061426;

  --panel:
    #0e2a4e;

  --gold:
    #F9B800;

  --muted:
    #a9b7c9;

  --green:
    #35e786;

  --red:
    #ff6262;
}

* {
  box-sizing:
    border-box;
}

body {
  margin: 0;

  background:
    linear-gradient(
      180deg,
      #0a2342,
      #04101f
    );

  color:
    #fff;

  font-family:
    Arial;

  min-height:
    100vh;

  padding:
    14px;
}

.wrap {
  max-width:
    480px;

  margin:
    auto;
}

.head {
  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  margin-bottom:
    12px;
}

.head h1 {
  margin:
    0;

  color:
    var(--gold);

  font-size:
    20px;
}

.pill {
  font-size:
    10px;

  font-weight:
    900;

  padding:
    7px 9px;

  border-radius:
    999px;

  background:
    #ffffff10;
}

.card {
  background:
    var(--panel);

  border:
    1px solid
    #ffffff12;

  border-radius:
    18px;

  padding:
    16px;

  margin-bottom:
    12px;
}

.label {
  color:
    var(--muted);

  font-size:
    10px;

  text-transform:
    uppercase;

  letter-spacing:
    .12em;
}

.value {
  font-size:
    20px;

  font-weight:
    900;

  margin-top:
    6px;
}

.track {
  color:
    var(--gold);
}

.grid {
  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    9px;
}

.btn {
  padding:
    14px 10px;

  border:
    0;

  border-radius:
    14px;

  font-weight:
    900;

  font-size:
    14px;
}

.start {
  background:
    var(--gold);

  color:
    #071a33;
}

.stop {
  background:
    #3b1520;

  color:
    #ffb5bd;

  border:
    1px solid
    #ff626244;
}

.next {
  background:
    #173a63;

  color:
    #fff;

  border:
    1px solid
    #ffffff12;
}

.refresh {
  background:
    #102944;

  color:
    #fff;

  border:
    1px solid
    #ffffff12;
}

.small {
  color:
    var(--muted);

  font-size:
    11px;

  line-height:
    1.5;
}

.playlist {
  max-height:
    260px;

  overflow:
    auto;

  margin-top:
    10px;
}

.item {
  padding:
    9px 0;

  border-top:
    1px solid
    #ffffff0f;

  font-size:
    12px;
}

</style>

</head>

<body>

<div class="wrap">

<div class="head">

<div>

<h1>
Vem Comigo Deus
</h1>

<div class="small">
Controle da rádio pelo celular
</div>

</div>

<span
id="pill"
class="pill">
...
</span>

</div>

<div class="card">

<div class="label">
Agora na Rádio
</div>

<div
id="track"
class="value track">
Carregando...
</div>

<div
id="detail"
class="small">
</div>

</div>

<div class="grid">

<div class="card">

<div class="label">
Ouvintes
</div>

<div
id="listeners"
class="value">
0
</div>

</div>

<div class="card">

<div class="label">
Arquivos
</div>

<div
id="files"
class="value">
0
</div>

</div>

</div>

<div class="card">

<div class="grid">

<button
class="btn start"
onclick="action('start')">
▶ Ligar rádio
</button>

<button
class="btn stop"
onclick="action('stop')">
■ Parar rádio
</button>

<button
class="btn next"
onclick="action('next')">
⏭ Próxima faixa
</button>

<button
class="btn refresh"
onclick="refresh()">
↻ Atualizar
</button>

</div>

</div>

<div class="card">

<div class="label">
Playlist no servidor
</div>

<div
id="playlist"
class="playlist">
</div>

</div>

</div>

<script>

async function refresh() {
  try {
    const r =
      await fetch(
        "/admin/status",
        {
          cache:
            "no-store"
        }
      );

    const d =
      await r.json();

    document
      .getElementById(
        "track"
      )
      .textContent =
        d.currentTrack ||
        "Nenhuma faixa";

    document
      .getElementById(
        "listeners"
      )
      .textContent =
        d.listeners ||
        0;

    document
      .getElementById(
        "files"
      )
      .textContent =
        d.files ||
        0;

    document
      .getElementById(
        "detail"
      )
      .textContent =
        d.sourceConnected
          ? "Painel do PC conectado"
          : "Motor na nuvem / playlist";

    const pill =
      document
        .getElementById(
          "pill"
        );

    pill.textContent =
      d.radioEnabled
        ? "● LIGADA"
        : "● DESLIGADA";

    pill.style.color =
      d.radioEnabled
        ? "#baffd3"
        : "#ffc0c0";

    document
      .getElementById(
        "playlist"
      )
      .innerHTML =
        (
          d.playlist ||
          []
        )
        .map(
          (
            x,
            i
          ) =>
            '<div class="item">' +
            (
              i + 1
            ) +
            ". " +
            x +
            "</div>"
        )
        .join("") ||
        '<div class="small">Nenhum áudio na pasta audio/.</div>';
  } catch {
    document
      .getElementById(
        "track"
      )
      .textContent =
        "Erro ao consultar servidor";
  }
}

async function action(
  name
) {
  const r =
    await fetch(
      "/admin/action",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            action:
              name
          })
      }
    );

  const d =
    await r.json();

  if (!r.ok) {
    alert(
      d.error ||
      "Erro"
    );
  }

  setTimeout(
    refresh,
    400
  );
}

refresh();

setInterval(
  refresh,
  5000
);

</script>

</body>

</html>
`;
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      const u =
        new URL(
          req.url ||
            "/",

          `http://${
            req.headers
              .host ||
            "localhost"
          }`
        );

      let pathname =
        decodeURIComponent(
          u.pathname
        );

      if (
        pathname.length >
          1 &&
        pathname.endsWith(
          "/"
        )
      ) {
        pathname =
          pathname.slice(
            0,
            -1
          );
      }

      setCors(res);

      if (
        req.method ===
        "OPTIONS"
      ) {
        res.writeHead(
          204
        );

        return res.end();
      }

      if (
        pathname ===
          "/health" ||
        pathname ===
          "/status"
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
          JSON.stringify(
            statusObject()
          )
        );
      }

      if (
        pathname ===
          "/admin" &&
        req.method ===
          "GET"
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

        return res.end(
          adminPage(
            isAdmin(req)
          )
        );
      }

      if (
        pathname ===
          "/admin/login" &&
        req.method ===
          "POST"
      ) {
        const body =
          await readBody(
            req
          );

        const params =
          new URLSearchParams(
            body
          );

        const password =
          params.get(
            "password"
          ) ||
          "";

        if (!ADMIN_PASSWORD) {
          res.writeHead(
            500,
            {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          );

          return res.end(
            "Configure ADMIN_PASSWORD no Render."
          );
        }

        if (
          password !==
          ADMIN_PASSWORD
        ) {
          res.writeHead(
            401,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          return res.end(
            "<h3>Senha incorreta.</h3><a href='/admin'>Voltar</a>"
          );
        }

        res.writeHead(
          302,
          {
            Location:
              "/admin",

            "Set-Cookie":
              `vcadmin=${adminToken}; Path=/; HttpOnly; Secure; SameSite=Lax`
          }
        );

        return res.end();
      }

      if (
        pathname ===
          "/admin/status" &&
        req.method ===
          "GET"
      ) {
        if (!isAdmin(req)) {
          res.writeHead(
            401,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              ok:
                false,

              error:
                "Não autorizado"
            })
          );
        }

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
          JSON.stringify(
            statusObject()
          )
        );
      }

      if (
        pathname ===
          "/admin/action" &&
        req.method ===
          "POST"
      ) {
        if (!isAdmin(req)) {
          res.writeHead(
            401,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              ok:
                false,

              error:
                "Não autorizado"
            })
          );
        }

        try {
          const raw =
            await readBody(
              req
            );

          const body =
            JSON.parse(
              raw ||
                "{}"
            );

          const action =
            body.action;

          if (
            action ===
            "start"
          ) {
            radioEnabled =
              true;
          } else if (
            action ===
            "stop"
          ) {
            radioEnabled =
              false;

            currentTrack =
              null;

            skipVersion++;

            if (
              sourceSocket
            ) {
              try {
                sourceSocket.close(
                  4001,
                  "Rádio desligada pelo admin"
                );
              } catch {}
            }
          } else if (
            action ===
            "next"
          ) {
            if (
              !radioEnabled
            ) {
              radioEnabled =
                true;
            }

            currentIndex =
              files.length
                ? (
                    currentIndex +
                    1
                  ) %
                  files.length
                : 0;

            skipVersion++;
          } else {
            throw new Error(
              "Ação inválida"
            );
          }

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json; charset=utf-8"
            }
          );

          return res.end(
            JSON.stringify(
              statusObject()
            )
          );
        } catch (
          e
        ) {
          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json; charset=utf-8"
            }
          );

          return res.end(
            JSON.stringify({
              ok:
                false,

              error:
                e.message
            })
          );
        }
      }

      if (
        pathname ===
          "/radio" ||
        pathname ===
          "/radio.mp3"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "audio/mpeg",

            "Cache-Control":
              "no-store, no-cache, must-revalidate",

            Connection:
              "keep-alive",

            "Access-Control-Allow-Origin":
              "*",

            "icy-name":
              "Web Rádio Vem Comigo Deus",

            "icy-genre":
              "Gospel"
          }
        );

        if (
          req.method ===
          "HEAD"
        ) {
          return res.end();
        }

        listeners.add(
          res
        );

        req.on(
          "close",
          () =>
            listeners.delete(
              res
            )
        );

        return;
      }

      if (
        pathname === "/"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        );

        return res.end(`
<!doctype html>

<html lang="pt-BR">

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Web Rádio Vem Comigo Deus
</title>

<body
style="
font-family:Arial;
background:#071a33;
color:white;
text-align:center;
padding:30px">

<h1
style="
color:#F9B800">
Web Rádio Vem Comigo Deus
</h1>

<audio
controls
src="/radio.mp3"
style="
width:min(100%,420px)">
</audio>

<p>

<a
style="
color:#FFD600"
href="/admin">
Painel móvel
</a>

</p>

</body>

</html>
`);
      }

      res.writeHead(
        404,
        {
          "Content-Type":
            "application/json; charset=utf-8"
        }
      );

      return res.end(
        JSON.stringify({
          ok:
            false,

          error:
            "Rota não encontrada"
        })
      );
    }
  );

const wss =
  new WebSocketServer({
    noServer:
      true,

    perMessageDeflate:
      false
  });

server.on(
  "upgrade",
  (
    req,
    socket,
    head
  ) => {
    const u =
      new URL(
        req.url ||
          "/",

        `http://${
          req.headers
            .host ||
          "localhost"
        }`
      );

    if (
      u.pathname !==
      "/source-ws"
    ) {
      return socket.destroy();
    }

    wss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => {
        wss.emit(
          "connection",
          ws,
          req
        );
      }
    );
  }
);

wss.on(
  "connection",
  (ws) => {
    if (!radioEnabled) {
      try {
        ws.close(
          4002,
          "Rádio desligada"
        );
      } catch {}

      return;
    }

    if (
      sourceSocket &&
      sourceSocket !==
        ws
    ) {
      try {
        sourceSocket.close(
          4000,
          "Novo source conectado"
        );
      } catch {}
    }

    sourceSocket =
      ws;

    sourceConnected =
      true;

    sourceSince =
      new Date()
        .toISOString();

    currentTrack =
      "Painel Web Rádio • AO VIVO";

    ws.on(
      "message",
      (data) => {
        if (
          !radioEnabled ||
          ws !==
            sourceSocket
        ) {
          return;
        }

        const chunk =
          Buffer.isBuffer(
            data
          )
            ? data
            : Buffer.from(
                data
              );

        if (
          chunk.length
        ) {
          broadcast(
            chunk
          );
        }
      }
    );

    const close = () => {
      if (
        sourceSocket ===
        ws
      ) {
        sourceSocket =
          null;

        sourceConnected =
          false;

        sourceSince =
          null;
      }
    };

    ws.on(
      "close",
      close
    );

    ws.on(
      "error",
      close
    );
  }
);

server.keepAliveTimeout =
  120000;

server.headersTimeout =
  125000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Servidor Vem Comigo Deus v4 Admin Mobile ativo na porta ${PORT}`
    );
  }
);

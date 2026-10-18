import fs from 'node:fs';
const file='server.js';
const original=fs.readFileSync(file,'utf8');
const marker='// VEM COMIGO DEUS PAINEL V4';
if(original.includes(marker)){console.log('Painel V4 já integrado.');process.exit(0)}
const anchor='      if (\n        pathname ===\n          "/admin" &&\n        req.method ===\n          "GET"\n      ) {';
if(!original.includes(anchor))throw new Error('Versão do server.js diferente: não foi alterada.');
const route=`      ${marker}\n      if (pathname === "/admin/v4" && req.method === "GET") {\n        if (!isAdmin(req)) {\n          res.writeHead(302, { Location: "/admin" });\n          return res.end();\n        }\n        res.writeHead(200, {\n          "Content-Type": "text/html; charset=utf-8",\n          "Cache-Control": "no-store",\n          "X-Content-Type-Options": "nosniff"\n        });\n        return res.end(fs.readFileSync(path.join(__dirname, "painel-v4.html"), "utf8"));\n      }\n\n`;
fs.copyFileSync(file,'server.js.backup-v4');
fs.writeFileSync(file,original.replace(anchor,route+anchor));
console.log('Rota /admin/v4 integrada. Backup: server.js.backup-v4');

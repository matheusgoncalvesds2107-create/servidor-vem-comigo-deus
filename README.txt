SERVIDOR PRÓPRIO VEM COMIGO DEUS v1 — TESTE RENDER

OBJETIVO
Testar um stream nosso, sem Caster.fm.

O pacote já inclui o Podcast Vem Comigo Records Episódio 01 LIMPO como áudio de teste
(se disponível no momento da criação).

COMO PUBLICAR
1. Crie um repositório GitHub:
   servidor-vem-comigo-deus

2. Envie TODO o conteúdo desta pasta:
   package.json
   server.js
   audio/

3. Render:
   New + > Web Service

4. Escolha o repositório.

5. Configure:
   Runtime: Node
   Build Command: deixe vazio
   Start Command: npm start

6. Pode usar Free para TESTE.

7. Depois que ficar Live, teste:
   https://SEU-SERVICO.onrender.com/health
   https://SEU-SERVICO.onrender.com/radio.mp3

8. A página principal também tem um player:
   https://SEU-SERVICO.onrender.com/

IMPORTANTE
- O plano Free do Render pode dormir após 15 minutos sem tráfego.
- Arquivos adicionados durante a execução não persistem no Free.
- Para este teste, os MP3 ficam versionados no GitHub e entram no deploy.
- Para rádio 24h real depois, vamos definir armazenamento e plano adequados.

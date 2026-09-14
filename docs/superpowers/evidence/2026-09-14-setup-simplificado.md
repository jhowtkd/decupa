# Evidência — setup simplificado (Task 6): aceite real, guias e entrega

Data do aceite: 14/09/2026. Plano: `docs/superpowers/plans/2026-09-14-setup-simplificado.md` (Task 6, Steps 1–5).
Branch: `feat/setup-simplificado`. O aceite rodou em duas rodadas: a 1ª em `029bd6e` encontrou um bloqueio no setup (npm do Homebrew não localizado — seção “Histórico do bloqueio”); após o fix `5c9bd89` (`fix: locate npm-cli.js across Node install layouts`), o aceite completo foi reexecutado em **HEAD `5c9bd89cb8075f3da73a79a729900a2f7b20d77f`**, que é o commit desta evidência.
Clone de aceite: `/var/folders/95/s9tsrvnx7x7dp9t149ty6y980000gn/T/opencode/Decupa Aceite/repo` (caminho com espaços, obrigatório). Nenhum segredo/credencial neste arquivo.

## Matriz de evidências

| sistema/arquitetura | commit | Node/uv/FFmpeg/Python | setup novo | setup repetido | motor WIP | caminho com espaços | fala local | MP4 | Ctrl+C | CI | limitações |
|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS 26.6.2 (build 25G83), arm64 | `5c9bd89` | Node v26.7.0 (Homebrew) · uv 0.11.6 · FFmpeg 9.0.1 (Homebrew, libx264+AAC) · git 2.54.0 · Python: uv instalou/usou CPython 3.11.15 e 3.12 (sidecars + `work/engine-venv` 3.11); sistema 3.14.7 | **PASSOU** — 44 s, exit 0, todas as etapas + `doctor --local` todo OK (caches uv/Python quentes; downloads parciais: visão ~92 MB, motor ~50 MB; JS: 88/88 pacotes reusados). Aviso pnpm: “Ignored build scripts: @google/genai, protobufjs”. Log: `/tmp/aceite-setup-novo.log` | **PASSOU** — 4 s, exit 0, idempotente (zero downloads); `git status --short` do clone vazio; artefatos (`work/`, `node_modules/` ×9, `services/*/.venv`) todos ignorados pelo `.gitignore`. Log: `/tmp/aceite-setup-repetido.log` | **PASSOU** (revalidado em `5c9bd89`) — fixture untracked → recusa `motor existente modificado; nenhuma alteração feita`, exit 1, <1 s, fixture intacta e HEAD do motor no PIN `d9fe300`; removida só a fixture; reexecução exit 0. Instalação nova do motor (rodada 1): 2 s. Log: `/tmp/aceite-engine-wip-2.log` | **PASSOU** — clone, setup, motor, servidor, projeto e ingestão inteiros sob `…/Decupa Aceite/…` (repo, `Meu Projeto`, `Meu Projeto 2`, `Teste Midia/fala-ptbr.mp4`); `project.json` criado e reaberto em pasta com espaços; spawn sem shell preservou os argumentos | **PASSOU** — vídeo de teste 107,16 s (lavfi color + `dji-0901.wav` autorizado do repo principal, montado em tmpdir) via `start.mjs --input`: stage `ready` em **158 s** (transcrição ~142 s incluindo download do `faster-whisper-small`; índice 5 s; visual ~10 s incluindo download dos `.task` do MediaPipe; alinhamento PT já em cache). Transcrição não vazia: 14 segmentos/247 palavras em PT-BR; timestamps 0,311–104,673 s ≤ 107,160 s (ffprobe); `speech_index` 22 unidades; `visual_index`, `condense_plan` e review gerados. **Nenhuma chamada remota/paga.** Logs: `/tmp/aceite-ingest{,-poll}.log` | **PASSOU (baseline) / FALHA PARCIAL (fractional)** — `assembly-proof.ts` exit 2 em 2 s: baseline (25 fps) render OK + frameCheck {50 frames, azul em 25} OK; fractional (29.97) render OK e decodifica sem erro, mas a asserção frame-a-frame do proof falhou: `primeiro azul=26 (esperado 25)`. `assembly-proof.ts`/`assembly/render.ts` **não foram modificados nesta branch** (últimas mudanças pré-branch) → achado preexistente para o revisor. MP4 baseline conferido: h264 320x240@25 + aac, 50 frames, `ffmpeg -f null` rc=0, 2,0 s; fractional: h264 30000/1001 + aac, 50 frames, decode sem erro, 1,668 s. `davinci-proof` não executado (plano proíbe). Log: `/tmp/aceite-assembly-proof.log` | **PASSOU** — SIGINT no launcher encerrou launcher+filho e fechou a porta em 4 ocasiões (montar padrão, montar `--port 7799`, reabertura, ingestão `limpar`), sem processos órfãos; `open` do navegador executou sem erro (aba loopback aberta — aceitável). Porta ocupada: 2ª instância na mesma porta falhou com `erro: listen EADDRINUSE: address already in use 127.0.0.1:7799`, exit 1, 1ª instância ilesa (GET 200). Reabrir após encerrar: funcionou (mesmo projeto `d7180463`). Logs: `/tmp/aceite-start-{1,A,B,2}.log` | matriz configurada em `.github/workflows/ci.yml` (`macos-latest` + `windows-latest`, Node 22, pnpm 10.32.1, typecheck+test, chaves vazias); **execução remota pendente de autorização de push** | setup de 44 s medido com caches quentes — instalação fria (downloads completos de Python/uv, torch/whisperx etc.) não medida; asserção fractional do assembly-proof falha (preexistente); suíte `pnpm test`/`pnpm typecheck` não rodada no clone de aceite (fora do escopo da Task 6; CI cobre após push); MCP stdio segue com framing `Content-Length` (incompatível com o transporte padrão); modelos de IA: `faster-whisper-small` e `.task` do MediaPipe baixados neste aceite, alinhamento PT já estava em cache |
| Windows x64 nativo | `5c9bd89` (branch disponível) | não executado — sem máquina Windows real disponível | não executado — sem máquina Windows real disponível; **Windows NÃO homologado** | não executado — idem | não executado — idem | não executado — idem | não executado — idem | não executado — idem | não executado — idem (encerramento de árvore via `taskkill /T` comprovado só em teste Vitest, não em console Windows real) | matriz CI configurada cobre a validação remota quando houver push autorizado | Aceite real em máquina Windows nativa continua pendente; nada nesta linha foi observado. |

## Histórico do bloqueio npm (encontrado e corrigido durante a Task 6)

Na rodada 1 (HEAD `029bd6e`), `node scripts/setup.mjs` falhou em <1 s com exit 1 e a mensagem exata:

```text
== Localizando o npm local (nenhuma ferramenta global é alterada) ==
Node sem npm localizável: instale Node com npm; nenhuma ferramenta global foi alterada
```

Causa: a busca original testava só `<nodeDir>/node_modules/npm/bin/npm-cli.js` e `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js` a partir do realpath do Node (`/opt/homebrew/Cellar/node/26.7.0/bin/node`); o npm do Homebrew fica em `Cellar/node/26.7.0/libexec/lib/node_modules/npm/bin/npm-cli.js` (e, nesta máquina, o npm global 11.19.0 está em `/opt/homebrew/lib/node_modules/npm`). O setup parava antes de qualquer escrita; todos os itens dependentes de ambiente ficaram bloqueados na rodada 1 (registro preservado nos logs `/tmp/aceite-setup-1{,b}.log`).

Correção: commit **`5c9bd89`** — `findNpmCli()` em `scripts/setup.mjs` cobre Windows (`node_modules/npm`), Unix clássico (`../lib/node_modules/npm`), Homebrew Cellar (`../libexec/lib/node_modules/npm`) e o symlink `npm` irmão do binário (com validação de realpath). Nesta máquina resolve para `/opt/homebrew/Cellar/node/26.7.0/libexec/lib/node_modules/npm/bin/npm-cli.js`. Rodada 2 do aceite (este arquivo) rodou inteira sobre o fix.

## Durações medidas (relógio local, `date '+%F %T'`; rodadas 1 e 2)

| Etapa | Início | Duração | Resultado | Log |
|---|---|---|---|---|
| `git clone -b feat/setup-simplificado` (rodada 1, `029bd6e`) + `git pull` para `5c9bd89` (rodada 2) | 06:48 / 07:16 | ~1 s cada | HEAD confere nas duas rodadas | — |
| `node scripts/setup.mjs` (rodada 1, `029bd6e`) | 06:49:07 e 06:54:06 | <1 s | **falha npm** (bloqueio acima), exit 1, nada escrito | `/tmp/aceite-setup-1{,b}.log` |
| `node scripts/setup.mjs --engine-only` (instalação nova do motor, rodada 1) | 06:54:35 | 2 s | exit 0; motor no PIN `d9fe300…` + patch (`FILLERS_SOFT_PT`) | `/tmp/aceite-engine-1.log` |
| `--engine-only` com fixture untracked (recusa WIP; revalidado em `5c9bd89` às 07:19) | 06:54:59 | <1 s | `motor existente modificado; nenhuma alteração feita`, exit 1, fixture intacta | `/tmp/aceite-engine-wip{,-2}.log` |
| `--engine-only` pós-remoção da fixture (idempotente) | 06:55:16 e 07:19 | <1 s | exit 0 | `/tmp/aceite-engine-2.log` |
| `node scripts/setup.mjs` (novo, rodada 2, `5c9bd89`) | 07:17:23 | **44 s** | exit 0; doctor --local todo OK; caches quentes, downloads parciais (~142 MB somados visão+motor) | `/tmp/aceite-setup-novo.log` |
| `node scripts/setup.mjs` (repetido) | 07:18:49 | **4 s** | exit 0; idempotente; `git status --short` vazio | `/tmp/aceite-setup-repetido.log` |
| `start.mjs --project` (montar; GET `/` e `/project` 200; SIGINT; porta fechada) | 07:19–07:20 | ~2 s para bind; shutdown <2 s | passou | `/tmp/aceite-start-1.log` |
| Porta ocupada (`--port 7799` ×2 instâncias) + reabrir projeto | 07:21–07:22 | <3 s cada | B: `EADDRINUSE` exit 1; A ilesa; reabertura 200 | `/tmp/aceite-start-{A,B,2}.log` |
| Ingestão local PT-BR (`start.mjs --input`, vídeo 107,16 s) | 07:23:33 | **158 s** até `ready` | passou (detalhes na matriz) | `/tmp/aceite-ingest{,-poll}.log` |
| `assembly-proof.ts` com `DECUPA_ENGINE_PYTHON` do clone | 07:28 | 2 s | exit 2 — baseline OK; fractional: asserção `primeiro azul=26 (esperado 25)` | `/tmp/aceite-assembly-proof.log` |
| Setup frio completo (sem caches) / download integral dos modelos | — | **não medido** | caches uv/HF desta máquina já aquecidos | — |

## Achados para o revisor (além do bloqueio npm já corrigido)

1. **assembly-proof fractional (29.97 fps)**: `fractional: frames=50 (esperado 50); primeiro azul=26 (esperado 25)`. Render e decode do MP4 OK; divergência de 1 frame na fronteira da timeline fracionária. `scripts/assembly-proof.ts` e `apps/cli/src/app/assembly/render.ts` não mudaram nesta branch (`git log`: últimas alterações em `6c11033`/`cceb38c`/`133331a`, todas anteriores) → comportamento preexistente ou sensível ao ambiente (FFmpeg 9.0.1), não regressão das Tasks 1–5. Não contornado.
2. **pnpm 10 “Ignored build scripts: @google/genai@2.21.0, protobufjs@7.6.6”** durante `pnpm install --frozen-lockfile`: aviso padrão do pnpm (scripts de postinstall bloqueados); não afetou typecheck/doctor/testes deste aceite, mas vale decisão explícita (`pnpm approve-builds` ou ignorar documentado).
3. Setup repetido revalida o motor por `git diff --binary` + clone temporário `--shared`: custou ~2 s dos 4 s totais — aceitável, registrado para ciência.

## Guias atualizados na Task 6

- `docs/setup/GUIA.md`: caminho principal `node scripts/setup.mjs` + `node scripts/start.mjs`; pré-requisitos com links; modelos de primeiro uso com as durações observadas neste aceite; onde ficam ambientes/projetos; Ctrl+C; retomada e proteção do motor; receita manual duplicada removida (troubleshooting conservado); situação por plataforma atualizada após o fix `5c9bd89`.
- `docs/setup/PROMPT-AGENTE.md` (commit `f24484a`): agente executa setup/start e relata cada etapa com durações; aviso MCP (`Content-Length`) mantido; autorização separada para operações pagas mantida.
- `docs/superpowers/plans/2026-09-14-setup-simplificado.md`: não editado (documento aprovado; o desvio do bloqueio npm está registrado aqui).

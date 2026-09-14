# Evidência — setup simplificado (Task 6): aceite real, guias e entrega

Data do aceite: 14/09/2026. Plano: `docs/superpowers/plans/2026-09-14-setup-simplificado.md` (Task 6, Steps 1–5).
Branch: `feat/setup-simplificado`. HEAD no aceite: `029bd6e374f4062feba26d67278ba69c794e6d0c` (`test: run Decupa checks on Windows and macOS`).
Clone de aceite: `/var/folders/95/s9tsrvnx7x7dp9t149ty6y980000gn/T/opencode/Decupa Aceite/repo` (caminho com espaços, obrigatório). Nenhum segredo/credencial neste arquivo.

## Matriz de evidências

| sistema/arquitetura | commit | Node/uv/FFmpeg/Python | setup novo | setup repetido | motor WIP | caminho com espaços | fala local | MP4 | Ctrl+C | CI | limitações |
|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS 26.6.2 (build 25G83), arm64 | `029bd6e` | Node v26.7.0 (Homebrew) · uv 0.11.6 · FFmpeg 9.0.1 (Homebrew, libx264+AAC) · git 2.54.0 · Python sistema 3.14.7 (venv 3.11 do motor não chegou a ser criado — setup bloqueado) | **FALHOU** em <1 s, exit 1: `Node sem npm localizável: instale Node com npm; nenhuma ferramenta global foi alterada` (detalhes abaixo). Nada foi escrito no clone. | **não executado** — exige a primeira execução bem-sucedida. Falha determinística confirmada em repetição (mesmo erro, <1 s, exit 1); `git status --short` do clone vazio após as falhas. | **PASSOU** via `--engine-only` (independe do npm): instalação nova 2 s (PIN `d9fe300` + patch, `FILLERS_SOFT_PT` presente); fixture untracked → recusa `motor existente modificado; nenhuma alteração feita`, exit 1, <1 s, fixture intacta e HEAD no PIN; removida só a fixture; reexecução idempotente exit 0, <1 s. | **passou no que foi exercitado**: clone, instalação e recusa do motor sob `…/Decupa Aceite/repo`; mensagem do `start.mjs` preservou o caminho absoluto com espaços (`…/Decupa Aceite/Meu Projeto`). Servidor/ingestão não exercitados (bloqueado). | **não executado** — bloqueado pela falha do setup (faltam `node_modules`, `services/speech/.venv`, `work/engine-venv`). Mídia autorizada separada (`work/wav/dji-0901.wav` do repo principal, 104,9 s, PT-BR) mas não processada; download de modelos e duração de transcrição não medidos. | **não executado** — `assembly-proof.ts` depende de `node_modules` e do venv do motor (bloqueado pelo setup). `davinci-proof` não executado (fora do escopo do plano). | **não executado** — exige servidor de pé (bloqueado). Observado apenas o pre-check do launcher sem runtime: recusa limpa `Python do motor não encontrado em …/work/engine-venv/bin/python` + `Execute primeiro: node scripts/setup.mjs`, exit 1, sem iniciar processo nem abrir porta. | matriz configurada em `.github/workflows/ci.yml` (`macos-latest` + `windows-latest`, Node 22, pnpm 10.32.1, typecheck+test, chaves vazias); **execução remota pendente de autorização de push**. | Bloqueio do setup no Node Homebrew (abaixo); suíte `pnpm test`/`pnpm typecheck` não rodados no clone de aceite (dependem de `pnpm install`, bloqueado); MCP stdio segue com framing `Content-Length` (incompatível com o transporte padrão); Windows não homologado. |
| Windows x64 nativo | `029bd6e` (branch disponível) | não executado — sem máquina Windows real disponível | não executado — sem máquina Windows real disponível; **Windows NÃO homologado** | não executado — idem | não executado — idem | não executado — idem | não executado — idem | não executado — idem | não executado — idem (encerramento de árvore via `taskkill /T` comprovado só em teste Vitest, não em console Windows real) | matriz CI configurada cobre a validação remota quando houver push autorizado | Aceite real em máquina Windows nativa continua pendente; nada nesta linha foi observado. |

## Bloqueio para o revisor: setup não localiza o npm no Node do Homebrew

`scripts/setup.mjs` (Task 3), passo “Localizando o npm local”, resolve `dirname(realpath(process.execPath))` e testa dois candidatos:

- candidato 1: `/opt/homebrew/Cellar/node/26.7.0/bin/node_modules/npm/bin/npm-cli.js` — **não existe**;
- candidato 2: `/opt/homebrew/Cellar/node/26.7.0/lib/node_modules/npm/bin/npm-cli.js` — **não existe** (`Cellar/node/26.7.0/lib/` contém apenas `libnode.147.dylib`).

Onde o npm de fato está nesta máquina:

- npm empacotado pelo Homebrew: `/opt/homebrew/Cellar/node/26.7.0/libexec/lib/node_modules/npm/bin/npm-cli.js` (layout `libexec`, não coberto pelos candidatos — afeta Node de Homebrew em geral, o caminho de instalação mais comum no macOS);
- npm global auto-atualizado (11.19.0): `/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js` (alvo do symlink `Cellar/.../bin/npm`).

Contexto: o `node` padrão do PATH é `/opt/homebrew/bin/node` → realpath `/opt/homebrew/Cellar/node/26.7.0/bin/node` (v26.7.0, o mesmo dos fatos verificados). Um Node com layout nodejs.org existiria em `/usr/local/bin/node` (v24.12.0, npm em `/usr/local/lib/node_modules`) e satisfaria o candidato 2 — mas o aceite deve valer para o node padrão da máquina. Erro exato no clone de aceite:

```text
== Verificando pré-requisitos ==

== Localizando o npm local (nenhuma ferramenta global é alterada) ==
Node sem npm localizável: instale Node com npm; nenhuma ferramenta global foi alterada
exit_code=1
```

Consequência: o setup para antes de qualquer escrita (sem `work/setup-tools`, sem `node_modules`, sem venvs), e todos os itens de aceite que dependem de ambiente (setup repetido, start/servidor, Ctrl+C, porta ocupada, reabrir, fala local, MP4/assembly-proof) ficaram bloqueados. `--engine-only` não usa npm e pôde ser aceito normalmente. Código não foi alterado neste aceite (apenas docs), conforme instrução.

## Durações medidas (relógio local, `date '+%F %T'`)

| Etapa | Início | Duração | Resultado | Log |
|---|---|---|---|---|
| `git clone -b feat/setup-simplificado` (caminho com espaços) | 2026-09-14 06:48 | ~1 s | HEAD `029bd6e` confere | — |
| `node scripts/setup.mjs` (1ª execução) | 06:49:07 | <1 s | falha npm (exit mascarado por pipe/tee) | `/tmp/aceite-setup-1.log` |
| `node scripts/setup.mjs` (repetição, exit exato) | 06:54:06 | <1 s | falha npm, `exit_code=1` | `/tmp/aceite-setup-1b.log` |
| `node scripts/setup.mjs --engine-only` (instalação nova do motor) | 06:54:35 | 2 s | exit 0; HEAD do motor `d9fe30076c00ce2968d570622dd22ba068337568` = PIN; patch aplicado | `/tmp/aceite-engine-1.log` |
| `--engine-only` com fixture untracked (recusa WIP) | 06:54:59 | <1 s | `motor existente modificado; nenhuma alteração feita`, exit 1; fixture intacta | `/tmp/aceite-engine-wip.log` |
| `--engine-only` após remover a fixture (idempotente) | 06:55:16 | <1 s | exit 0; diff do motor = só o patch esperado | `/tmp/aceite-engine-2.log` |
| `node scripts/start.mjs --project "…/Decupa Aceite/Meu Projeto"` (sem runtime) | 06:56:19 | <1 s | recusa orientada, exit 1 | saída inline |
| Setup completo bem-sucedido / primeiro processamento (download de modelos WhisperX+alinhamento PT e MediaPipe) | — | **não medido** | bloqueado pela falha do setup | — |

## Itens do Step 2 não executados (registro)

- Servidor montar/GET `/`/GET `/project`, porta ocupada com `--port` fixa, reabrir após encerrar, SIGINT/Ctrl+C com porta fechada: **não executados** — `start.mjs` exige `work/engine-venv/bin/python` e `node_modules`, que o setup não criou.
- Ingestão local PT-BR (WhisperX) com mídia autorizada: **não executada** — mesmos bloqueios; sem chamada remota/paga em nenhum momento do aceite.
- `assembly-proof.ts` + ffprobe do MP4: **não executado** — mesmos bloqueios. `davinci-proof`: não executado (o plano proíbe).

## Guias atualizados nesta task

- `docs/setup/GUIA.md`: caminho principal passa a ser `node scripts/setup.mjs` + `node scripts/start.mjs`; pré-requisitos com links; modelos de primeiro uso; onde ficam ambientes/projetos; Ctrl+C; retomada e proteção do motor; receita manual duplicada removida (troubleshooting conservado); situação por plataforma aponta para esta evidência.
- `docs/setup/PROMPT-AGENTE.md`: agente executa setup/start e relata cada etapa com durações; aviso MCP (`Content-Length`) mantido; autorização separada para operações pagas mantida.

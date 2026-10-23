# Evidência — linha de base dos testes antes do Decupa Studio

Data: 22/10/2026. Commit medido: **`2b7ef06`** (`main` intocado, antes de qualquer mudança do PR 1 da pilha “Decupa Studio”). Ramo `studio/pr01-base-alternancia`, worktree limpo, `pnpm install --frozen-lockfile` recém-feito. Nenhum segredo neste arquivo; a suíte roda com as chaves zeradas por `vitest.config.ts`.

Ambiente: Linux 6.8.0 x86_64 · Node v24.21.0 · pnpm 10.32.1. Esta tabela é local; a linha de base do CI, que roda Node 22 em Ubuntu, macOS e Windows, está na [seção do CI](#linha-de-base-do-ci-por-runner-main--2b7ef06).

## Resultado

| Comando | Resultado | Contagem |
|---|---|---|
| `pnpm test` (`vitest run`) | **exit 1** — 1 falha intermitente (abaixo) | Arquivos: 348 passaram, 1 falhou, 2 pulados (351). Testes: 2887 passaram, 1 falhou, 5 pulados (2893). 117,6 s |
| `pnpm typecheck` (`tsc --noEmit`) | **PASSOU**, exit 0 | — |
| `pnpm lint` (`oxlint . --deny-warnings`) | **PASSOU**, exit 0 | — |
| `pnpm smoke` (`scripts/smoke-strip-types.mjs`) | **PASSOU**, exit 0 | `index.ts`, `triage.ts` e `app/server.ts` importam sob `--experimental-strip-types` |

## Falha pré-existente

`apps/cli/src/app/media-admission.test.ts` › *não admite sobre-reserva quando Drive reinicia e trunca parcial durante stat*

```text
Error: ENOENT: no such file or directory, open '<tmp>/media-admission-drive-restart-race-…/.tmp/00000000-0000-4000-8000-000000000601/data'
 ❯ apps/cli/src/app/media-admission.test.ts:665:72
Caused by: Error: Matcher did not succeed in time.
```

O `expect.poll` da linha 665 espera o parcial do Drive reaparecer e estoura o prazo quando a suíte inteira disputa a máquina. Rodando só o arquivo, passou nas três tentativas (22/22 cada). É intermitência de carga em código que o redesign não toca; não é regressão. Os PRs da pilha comparam contra esta tabela: essa falha, se aparecer, não conta como nova.

## Outra intermitência, vista no fim do PR 1

Na primeira rodada completa sobre o PR 1, `apps/cli/src/app/assembly/editor/montage-hot.test.ts` › *uma atualização de projeto grande fica abaixo de 16 ms* mediu `16.51` ms contra o teto de `16`. É um teto de tempo de relógio: o PR 1 não toca `editor/`, o arquivo isolado passou nas três tentativas e a segunda rodada completa saiu inteira verde (2926 passaram, 5 pulados). Conta como intermitência de carga, como a de cima.

## Linha de base do CI por runner (`main` @ `2b7ef06`)

Run [39603251589](https://github.com/jhowtkd/decupa/actions/runs/39603251589) (push em `main`, 21/10/2026): Node 22, `pnpm test --maxWorkers=2`. O `main` já estava vermelho no CI em macOS e/ou Windows em pelo menos os 8 pushes anteriores (de `254034d` a `2b7ef06`). As falhas abaixo vêm de antes do redesign.

| Runner | Resultado | Testes |
|---|---|---|
| `ubuntu-24.04` | passou | 2886 passaram, 7 pulados (2893) |
| `macos-latest` | falhou | **9 falhas** em 4 arquivos; 2854 passaram, 29 pulados (2892) |
| `windows-latest` | falhou | **41 falhas** em 15 arquivos; 2798 passaram, 54 pulados (2893) |

**Critério para os PRs 2–10: nenhuma falha nova por runner em relação a esta lista.** Uma falha fora da lista, num arquivo que o PR não toca, só conta como intermitência depois de confirmada por rerun do job ou por execução isolada do arquivo. O PR diz qual das duas usou. As intermitências conhecidas estão na próxima seção.

### macOS: 9 falhas

- `apps/cli/src/app/project-new-http.test.ts` › aguarda a análise de Mídia e o journal antes de fechar e apagar a Montagem
- `apps/cli/src/app/project-source-import.additional.test.ts` › copies an imported source after EXDEV while its exact space reservation remains active
- `apps/cli/src/app/project-source-import.additional.test.ts` › fails with 507 before copying or publishing when the consumer volume has no capacity
- `apps/cli/src/app/project-source-import.additional.test.ts` › keeps a copied import when publication reports an error after project.json committed it
- `apps/cli/src/app/project-source-import.additional.test.ts` › rejects a source changed during the copy even when its byte count stays the same
- `apps/cli/src/app/project-source-import.additional.test.ts` › removes only newly copied, unreferenced imports and releases the reservation on publication failure
- `apps/cli/src/app/project-source-import.test.ts` › A8: nova fonte de outro ledger vira hardlink local e sobrevive à limpeza do Projeto de origem
- `apps/cli/src/app/templates/routes.test.ts` › cria template a partir da mídia publicada pelo upload HTTP e mantém metadados do acervo
- `apps/cli/src/app/templates/routes.test.ts` › relink por acervo preserva hash, aprovação histórica e só avança revisão no sucesso

### Windows: 41 falhas

- `apps/cli/src/app/assembly/package.additional.test.ts` › sanitiza separadores hostis no nome da fonte antes de gravar o caminho TAR
- `apps/cli/src/app/assembly/package.additional.test.ts` › usa caminhos relativos no TAR, mantém o OTIO local absoluto e omite fontes sem clipe
- `apps/cli/src/app/assembly/preview-playback-cleanup.additional.test.ts` › does not memoize cancellation as a conversion failure
- `apps/cli/src/app/assembly/preview-playback-cleanup.additional.test.ts` › serves a registered revision after cleanup releases its source media
- `apps/cli/src/app/assembly/preview-playback-route.additional.test.ts` › serves a prepared derivative from the explicit preview route and closes metrics before streaming
- `apps/cli/src/app/cleanup-project-root-http.test.ts` › serve Montagem e Limpeza da mesma Raiz sob prefixos distintos
- `apps/cli/src/app/cleanup-review.additional.test.ts` › rejects a newly published source when publications.lock returns EACCES
- `apps/cli/src/app/drive-upload.test.ts` › cancelar durante o download responde sem esperar e impede publicação
- `apps/cli/src/app/drive-upload.test.ts` › hash divergente falha a validação, descarta o parcial e bloqueia retry
- `apps/cli/src/app/drive-upload.test.ts` › não publica download truncado e bloqueia retry de validação
- `apps/cli/src/app/drive-upload.test.ts` › publica a mídia validada do Drive e expõe o progresso do download
- `apps/cli/src/app/drive-upload.test.ts` › reaproveita a mídia já importada do mesmo conteúdo
- `apps/cli/src/app/drive-upload.test.ts` › recusa mídia acima do máximo e higieniza o nome do Drive
- `apps/cli/src/app/drive-upload.test.ts` › retoma o download do ponto da falha sem baixar tudo de novo
- `apps/cli/src/app/drive-upload.test.ts` › retoma sozinho o download em andamento após reiniciar
- `apps/cli/src/app/drive-upload.test.ts` › rotas de outros transportes recusam o envio do Drive e vice-versa
- `apps/cli/src/app/media-admission.test.ts` › boot concorrente herda reserva Drive ativa sem duplicar o worker
- `apps/cli/src/app/media-admission.test.ts` › conta 2V no mesmo device, V por device distinto e desconta parcial materializado
- `apps/cli/src/app/media-admission.test.ts` › não admite sobre-reserva quando Drive reinicia e trunca parcial durante stat
- `apps/cli/src/app/media-admission.test.ts` › reserva espaço do Drive antes de iniciar o download e libera ao cancelar
- `apps/cli/src/app/media-admission.test.ts` › usa a mesma cota de validação para PATCH local e publicação
- `apps/cli/src/app/pipeline-sidecar.test.ts` › assertSidecarSynced funcional (imagem Docker CPU) > fala valida importando whisperx do venv, sem uv sync
- `apps/cli/src/app/project-cleanup.additional.test.ts` › recovers an interrupted multi-item cleanup idempotently and preserves its references
- `apps/cli/src/app/project-cleanup.additional.test.ts` › rolls a failed quarantine back inside confirmation and releases other project work
- `apps/cli/src/app/project-root-http.test.ts` › aguarda o journal de métricas antes de concluir app.close
- `apps/cli/src/app/project-root-http.test.ts` › não cria journal depois do close se o replanejamento estava gravando spans
- `apps/cli/src/app/project-source-import.additional.test.ts` › copies an imported source after EXDEV while its exact space reservation remains active
- `apps/cli/src/app/project-source-import.additional.test.ts` › fails with 507 before copying or publishing when the consumer volume has no capacity
- `apps/cli/src/app/project-source-import.additional.test.ts` › keeps a copied import when publication reports an error after project.json committed it
- `apps/cli/src/app/project-source-import.additional.test.ts` › rejects a source changed during the copy even when its byte count stays the same
- `apps/cli/src/app/project-source-import.additional.test.ts` › removes only newly copied, unreferenced imports and releases the reservation on publication failure
- `apps/cli/src/app/project-source-import.test.ts` › A8: nova fonte de outro ledger vira hardlink local e sobrevive à limpeza do Projeto de origem
- `apps/cli/src/app/r2-upload.test.ts` › libera a mídia pronta sem esperar a resposta de exclusão do R2
- `apps/cli/src/app/r2-upload.test.ts` › mantém a cópia R2 após download interrompido e repete a importação
- `apps/cli/src/app/r2-upload.test.ts` › publica a mídia local validada antes de apagar o objeto R2
- `apps/cli/src/app/r2-upload.test.ts` › recupera uma exclusão pendente após reiniciar e conserva o recibo
- `apps/cli/src/app/r2-upload.test.ts` › retoma automaticamente a importação em andamento após reiniciar
- `apps/cli/src/app/r2-upload.test.ts` › retoma pelas partes confirmadas no R2 e recupera conclusão perdida antes de persistir
- `apps/cli/src/app/templates/routes.test.ts` › cria template a partir da mídia publicada pelo upload HTTP e mantém metadados do acervo
- `apps/cli/src/app/templates/routes.test.ts` › relink por acervo preserva hash, aprovação histórica e só avança revisão no sucesso
- `apps/cli/src/mcp/tools.test.ts` › MCP tools > MCP limita o ledger ao Projeto avulso por padrão e mantém o escopo Hub explícito

### Intermitências vistas no CI do PR 1

Run [39834944978](https://github.com/jhowtkd/decupa/actions/runs/39834944978), tentativa 1, sobre `83fe68b`. O macOS repetiu exatamente as 9 falhas acima. Fora da lista, todas as falhas são asserções de tempo ou de espera em arquivos que o PR 1 não toca:

- **Ubuntu:**
  - `apps/cli/src/app/media-admission.test.ts` › não admite sobre-reserva quando Drive reinicia e trunca parcial durante stat. É a mesma intermitência da linha de base local.
  - `packages/coordinator/src/hub-holders.additional.test.ts` › expõe slot ativo com metadados enquanto o mesmo Projeto também tem waiter, após heartbeat. Lista de holders vazia depois de um `setTimeout(100)`.
- **Windows:**
  - `apps/cli/src/app/assembly/delivery.test.ts` › entrega que não responde é interrompida, solta a porta e não volta a running. Mediu 1731 ms contra um teto de 1500 ms.
  - `apps/cli/src/app/assembly/preparation.test.ts` › runPreparation › edição correct durante o áudio faz rebase: ready sem perder a correção assentada. O `vi.waitFor` viu o stage `visual` antes de `proposal`.
  - `apps/cli/src/app/r2-upload.test.ts` › limpa a pasta temporária após queda entre publicação e remoção do estado. O `expect.poll` estourou o prazo; no `main`, outros seis testes do mesmo arquivo falham no Windows.
  - No sentido inverso, `cleanup-project-root-http.test.ts` › serve Montagem e Limpeza da mesma Raiz sob prefixos distintos, que está na lista do Windows, passou nesta rodada.

### Intermitências vistas no CI sobre `f2146bf` (Windows)

Run [39839574637](https://github.com/jhowtkd/decupa/actions/runs/39839574637) e rerun do job [120036713849](https://github.com/jhowtkd/decupa/actions/runs/39839574637/job/120036713849). Todas são de arquivos que a pilha não toca:

- `apps/cli/src/app/pipeline-spawn-abort.additional.test.ts` › SpawnExecutor com signal previamente abortado › cancela um processo local que terminaria com sucesso. Falhou nas 2 tentativas deste run e passou no run [39834944978](https://github.com/jhowtkd/decupa/actions/runs/39834944978) e no `main`. É uma corrida: o `exit(0)` em 50 ms chega antes do kill.
- `apps/cli/src/app/r2-upload.test.ts`, só na 1ª tentativa (500 ≠ 202), e os dois passaram no rerun:
  - › inicia o app mesmo com uma exclusão pendente sem resposta
  - › libera o parcial local após falha de importação…
- `apps/cli/src/app/assembly/routes-pending-additional.test.ts` › mantém correção pending após encerramento/cancelamento…. Só na 2ª tentativa: o `waitFor` viu `pending` ≠ `aligned`.
- `apps/cli/src/app/drive-upload.test.ts` › expira download parado e conserva falha para retry explícito. Só na 2ª tentativa: o `expect.poll` no `.tmp` estourou o prazo.

### Intermitências vistas no CI do PR 2 (#190, Windows)

Run [39843790718](https://github.com/jhowtkd/decupa/actions/runs/39843790718). Todas passaram no rerun e são de arquivos que a pilha não toca:

- `apps/cli/src/app/assembly/routes-pending-additional.test.ts` › mantém erro de conteúdo quando a cobertura do alinhamento é inválida. Só na 1ª tentativa: o `waitFor` da linha 147 viu `pending` ≠ `error`.
- `apps/cli/src/app/project-media-http.test.ts` › preserva a análise da primeira Mídia quando outra entra durante o trabalho. Só na 1ª tentativa: a espera da linha 147 viu `analyzing` ≠ `ready`.
- Voltaram as já registradas acima:
  - `pipeline-spawn-abort.additional.test.ts`, na 1ª tentativa;
  - `drive-upload.test.ts` › expira download parado e conserva falha para retry explícito, na 2ª tentativa.
- No sentido inverso, `media-admission.test.ts` › usa a mesma cota de validação para PATCH local e publicação, que está na lista do Windows, passou numa das tentativas.

### Intermitências vistas no CI do PR 3 (#191, Windows)

Run [39881512509](https://github.com/jhowtkd/decupa/actions/runs/39881512509). Cada uma passou numa das duas tentativas do mesmo SHA, e são de arquivos que a pilha não toca:

- `apps/cli/src/app/assembly/f3-pending-regression.test.ts` › R2: assentamento em background e retomada gastam no máximo uma proposta textual. O `waitFor` da linha 76 viu `media` em vez de `proposal`.
- `apps/cli/src/app/cleanup-project-root-http.test.ts` › descarrega Limpeza ociosa e recarrega o Projeto com relógio injetado. O id do job não estava na página (linha 150).
- `apps/cli/src/app/media-admission.test.ts` › retoma 100 imports R2/Drive com cotas de download e validação e expõe a fila. O `waitFor` da linha 248 viu `entered` = 0.

### Intermitências vistas no CI do PR 4 (#192)

Run [39881959764](https://github.com/jhowtkd/decupa/actions/runs/39881959764). Cada uma passou na outra tentativa do mesmo SHA, e são de arquivos que a pilha não toca:

- **macOS:**
  - `apps/cli/src/app/project-new-http.test.ts` › ao abrir a Limpeza criada na Raiz, coloca o preparo na fila global. A espera da linha 410 estourou.
  - `packages/coordinator/src/single-flight.test.ts` › heartbeat de lease antiga não reassume slot tomado por outra tarefa. `ENOTEMPTY` no `rmdir`.
- **Windows:**
  - `apps/cli/src/app/cleanup-project-root-http.test.ts` › descarrega Limpeza ociosa e recarrega o Projeto com relógio injetado (a mesma do #191).
  - `apps/cli/src/app/r2-upload.test.ts`:
    - › cancelar durante o download responde sem esperar e impede publicação. Timeout de 60 s.
    - › preserva o objeto quando a validação falha e permite cancelar explicitamente. 500 ≠ 202.
    - › reconcilia objeto concluído antes da queda sem depender de consulta do navegador. Lista vazia.
  - `apps/cli/src/app/assembly/preparation-new-source-additional.test.ts` › revalida uma fonte incluída durante a espera F2 depois que a correção assenta. O stage veio `undefined` ≠ `proposal`.

### Intermitências vistas no CI do PR 5 (#193)

Run [39888656551](https://github.com/jhowtkd/decupa/actions/runs/39888656551). Cada uma passou na outra tentativa do mesmo SHA, e são de arquivos que a pilha não toca:

- **macOS** (primeira vez neste runner): `apps/cli/src/app/assembly/routes-pending-additional.test.ts` › mantém correção pending após encerramento/cancelamento e GET seguinte relança (worker de fala encerrou).
- **Windows**, reincidências das já registradas acima:
  - `apps/cli/src/app/assembly/preparation.test.ts` › runPreparation › edição correct durante o áudio faz rebase: ready sem perder a correção assentada;
  - `apps/cli/src/app/r2-upload.test.ts` › cancelar durante o download responde sem esperar e impede publicação, e › limpa a pasta temporária após queda entre publicação e remoção do estado;
  - `apps/cli/src/app/drive-upload.test.ts` › expira download parado e conserva falha para retry explícito.

### Intermitências vistas localmente no PR 8 (carga)

Na suíte inteira, sob a carga dos PRs que rodam em paralelo no mesmo host; os dois arquivos passam isolados:

- `apps/cli/src/app/assembly/filler-performance.test.ts`: teto de tempo de relógio.
- `apps/cli/src/app/assembly/preparation-pending-additional.test.ts` › interrompe se a análise vira error durante a espera e a correção assenta.

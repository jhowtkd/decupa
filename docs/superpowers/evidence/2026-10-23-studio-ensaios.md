# Evidência — ensaios e desempenho do Decupa Studio (PR 10)

Data: 23/10/2026. Ramo `studio/pr10-e2e-lancamento`, sobre o PR 9 (`743b106`). Os números de "depois" são do código com as duas correções deste PR: `perf(montagem): seleção no texto percorre só as cenas que ela cita` e `perf(montagem): trilha de legenda agrupa as falas estreitas por cena`.

Tudo aqui roda contra o servidor real (`decupa serve`), com Projetos sintéticos: mídia gerada pelo FFmpeg (lavfi) e transcrição semeada. A preparação real precisa dos modelos de fala, que não existem neste host nem no CI. Nenhum segredo neste arquivo; o servidor dos testes sobe com ambiente mínimo e sem chaves de IA.

## Ambiente de referência

| Item | Valor |
| --- | --- |
| Máquina | VM Linux 6.8.0 x86_64, AMD EPYC (12 vCPU, 1 thread por núcleo), 47 GiB de RAM |
| Carga do host | load average entre 2,6 e 5,6 durante as medidas (VM compartilhada com outras sessões) |
| Navegador | Chromium 156.0.8078.4 (Chrome for Testing do Playwright 1.64.1), headless, 1440×900, sem throttling |
| Node / FFmpeg / Python | v24.21.0 / 7.0.2 estático / 3.12.3 |
| Raízes dos testes | `/dev/shm` (tmpfs de 24 GiB) via `DECUPA_E2E_TMP`, porque `/` tem ~14 GiB livres e o `space.ts` exige 15 GiB para exportar e receber mídia |
| Trace do Playwright | desligado nas medidas: os snapshots do DOM entram no tempo de cada ação |

O CI (ubuntu-24.04) roda as mesmas medidas como relatório, sem teto; o teto de 100 ms vale só neste ambiente.

### Como reproduzir

```sh
node scripts/setup.mjs --engine-only                 # motor de render do bundle, sem rede
pnpm exec playwright install chromium                # se o navegador não estiver em cache
DECUPA_E2E_TMP=/dev/shm pnpm e2e                     # suíte do navegador
DECUPA_E2E_TMP=/dev/shm DECUPA_E2E_P95_GATE=1 pnpm exec playwright test desempenho
DECUPA_E2E_TMP=/dev/shm DECUPA_E2E_EXTENSA=4x4000x10 pnpm exec playwright test desempenho -g extensa
DECUPA_E2E_TMP=/dev/shm DECUPA_E2E_FILA=1280x720x10 pnpm exec playwright test --project=ensaio
```

`DECUPA_E2E_EXTENSA="<Mídias>x<palavras por Mídia>x<falas por Mídia>"` muda o tamanho do projeto extenso; cada fala vira uma cena.

## Desempenho: p95 das interações locais aquecidas

**Método.** `e2e/desempenho.e2e.ts` mede três interações:
- selecionar uma palavra (até a barra de seleção);
- abrir e fechar o painel do Projeto (`#railToggle`);
- trocar de etapa (Materiais → Edição → Revisão → Entrega).

Cada interação tem 5 repetições de aquecimento e 50 medidas, com clique real pelo Playwright (CDP). A medida é tomada na página: do `timeStamp` do `pointerdown` até o primeiro quadro depois dos handlers do `click` (rAF e, em seguida, uma tarefa). A Event Timing API confere à parte, com granularidade de 8 ms e só acima de 16 ms. Antes de medir, a prévia da jornada já está pronta, para nenhum render disputar a máquina; o projeto extenso sobe sem motor, e a auto-prévia falha na hora.

### Resultado final (p50 / p95 / máximo, ms)

| Projeto | Material | selecionar | painel | etapa |
| --- | --- | --- | --- | --- |
| jornada | 2 Mídias, 5 cenas, 28 s | 12,8 / **19,1** / 22,9 | 21,8 / **26,4** / 27,7 | 20,6 / **31,4** / 38,5 |
| 1×9000 | 1 Mídia, 9 000 palavras, 30 cenas (~1 h) | 16,8 / **21,1** / 24,0 | 22,8 / **34,7** / 40,5 | 19,8 / **42,4** / 49,3 |
| 4×4000 | 4 Mídias, 16 000 palavras, 40 cenas (~1,8 h) | 16,7 / **20,7** / 22,5 | 28,1 / **36,6** / 39,6 | 21,4 / **55,1** / 74,6 |
| 20×2000 | 20 Mídias, 40 000 palavras, 200 cenas (~4,4 h) | 41,3 / **55,8** / 65,8 | 93,5 / **118,1** / 127,8 | 71,1 / **163,7** / 260,9 |

**O teto de p95 ≤ 100 ms vale até ~40 cenas e ~4 h de material.** Nos três primeiros projetos, as três interações ficam abaixo de 60 ms. No 20×2000 a seleção fica em 56–63 ms, mas painel e etapa ficam acima do teto (achado abaixo), e a carga do host move esses dois números de uma execução para outra. Por isso entram como faixa, juntando as execuções do PR 10 (50 amostras, as repetições de 20 e a execução da revisão independente):

| 20×2000, p95 | Faixa observada |
| --- | --- |
| painel | **96–151 ms** |
| etapa | **105–164 ms** |

### Antes e depois das correções (p95, ms)

| Projeto | selecionar | painel | etapa |
| --- | --- | --- | --- |
| jornada | 15,6 → 17,6 → **19,1** | 47,5 → 26,1 → **26,4** | 26,5 → 24,1 → **31,4** |
| 1×9000 | 267,9 → 31,7 → **21,1** | 74,1 → 68,9 → **34,7** | 105,9 → 91,4 → **42,4** |
| 4×4000 | 577,5 → 53,3 → **20,7** | 145,2 → 110,7 → **36,6** | 172,0 → 156,9 → **55,1** |
| 20×2000 | 13 209 → 203,3 → **55,8** | 423,4 → 312,1 → **118,1** | 372,7 → 367,5 → **163,7** |

Colunas: antes (PR 9 + e2e, 10 amostras; com 10 amostras o p95 é o máximo) → só a correção da seleção (50 amostras) → as duas correções (50 amostras).

### O que estava lento e o que mudou

1. **Seleção no texto (studio).** Cada clique recalcula a barra de seleção (PR 3), que chamava `selectedTake` e `selectedFlags` (`texto.js`). As duas percorriam todas as cenas × todas as Mídias × todas as palavras das zonas omitidas. No 20×2000, um clique levava ~12,5 s até pintar. A legacy só pagava isso ao abrir o menu da palavra; o clique simples nela pinta em ~34 ms. Agora as duas funções só percorrem as cenas, os takes e as zonas que a seleção cita (helper `citedOf`), com testes de equivalência contra as versões antigas.
2. **Trilha de legenda da faixa (studio, PR 5).** Um `<span>` por fala: ~6 000 no 20×2000, cada um com fundo, borda arredondada e recorte, quase todos com menos de 1 px no zoom 1×. Pesavam em cada quadro. Experimento por CSS no 20×2000 (medianas):
   - como estava: seleção 134 ms, painel 284 ms, etapa 148 ms;
   - sem as cues: 35, 79 e 33 ms;
   - tirar só o texto das cues mal mudava.

   Agora falas seguidas com menos de 24 px, sem vão de 24 px e da mesma cena, viram um bloco listrado "N falas, m:ss–m:ss" sob a cena. Falas largas seguem sozinhas. O resultado custa o mesmo que nenhuma cue, dentro do ruído.

### Achado: custo restante no 20×2000 (ticket `fora-da-pilha-faixa-projetos-grandes`)

Depois das duas correções, o trace do Chromium no 20×2000 ainda mostra, por interação de painel, ~41 ms de Layerize e ~41 ms de Paint. O JS é pequeno. A origem são as ~400 peças `position: sticky` da faixa: o rosto de cada cena (`.bloco-rosto`, PR 5) e a alça de cada cena (`.alca-cena`, PR 9). Escondê-las por CSS baixa o p95 do painel de 96 para 66 ms e o da etapa de 121 para 83 ms; sem a faixa inteira, tudo cai para menos de 40 ms. O custo aparece quando a largura da faixa muda (abrir o painel) e quando ela surge (entrar na Edição). A mediana da etapa fica em ~40–70 ms; a cauda é a troca que mostra a faixa. Não foi mexido neste PR, para não tocar no gesto do PR 9 nem no rosto do PR 5. Os caminhos possíveis (desenhar alças e rostos só na janela visível, ou trocar o sticky por posição calculada) ficam no ticket.

## Ingestão de 20 e 50 Mídias

`e2e/ensaios.ensaio.ts`. Os arquivos são selecionados de uma vez pela fila de Materiais do studio, em modo local (`project/import`); a medida vai até o resumo dizer "N de N no projeto" e as N fontes aparecerem no servidor. Cada Mídia é sintética: 1280×720, 25 fps, 10 s, H.264 + AAC, com bytes distintos.

| Mídias | Total | Fila completa na tela | Todas no Projeto | Por Mídia |
| --- | --- | --- | --- | --- |
| 20 | 65,4 MB | 60 ms | 3,4 s | 170 ms |
| 50 | 163,6 MB | 71 ms | 8,0 s | 160 ms |

A fila mostra todos os arquivos antes do primeiro envio terminar, e os envios seguem um por vez. O CI cobre o mesmo fluxo (`e2e/fila.e2e.ts`) com arquivos de 1 s, segurando os envios para conferir a fila inteira. Envio por R2 ou Drive e rede real não entram aqui.

## Transcrição extensa: abrir e buscar

| Projeto | Palavras | `GET project` | Abrir até a primeira palavra | Buscar "farol amarelo" e revelar (cena 200) |
| --- | --- | --- | --- | --- |
| 1×9000 | 9 000 | 6,1 MB | 0,68 s | 79 ms |
| 4×4000 | 16 000 | 13,1 MB | 0,82 s | 121 ms |
| 20×2000 | 40 000 | 19,5 MB | 1,32 s (legacy: 1,33 s) | 196–225 ms |

A busca acha a ocorrência fora da janela virtualizada e a revela, o que `e2e/busca.e2e.ts` também confere no CI. Abrir custa o mesmo nas duas variantes. Uma medida anterior de ~6,5 s para abrir o 20×2000 tinha o trace do Playwright ligado e não vale.

## Mídia 4K representativa

Fonte sintética 3840×2160, 25 fps, 20 s, H.264 + AAC (44,4 MB), num Projeto de duas cenas com formato 16:9 · 1920×1080.

| Etapa | Tempo |
| --- | --- |
| Ingestão pelo navegador (Projeto vazio, fila) | 0,83–0,86 s |
| Prévia pelo motor real (timeline de ~17 s) | 13,9–14,2 s |
| Derivado de reprodução do primeiro play (até 960 px) | 1,4 s |

A prévia sai em **1920×1080 a 25 fps**, o formato da montagem, e não 4K: a fonte 4K não decide sozinha a saída.

## Render no E2E: o motor real

- O motor está no repositório (`scripts/engine/video-agent-kit.bundle` + `local-engine.patch`). `node scripts/setup.mjs --engine-only` o clona sem rede em `work/video-agent-kit-plugin`. O `render_preview` só usa a biblioteca padrão do Python 3 e o FFmpeg: dispensa venv e OpenCV.
- A jornada (`e2e/jornada.e2e.ts`) usa a auto-prévia renderizada por esse motor, com o `assemblySha256` real. O job `e2e` do CI instala o motor do mesmo jeito. Não há prévia sintética nos testes.
- **A exportação roda sem o motor.** `exportApprovedOperation` nunca renderiza: copia o `reference.mp4` da prévia aprovada depois de conferir sha256, `assemblySha256` e duração. As legendas saem do `subtitleRecord`. A jornada confere os downloads byte a byte: o vídeo tem o sha256 da prévia aprovada, e o `.vtt`/`.srt` (soltos e dentro do pacote `.tar`) são iguais ao `subtitleRecord` da revisão.
- **Achado, não corrigido aqui.** Com o motor presente, `apps/cli/src/app/assembly/render.test.ts` › "render segmentado de 12s preserva bordas, voz contínua e portrait VFR em 30000/1001" falha neste host (`duração 12.160 s, a timeline tem 12.012 s`). O teste só roda quando o motor existe, e o CI não instala o motor antes da suíte JS. Os outros dois renders reais (V1/V2/V1 e muitos cortes) passam.
- **Risco em aberto.** O CI usa o FFmpeg 6.1 do apt; aqui o render real rodou com o 7.0.2 estático. O render real nunca tinha rodado no CI. O plano B está pronto e desligado: `DECUPA_E2E_MOTOR=sintetico` aponta `VE_PLUGIN_ROOT` para `e2e/apoio/motor-sintetico`. É um `ve_tools` mínimo que o `render-assembly.py` real carrega; ele grava um MP4 liso do FFmpeg na duração e no quadro da timeline, e o resto do caminho (registro da prévia com o `assemblySha256` real, aprovação, exportação e downloads) continua o de verdade. A jornada passa com ele (20,7 s). No CI ele liga sem commit pela variável de repositório `DECUPA_E2E_MOTOR=sintetico` (passo a passo em `docs/lancamento-studio.md`). Só deve ser ligado se o render real quebrar no CI, com registro no PR.

## Não medido aqui (passo humano)

- **Preparação** (transcrição e análise visual) com os modelos reais. Neste host e no CI não há os modelos de fala e visão, e instalá-los exige rede e vários GiB num disco abaixo da margem. Medir numa máquina com `node scripts/setup.mjs` completo, com uma cópia de Projeto real, e registrar o tempo por hora de material.
- Ingestão por R2/Drive e com rede real.
- Medidas de desempenho no hardware de quem vai usar (notebook comum), além desta VM.

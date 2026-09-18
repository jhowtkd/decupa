# Aceleração do Decupa — 2026-09-17

> Fonte dos tickets #17–#32. TDD. Gates `pnpm lint` / `typecheck` / `smoke` / `test`.
> PRs pequenos contra `main`. Sem commit direto na default branch.
> Código em inglês; este spec em pt-BR.

## Problema

O pipeline já corta por unidade (`u001`) e não por timestamp inventado. O que
ainda dói no lote é espera: transcrição que recarrega modelo a cada arquivo,
análise que refaz o que o cache já tem, FFmpeg e rede brigando pela mesma vaga,
prévia que re-renderiza metadado, e um LLM de estrutura chamado mesmo quando o
catálogo fechado já tem o candidato.

Esta aceleração não inventa um editor novo. Ela coloca um chão compartilhado
(traço, fila, cache, coordenador) e depois encaixa mídia e decisão em cima.

## Invariantes

- IDs de unidade, nunca tempo inventado pelo modelo.
- Segredo fora de log, traço, erro e payload.
- GPU nunca é escolhida sozinha (`auto`/`gpu` → CPU).
- Replay com artefato aquecido faz 0 chamadas.
- Cancelamento mata só o subprocesso/tarefa dono do sinal.
- Presets GLM / Z.ai / Gemini / MiniMax intocados.
- TypeSafe desligado por padrão; CI sem chave real.

## Arquitetura

```
fonte
  ├─ @decupa/trace          B1  tempos de estágio, sem conteúdo
  ├─ @decupa/queue          B2  limite visível, não processos extras
  ├─ @decupa/cache          B3  publicação atômica (Windows EPERM incluso)
  ├─ @decupa/coordinator    B4a um build por (id, estágio)
  ├─ @decupa/bench          B4b lotes 1/5/20, cenários reais
  ├─ mídia
  │    seek visual          M1
  │    pools FFmpeg/rede    M2
  │    áudio sem waveform   M3
  │    reuso por hash+fim   M4
  │    SpeechWorker         M5  um `worker.py --serve`
  │    prévia + hardware    M6
  └─ decisão
       @decupa/typesafe     D1  SystemOne choice/noul
       catálogo fechado     D2  candidatos auditáveis
       rota off/observe/hy  D3  substitui structure, não precede
       calibração offline   D4  eval humano, categorias bloqueadas
       decision.json        D5  opt-in; desligar o Jev não desfaz mídia
```

Inspect visual e geração de cenas continuam nos provedores atuais em qualquer
rota.

---

## B1 — Traços (#17)

`@decupa/trace` emite duração de estágio (ingest, analyze, preview, export)
sem texto, path de usuário ou chave. Um sink de teste captura linhas; o
formato de log existente não ganha conteúdo privado.

## B2 — Fila limitada (#18)

`@decupa/queue` (`LimitedQueue`) limita trabalho in-flight. Espera além do
limite cresce `maxWaiting`, não processos nem RSS. `limit=1` é o legado serial.

## M1 — Seek eficiente (#19)

Janela visual pede só o intervalo necessário. Três seeks no mesmo hardware
não recarregam o arquivo inteiro. Prepare interrompido (fonte some depois de
save funcional) não deixa o projeto em `running`.

## B3 — Cache atômico (#20)

Publicação é rename atômico. No Windows, `EPERM` no destino aberto entra em
retry, não em truncate a meio. Leitura nunca vê arquivo parcial.

## M3 — Áudio sem waveform (#21)

Estágio de áudio não bloqueia no desenho da waveform. Prepare/edit concorrente
espera o áudio ficar pronto, não o canvas.

## M2 — Concorrência visual (#22)

Dois orçamentos: FFmpeg e rede. Janela à espera de API não segura vaga de
encode. Replay aquecido: 0 chamadas. 429/529 com jitter, sem rajada. Resposta
atrasada não pisa revisão nova. `AbortSignal` → `terminateTree` só daquela
chamada.

## B4a — Coordenador (#23)

`FileCoordinator`: um `build` por `(id, stage)`. Segunda passagem no mesmo
arquivo+estágio é replay, não retrabalho. Prepare e analyze não se atropelam
no mesmo path.

## B4b — Benchmark de lotes (#24)

`decupa bench --input` exige arquivos reais. Manifesto com `caseId`, hash,
cenário, hardware, vazão, p50/p95, RAM de pico, falhas explícitas, tamanho da
amostra. Cenários:

- `cold-start` — 1 load por arquivo
- `resident-models` — 1 load compartilhado
- `cached-artifacts` — segunda passagem só lê `.decupa/bench/artifacts`

Saturação cresce a fila visível, não processos. 20 tarefas terminam ou falham
com id. Nenhum comando fictício apresentado como benchmark.

## M4 — Reuso de análises (#25)

Análise reutiliza por hash do media + propósito. Projeto diferente, mesma
fonte, mesmo propósito: 0 rebuild. Propósito diferente: rebuild.

## M5 — Worker de fala residente (#26)

Um processo `worker.py --serve` (JSON por linha). `transcribe.py` continua
sendo o CLI de processo único (`decupa condense-prep`).

- 2 arquivos → 1 `load_model` por chave `(model, language, compute, device)`
- idioma/config diferente → outra entrada
- stdout é protocolo; logger WhisperX vai para stderr
- cliente TypeScript correlaciona **somente** por `taskId`; linha sem id ou
  não-JSON não rouba waiter
- `cancel` é sticky até a tarefa começar; não devolve resposta de outra
- `preload` + `benchmark` transcrevem wavs inéditos com modelos já carregados
  (`modelLoads == 0`), não replay de cache
- CPU por padrão; `cuda` explícito tenta e cai para CPU

## M6 — Prévia reutilizável e hardware (#27)

Chave de cache: montagem canônica + fontes + perfil de hardware. Corte
efetivo invalida; mudança só de metadado faz 0 renders. Encode de prévia
prova o perfil com áudio (`-c:a aac`, sync A/V real, sem `-an`). Compara cor,
orientação, resolução, sincronismo e precisão do corte. Export final copia o
MP4 assistido.

## D1 — Adaptador TypeSafe (#28)

`@decupa/typesafe`: `POST https://api.typesafe.ai/v1/systemone`, Bearer,
`jev-latest`. 401/422 sem retry; 429/529 com jitter no orçamento. Escolha
inventada e probabilidade inválida rejeitadas. `noul = 0.51` **não** autoriza
corte (`authorizesCut` só com `noul > 0.51`). `isTypeSafeEnabled()` é `false`
por padrão. `TYPESAFE_API_KEY` vazio no Vitest e no CI.

## D2 — Catálogo fechado (#29)

Candidatos só das heurísticas existentes. Casos: prefixo, sufixo, retomada,
negação, número, ressalva, proteção, troca de locutor, lacuna. `unitIds`
conhecidos; `replacement` nunca é id descartado; ausência de candidato ≠ fonte
limpa. IDs determinísticos. CLI grava `catalog.json` ao lado da triagem, sem
texto privado. A matriz de casos é assertada no dump, não só no builder.

## D3 — Roteamento (#30)

`off` / `observe` / `hybrid`. A rota rápida **substitui** a chamada `structure`
anterior; fallback do legado roda **uma** vez sobre o mesmo estado.

- `off` reproduz o keep-list legado
- fonte resolvida: 0 `structure`; não resolvida: exatamente 1
- claims reconstruídas passam nos validadores; protegidos nunca saem
- circuit breaker em indisponibilidade; tempo total da rota no traço
- inspect e cenas nos provedores atuais

Hybrid com cliente TypeSafe aplica só noul acima do limiar; payload sem texto
privado e sem chave.

## D4 — Calibração editorial offline (#31)

Corpus crítico com julgamento humano independente, separado de eval, por
vídeo/projeto. Casos: condição removida, negação, “pode”×“é”, número diferente,
retomada, repetição intencional, pergunta sem resposta.

Relatório: remoção incorreta, omissão, abstinência, fallback, trabalho humano.
`enabledCategories` começa vazio; só libera categoria com 100% correto no eval.
Concordância entre modelos não conta como verdade. `decupa calibrate` percorre
o catálogo (`routeCorpusCase`); candidato fantasma falha.

## D5 — Config opt-in e desligamento seguro (#32)

`.decupa/decision.json` separado do gerador. Casos: config ausente, API não
autorizada, chave redigida, modo inválido, modelo indisponível, desligamento.

- `observe` não consome API ao abrir o app
- projeto abre com a feature desligada
- log: provedor / modelo / tempo / fallback — sem conteúdo
- `hybrid` → `off` no mesmo projeto volta ao legado, sem chamada TypeSafe, e
  **não** desfaz seek visual nem cache atômico
- CI com chave vazia e transportes fake

CLI `decupa triage` lê a config do projeto; `--route` continua podendo forçar.

## Ordem de merge

Independentes após o chão já em `main` (B1, B2, M1, B3, B4a, M3, M4):

1. D1, D2, M2, M5, M6, B4b
2. D3 e D4 (precisam de D1+D2)
3. D5 (precisa de D1+D3)

## Fora de escopo

Tickets ICE #6 / #9 / #10 (onboarding, cartão de entrega, empty state).
WhisperX real no CI (modelos não são baixados; sidecars usam mock).
Chamada TypeSafe real (transportes fake; chave vazia).

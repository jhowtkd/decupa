# Evidência: renderização acelerada e limitada no Mac (2026-09-20)

Plano: `docs/superpowers/plans/2026-09-20-renderizacao-mac.md`.
Commits: `fix: honor hardware encoder in assembly rendering` (T1),
`perf: render assembly in bounded sequential intervals` (T2),
`fix: bound local media work and cancel render descendants` (T3),
`test: verify bounded Mac render and approved export integrity` (T4).

Ambiente: macOS 27.0, ffmpeg 9.0.1 (h264_videotoolbox + libx264),
Python 3.14.7, Node v26.7.0, RAM 16 GB → teto do ensaio 4 GiB.
Sem dependências novas, sem chamadas externas, sem benchmark sem limites.

## 1. Testes automatizados

- `pnpm vitest run apps/cli/src/app/assembly/hardware.test.ts
  apps/cli/src/app/assembly/media.test.ts apps/cli/src/app/assembly/render.test.ts
  apps/cli/src/app/assembly/preparation.test.ts tests/assembly-delivery.test.ts`
  → 224 passed, 0 failed.
- `python3 -m unittest discover -s scripts -p 'test_render_resources.py'` → 9 OK.
- `pnpm typecheck` → limpo. `git diff --check` → limpo.
- Cobertura nova: posição de `-hwaccel`, prova silenciosa, fallback sem
  parcial, invalidação de `profile.json`/`previewIdentity`, intervalos ≤5s e
  ≤2 entradas/comando com fonte original, rejeição de sobreposição V1/V2+,
  offsets com speed, render 12s fracionário com portrait VFR+rotação, fila
  única (pico 1), cancelamento sem lançar FFmpeg, morte de árvore Python,
  escalada SIGKILL, export idêntico à prévia aprovada com OTIO nos originais.
- Ruído pré-existente, fora do escopo: worktrees obsoletos em
  `.muse/worktrees/` falham na coleta do vitest (pacote ausente); nenhum
  teste real é afetado.

## 2. Encode de hardware comprovado

- Prova real (`proveHardwareEncode`, 2s, saída 640px): VideoToolbox ativo
  após encode válido; `profile.json` em `{"profile":"videotoolbox","version":2}`.
- Ponta a ponta 10s sintético (320x240, V1+V2+A1, portrait VFR com SEI-180):
  `renderAssembly(profile videotoolbox)` → MP4 válido, sidecar
  `videotoolbox` (sem fallback = encode real de hardware).
- Fallback explícito (falha VT injetada no motor): relatório
  `requested h264_videotoolbox / effective libx264 / fallback true`,
  workdir novo `fallback-software/`, MP4 válido idêntico em duração/frames.
- Detecção em mídia real (ritmo-045, H.264/AAC portrait VFR):
  `{"profile":"videotoolbox","version":2}`.
- vaapi não é anunciado: o motor não implementa o setup de device que ele
  exige; `encoderFor` mantém o mapeamento, a detecção tenta só
  videotoolbox/nvenc.

## 3. Recursos medidos (`scripts/render-resource-proof.py`)

Teto do ensaio: min(4 GiB, RAM/4) = 4 GiB; amostra da árvore via `ps` a cada
500 ms; interrupção com SIGTERM + SIGKILL após 2 s. Validação do script:
filho `sleep(2)` (exit 0, 4 amostras), teto de 1 byte (interrompido em 0,1 s,
exit -15), Ctrl+C (interrompido, grupo morto).

| Ensaio | wall | pico RSS | CPU máx/méd | exit | interrompido |
|---|---|---|---|---|---|
| 10 s sintético VT (320x240, 250/250 frames) | 2,1 s | 163 MB | 31 / 11 % | 0 | não |
| 10 s fallback libx264 (falha injetada) | 1,0 s | 43 MB | 43 / 22 % | 0 | não |
| 10 s real VT (540x960, 300/300 frames, AAC) | 3,1 s | 219 MB | 59 / 18 % | 0 | não |

Resultado AV da amostra real: 540x960 h264, 10,00 s de vídeo e áudio,
300 frames exatos (sem erro acumulado no concat), áudio não silencioso
(pico 5094), originais intactos (hash antes/depois iguais), swap inalterado
(antes = depois). Máximo estrutural: 5 intervalos, ≤2 entradas de vídeo por
comando, áudio global mixado uma vez. Nenhuma comparação com versão antiga
sem limites foi executada, conforme o plano.

## 4. Avaliação humana

- Responsividade do macOS durante a amostra real de 10 s: confirmada pelo
  usuário como responsiva, sem congelamento/travamento perceptível.
- A montagem completa do usuário NÃO foi executada: ampliação além da
  amostra de 10 s aguarda decisão do usuário em outra sessão.

## 5. Revisão do usuário (mesmo dia) — 3 correções aplicadas

- P1, render enfileirado após cancelar: `preparation.ts` e a rota manual de
  `routes.ts` agora repassam o `AbortSignal` ao `renderAssembly`; a rota de
  prévia ganhou controller próprio (`beginPreview`, sem derrubar a anterior
  — paralelas seguem ambas 200) e o `/cancel` aborta todas as prévias vivas.
  Testes: cancelamento pela rota e pela preparação com a fila ocupada
  (zero lançamentos python3/prova, operação `cancelled`).
- P1, monitor encerra a árvore inteira: `terminate_tree` aquieta com
  SIGSTOP até estabilizar (parado não forka), depois TERM+CONT, espera e
  KILL com re-enumeração — cobre sessões próprias (SpawnExecutor) e forks
  tardios. Validado 3/3 com descendente `setsid` (0,2 s, zero
  sobreviventes, processo alheio intacto); normal e Ctrl+C revalidados.
- P2, falha de medição: `ps` ausente ou com exit ≠ 0 levanta
  `MeasurementError`; o ensaio é interrompido, a vítima encerrada e o JSON
  registra `measurement_error` (nunca zero limpo). Validado com `ps`
  retornando "permission denied" e com `ps` ausente do PATH.
- Re-verificação: escopo 411/411, `typecheck` limpo, unittest 9/9.

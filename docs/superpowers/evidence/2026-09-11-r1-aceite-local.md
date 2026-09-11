# R1 — aceite local independente

Data: 2026-09-11. Base `2b4300cafad46b5f70d8a0404329a58e03f5b23f` mais alterações não commitadas. **R1 aprovado no escopo revalidado. R2–R4 permanecem aprovados conforme a rodada anterior.**

Este relatório encerra a pendência de união do cache registrada em `2026-09-11-revalidacao-cobertura-visual.md`. Não equivale ao aceite final com mídia real e DaVinci.

## Evidência observada

- Suíte completa, fora do sandbox: `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts` — **148/148 testes, 16/16 arquivos, exit 0**.
- `pnpm typecheck` — **PASS**, exit 0. `git diff --check` — PASS.
- Harness independente que reproduzia a falha anterior: primeira resposta 0–2s; segunda somente 2–3s. Ambos os trechos sobreviveram, com IDs `fala:w0:0` e `fala:w0:0~1`, cobertura completa e textos preservados. A terceira chamada à função retornou o mesmo catálogo sem chamar o provedor novamente. Asserts passaram.

## Percurso no navegador

Mesmo cenário da reprovação anterior, usando dois vídeos sintéticos válidos de 3s, clientes de áudio/modelo controlados e FFmpeg/motor reais. Nenhuma API externa foi chamada.

1. **Preparar montagem:** fala com cobertura completa; apoio com 0–2s. UI mostrou interrupted, 5/6 etapas, apoio visual pendente. Estado persistido confirmou zero cenas, zero propostas/renders e nenhuma prévia.
2. **Retomar:** o provedor devolveu somente 2–3s para o apoio. O cache completo da fala foi reutilizado. O apoio manteve `apoio:w0:0 [0,2)` e acrescentou `apoio:w0:0~1 [2,3)`; `missing=[]`.
3. Sem outro clique, o fluxo chegou a **ready, 6/6 etapas, uma proposta, uma cena e uma prévia**, revisão 1. Foram três chamadas visuais controladas ao todo: duas iniciais e uma na retomada; um render e uma proposta.
4. O player carregou `/project/output/1/mp4`, readyState=4, duração 1,2s, canvas 320×240 a 25fps. Recarregar a página preservou a revisão/prévia e o estado pronto, sem nova chamada visual.

O teste isolado comprova a terceira leitura do cache. Não foi necessário pedir outra proposta para provar reutilização visual; uma proposta enlatada repetida não representa um ajuste editorial real.

## Registro e limites

Evidências, scripts e logs: [work/revalidation-r1-final-20260911](</Users/jhonatan/Repos/Video editor/work/revalidation-r1-final-20260911>). Snapshot do diff de implementação: SHA256 `42013a9a2f95b9b15c1ab6113d0d4431aa2155c57d10bffb8c49eeeec1c0e0dd`.

Nenhum código do produto foi alterado por esta revisão. Sem commit/push, uso pago ou alteração no projeto Feira. O cenário de QA foi encerrado após a coleta.

**Sem novos achados no escopo desta correção.** Continuam pendentes os gates já registrados: edição/correção com alinhador real, percurso Feira/Z.ai e importação da entrega final no DaVinci. As provas sintéticas acima não demonstram qualidade editorial, reconhecimento de fala real ou aprovação visual final.

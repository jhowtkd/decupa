# Análise visual mais rápida — evidência (2026-09-21)

Método, verificação offline e pedido de autorização do piloto. Decisão de
promoção: **pendente** (aguarda Step 5, piloto pago autorizado).

## 1. O que foi implementado (Tasks 1–3, offline, sem chamadas pagas)

- Task 1: telemetria por janela (`VisualMetric`: extract/request/total, fila,
  tentativas, cache-hit) e propagação de `AbortSignal` ao FFmpeg.
- Task 2: perfil opt-in `compact` (default `baseline`): prompt por intervalos
  + `normalizeCompactSpans` em células de até 1s, sem fundir de novo e sem
  inventar fim fracionário; IDs posicionais por célula.
- Task 3: caches isolados por identidade SHA256
  (`visual-v4`, providerKey sanitizada, modelo, perfil, prompt v3, 1 fps,
  480px) em diretórios próprios; sem identidade, sem cache persistente;
  temporários com `randomUUID`; envelope sem segredos.

## 2. Ensaio isolado (Task 4, `scripts/visual-analysis-proof.ts`)

Um braço por execução sobre cópia do projeto (amostra ≤60s, trava antes de
qualquer chamada). Nunca escreve `project.json` (hash antes/depois;
divergência aborta). Sem `--allow-paid`: só inventaria e imprime o pedido
(saída 2, zero rede). Concorrência de produção: extração 2, rede 2.

Regras do ensaio (decisões documentadas onde o plano era omisso):

- `sparse`: descrição compacta, subamostra (passo 3) só `role=speech`;
  `support`/`both` seguem a 1 fps. Só no relatório, nunca em cache/projeto.
- `two-pass`: passada geral esparsa + detalhe a 1 fps das janelas sugeridas.
  Sugestão padrão: janela cujo panorama contém `uncertain` declarado pelo
  modelo (revisável no piloto). Custo soma as 2 passadas; a 2ª reutiliza os
  frames da 1ª em memória.
- Braços orquestrados no script usam tentativa única; resposta inválida
  falha a medição (não é dado). `baseline`/`compact` via `describeSource`
  mantêm reparo initial+1; eventual reparo aparece em sends/tentativas e a
  comparação anota a assimetria.
- `low-effort`: `not-run` — o transporte não expõe `reasoning_effort`;
  executar exige confirmar suporte na documentação oficial (Step 5), sem
  trocar modelo ou endpoint.

## 3. Verificação offline (Step 4, sem rede)

- `scripts/visual-analysis-proof.test.ts`: 9/9 — seleção determinística
  (`[19,22,24]`, identidade passo 1, vazio), sem-flag com zero chamadas e
  pedido concreto, two-pass contabilizando ambas (sends 3, passes `[2,1]`),
  sparse 2+3 frames por papel, baseline/compact (2/6 spans), low-effort
  `not-run` sem chamadas, teto 60s recusado antes de qualquer chamada,
  uso inválido. Todas comparam hash do `project.json` antes/depois.
- Tipos do script: `tsc` limpo (config temporária estendendo a do repo;
  `tsconfig.json` não inclui `scripts/`).
- Regressões: model/frames/broll/preparation/routes/server/provider-setup
  verdes; `pnpm typecheck` e `pnpm lint` limpos.

## 4. Corpus do piloto (Step 5, pendente)

Condições exigidas pelo plano, a identificar em leitura local do material
real antes de comparar (registrar ações essenciais com tempos):

- [ ] entrevista estática
- [ ] ação breve em cena estática
- [ ] mudança de plano
- [ ] vídeo vertical
- [ ] trecho final fracionário

Se faltarem essas condições no material acessível: evidência insuficiente,
sem promover novo default.

## 5. Pedido de autorização do piloto (Step 5, NÃO executado)

- Escopo: 5 braços × mesma amostra ≤60s × 3 repetições, em cópia com caches
  próprios; rep 1 fria, reps 2–3 quentes; nunca comparar quente com frio.
- Registrar por execução: wall total, queue/extract/request, tentativas
  HTTP, tokens reais (se retornados), cache frio/quente, frames enviados,
  ações essenciais recuperadas, avaliações humanas de apoio.
- Estimativa de chamadas: impressa pelo script sem flag
  (`--project CÓPIA --out R --arm BRAÇO`, sem rede).
- Critério de aceite: mediana do tempo total cair ≥20% sem perder nenhuma
  ação essencial nem aumentar referências inválidas → promover só `compact`
  a default e rerodar regressões. Caso contrário baseline segue padrão;
  sparse/two-pass/low-effort ficam experimentais com decisão documentada.

## 6. Revisão pré-piloto — 2 correções aplicadas

- P1, `--out` podia sobrescrever o projeto: a verificação de hash ocorria
  antes da escrita, e `low-effort` escrevia sem chamar API. Agora `--out`
  sobre caminho existente (arquivo, diretório, symlink ou hardlink —
  `lstat` enxerga o próprio link) recusa com saída 1 antes de qualquer
  leitura, chamada ou escrita, em todos os braços. Verificação por hash
  mantida como segunda barreira.
- P2, esparso declarava 1 fps e aceitava `observed` sem imagem: novo
  `VISUAL_PROMPT_SPARSE` (amostragem a cada 3s, `observed`/`uncertain`
  só em segundos com imagem) selecionado por papel (`speech` amostrado,
  `support`/`both` densos com prompt de 1 fps), mais
  `constrainSpansToSampled` restringindo os spans aos segundos enviados
  (lacuna onde não há imagem; identidade em passada densa). Vale para
  `sparse` e para a 1ª passada do `two-pass`; detalhe denso substitui o
  panorama. Prompt é override de `frameMessage`, sem novo perfil de
  produção.
- Re-verificação: 144/144 nos 8 arquivos afetados, `typecheck` e `lint`
  limpos, tipos do script validados. Sem chamadas pagas; ganho de
  velocidade segue sem comprovação real (aguarda Step 5).

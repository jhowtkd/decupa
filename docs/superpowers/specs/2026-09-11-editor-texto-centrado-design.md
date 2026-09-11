# Decupa — editor texto-centrado para a montagem

Data: 2026-09-11
Estado: design aprovado em conversa; emendado após revisão externa verificada
contra o código (2026-09-11). Aguardando revisão final do usuário.

## Objetivo e decisões aprovadas

Substituir a tela atual de montagem (`decupa montar`) por um editor onde a
transcrição é a timeline. A reclamação que originou este design foi tripla:
não há mapa do fluxo, as ações moram longe do que editam, e nada na tela
lembra uma ferramenta de edição. O design ataca as três juntas.

Decisões tomadas em conversa, na ordem:

1. **Escola Descript/texto-centrado.** O texto domina a tela; trechos
   riscados são cortes; playhead percorre as palavras. O "parecer editor"
   vem das affordances (playhead, scrubbing, waveform, cortes inline), não
   de blocos arrastáveis. Escolas timeline-de-blocos (CapCut) e NLE
   (DaVinci) foram rejeitadas: a primeira joga fora o diferencial de editar
   lendo, a segunda já existe no fim do pipeline.
2. **Editor único como destino, em duas etapas.** Etapa 1 (este design):
   redesenhar a montagem sobre uma shell que sirva para as duas
   experiências. Etapa 2 (futura, sem data): a limpeza migra para dentro da
   mesma shell como projeto de uma fonte. Os motores atuais não são
   reescritos; o que muda é a interface que os orquestra.
3. **Estrutura "projeto na lateral, texto no centro".** Rail esquerdo
   carrega o fluxo inteiro (materiais, briefing, preparação, entrega); o
   centro é sempre o texto editável; painel direito de contexto; faixa de
   sequência embaixo. Nenhuma mudança de página: os estados acontecem ao
   redor da edição.

Este design mantém a restrição do spec de montagem multiarquivo
(2026-09-11): não construir um editor generalista. Um editor orientado a
texto é o oposto de generalista — é a tese do produto.

## Supersessão

O spec de fluxo automático (2026-09-11) aprovou a direção visual A — vídeo
à esquerda, texto à direita, cabeçalho, fundo claro. **Este documento a
substitui na parte de casca/leiaute**: a tela de montagem passa a ser a
descrita aqui (texto-centro, sem header, rail permanente). Não supersede
nada além disso: os motores, o OTIO, o prepare automático, a revisão por
proposta e o fluxo da limpeza daquele documento continuam vigentes.

## Relação com o que existe — corrigido pela revisão

O que a API já tem (verificado em `assembly/words.ts`): `/edit` cobre
`remove`, `restore`, `protect`, `unprotect`, `correct`, `include`,
`move-scene`, `delete-scene`. Reordenar cena **já existe** — nenhuma rota
nova para isso. Frescor de prévia, entrega trancada, exportApproved que
copia o MP4 assistido e falha-isolada-retomável por arquivo (markSource +
interrupted + barreira de progresso) existem no back-end; a UI nova os
expõe em vez de reimplementar.

O que a API **não** tem — e este design exige:

1. **Recompilação pós-edição (bug, bloqueante).** `applyTextEdit` só
   invalida a prévia; `compileScenes` roda apenas em `applyProposal` e
   `applyHistorySnapshot`. A rota de preview e o export renderizam
   `project.assembly` direto — após qualquer corte por palavra,
   reordenação ou inclusão, prévia e OTIO refletem tracks antigos. Para um
   editor cuja tese é "o texto é a timeline", texto e timeline divergindo é
   fatal. Correção obrigatória antes ou junto da primeira entrega da UI:
   recompilar o assembly dentro de `applyTextEdit` (exceção possível:
   `correct`, que é overlay de grafia e não move mídia) + teste de
   contrato edit → preview → export refletindo corte e ordem nova. Os
   testes atuais não pegam o bug porque `assembly-flow.test.ts` nunca faz
   `/edit` antes de `/preview`.
2. **Peaks de waveform** (seção Organização técnica).
3. **Semântica de edição concorrente à preparação** (seção Falhas).

Fora disso: `takes[]` é fala ordenada (`SpeechTake`), não alternativas de
retake — a UI não promete troca de tomada por clique. Não existe ação de
edição de apoio no `EditAction` — ver Interações, item 5.

O trio `assembly/page.html|css|js` é substituído de forma **incremental**
(ver Organização técnica). `decupa limpar` e a tela de prosa permanecem
intocados nesta etapa.

## A tela do editor

Quatro regiões fixas, do primeiro ao último momento do projeto:

- **Rail (esquerda):** o projeto e seu fluxo. Materiais com estado por
  arquivo (transcrito, analisando %, fila, falha) e as ações por fonte que
  o spec de montagem exige: categoria **Fala/Apoio/Ambos**, incluir e
  excluir da montagem, relink de mídia ausente, "continuar sem esta
  fonte", lacunas. Briefing (tipo, texto, duração alvo) e o cartão de
  entrega. É o mapa permanente — responde "onde estou" sem trocar de tela.
- **Centro (o texto):** dois documentos, um por fase do projeto. Durante a
  preparação, o centro mostra a **transcrição por fonte** (documento
  fonte), legível conforme fica pronta, com marca de "parcial". Após a
  proposta, o centro passa a mostrar a **prosa de montagem** (documento
  resultado): blocos de cena com cabeçalho discreto (nome, duração,
  controles), trechos mantidos em destaque, cortados riscados mas legíveis,
  chips de apoio inline no ponto da fala onde entram, playhead atravessando
  as palavras. A troca de documento é explícita na tela, nunca silenciosa.
- **Contexto (direita):** player da prévia com transporte, propriedades da
  cena selecionada (fala selecionada, duração, justificativa, apoio) e o
  pedido em linguagem natural.
- **Faixa de sequência (embaixo):** blocos proporcionais por cena e apoio
  sobre um waveform do resultado, transporte (play, tempo, desfazer). É
  bússola, não ferramenta de edição.

Não existe header global. O nome e o estado da operação em curso
("preparando", "renderizando…") vivem no rail, no contexto do que os causa.

## Interações de edição

O mesmo alvo — a palavra — recebe gestos distintos, e a regra é explícita
para o implementador não inventar:

1. **Clique simples em trecho mantido = seek.** O playhead posiciona ali e
   reproduz dali, na posição correspondente da montagem. O texto é o meio
   de navegação.
2. **Seleção de trecho (arraste sobre as palavras) = menu de ações**
   flutuante no ponto: ouvir · tirar · preservar · corrigir (e incluir, no
   trecho fora da montagem). A barra de ações global da tela atual é
   extinta. "Ouvir" toca o trecho **na fonte original, com contexto** ao
   redor — não na posição da montagem.
3. **Clique em trecho cortado (riscado) = restaurar**, sem seek — o trecho
   volta à montagem. Riscado legível é decisão nova desta tela (tese
   Descript): a limpeza colapsa a unidade em marcador de propósito, para a
   pessoa não continuar lendo o texto cortado; na montagem, ver o cortado
   no fluxo é parte do trabalho.
4. **Cena é bloco de texto com cabeçalho.** Reordenar pelos controles ↥↧
   do cabeçalho (rota `move-scene` existente) e por pedido em linguagem
   natural; excluir cena no cabeçalho. Drag-and-drop de blocos fica fora
   de escopo — caro e frágil para o ganho.
5. **Apoio visual é chip inline** na fala, no ponto onde entra. Posição e
   duração aparecem no painel de contexto como leitura; **nesta etapa,
   mudança de apoio é por pedido em linguagem natural** — não existe
   contrato de edição de apoio (`move-support`/`resize-support`) e ele não
   é criado aqui. Promessa sem rota foi erro da versão anterior deste
   documento.
6. **Faixa de sequência navega, não edita:** clique busca (seek), arrastar
   faz scrub, o bloco aceso acompanha a cena atual. Reordenar não acontece
   na faixa.
7. **Prévia tem estado de frescor visível:** "atualizada ✓" ou
   "desatualizada — atualizar", incluindo durante o debounce de
   auto-prévia. "Assistida até o fim" é estado do player rastreado de
   verdade (timeupdate/ended no cliente); o back-end já só confia em
   `watchedRevision` — o front atual mente enviando `previewRevision` no
   clique. Aprovação refere-se apenas à prévia assistida até o fim; editar
   desatualiza.
8. **Entrega trancada até a aprovação:** o cartão de entrega do rail só
   libera depois de assistir a prévia atual até o fim e aprovar. Os botões
   de exportação moram nesse cartão, não no header.

## Estados do fluxo

O rail e a faixa existem do começo ao fim; só o centro muda de documento:

- **Vazio:** dropzone ocupa o centro inteiro; rail mostra só briefing e o
  convite a soltar mídias.
- **Preparando:** rail lista cada arquivo com seu estado e ações; o centro
  exibe a transcrição por fonte, marcada "parcial". Falha de arquivo é
  vermelha no rail com "retomar" próprio, isolada dos demais.
- **Editando:** a prosa de montagem — o estado principal, descrito acima.
- **Entrega:** cartão no rail com os artefatos (timeline DaVinci, vídeo de
  referência), mídias ausentes apontadas por arquivo, e o download.

## Pagos e privacidade — corrigido pela revisão

As permissões de projeto são **opt-in persistente e monotônico por design**
(`withGrantedPermissions` nunca revoga; `permissions.model/visual` são
booleanos do projeto). A UI é honesta sobre isso:

- A confirmação explícita acontece **no disparo do lote de preparação**
  (quais arquivos, custo, fato de a mídia ser enviada) e de novo no
  retomar isolado de um arquivo — não por arquivo durante um prepare de um
  clique, o que quebraria o fluxo automático aprovado no mesmo dia.
- Após o opt-in, a UI mostra "já autorizado" com o que isso implica; não
  encena confirmação por chamada que o back-end não faz.
- O bloqueio 402 por chamada sem permissão continua, com testes.

Mantém-se o padrão do spec de montagem: confirmar custos e envio antes de
qualquer chamada paga; flags de CLI continuam sendo só autorização de
cliente.

## Falhas e preservação do trabalho

- **Falha de arquivo é isolada e retomável** (já garantido no back-end);
  agora visível no rail, não numa tabela.
- **Editar durante operação não trava o texto** — incluindo durante a
  preparação. Hoje o save da preparação captura a revisão e morre em 409
  genérico se uma edição passar na frente (CAS do `mutate`). Requisito
  deste design: o conflito resolve **sem perder trabalho e sem erro
  genérico** — a preparação salva o que produziu e a edição permanece, ou
  a preparação aborta como retomável. A semântica exata (revalidar sobre a
  revisão nova vs. abortar graciosamente) é decisão obrigatória do plano
  de implementação, com teste de edição concorrente.
- **Prévia em render mostra "renderizando…" mantendo o último vídeo
  válido no player** (comportamento V4 da tela atual, preservado), com o
  chip de frescor indicando o estado durante o debounce.
- **Desfazer na faixa de transporte:** ⎌ discreto e atalho Cmd/Ctrl+Z,
  desabilitado quando não há nada para desfazer. Sem painel próprio.
- **Erro de entrega aparece na entrega:** mídia ausente ou incompatibilidade
  de intercâmbio no cartão do rail apontando o arquivo — nunca como alerta
  global descontextualizado.

## Organização técnica

Front-end reescrito em módulos ES vanilla, servidos direto, sem build e
sem framework — o padrão de entrega que o repo já usa (`keeplist.js`).

**Migração incremental, não big-bang.** O `page.js` atual tem ~1200 linhas
com máquinas de estado já debugadas (auto-prévia com debounce V4, polling
de correção pendente, prévia anterior mantida durante render,
reconciliação de 409 R2, preservação de foco/seleção V8). O plano de
implementação migra por módulos com checklist de paridade desses
comportamentos — não descarta e reescreve às cegas:

- `editor/state.js` — estado do cliente (projeto, seleção, playhead,
  foco), com assinatura por região: cada painel re-renderiza quando o que
  lhe interessa muda.
- `editor/rail.js`, `editor/texto.js`, `editor/contexto.js`,
  `editor/sequencia.js` — as quatro regiões.
- `editor/api.js` — chamadas às rotas existentes.
- Lógica pura (keeplist por cena, posição do playhead no texto, frescor
  da prévia, mapeamento palavra↔tempo) em módulos próprios, testáveis no
  vitest. Onde a mesma lógica já existir em TS e JS
  (`effectiveWords`, `retainedRanges`), o teste de paridade trava as duas
  cópias juntas.

O servidor de `decupa montar` hoje só entrega `page.html|css|js`; passa a
servir os módulos de `editor/` (mesmo mecanismo, sem build).

Back-end recebe três peças:

1. **Recompilar o assembly em `applyTextEdit`** (o bug da seção "Relação
   com o que existe") com teste de contrato edit → preview → export.
2. **Peaks de waveform por fonte** na etapa media da preparação, gerados a
   partir **do proxy** (não do original), best-effort: falha de peaks
   nunca bloqueia transcrição, proposta ou prévia. Formato, resolução e
   invalidação por sha são decisão do plano. O cliente compõe o waveform
   da faixa recortando peaks por intervalo retido — o resultado nunca é
   reanalisado para desenhar a faixa; apoio não entra no waveform de
   áudio.
3. **Semântica de edição concorrente à preparação** (seção Falhas), com
   teste.

Nenhuma rota de reordenação nova: `move-scene` existe. Sem novo servidor,
serviço ou dependência. Mesma rota e porta de entrada (`decupa montar`).

## Testes

- Teste de contrato edit → preview → export (pega o bug da recompilação;
  hoje nenhum teste cobre `/edit` antes de `/preview`).
- Teste de edição concorrente à preparação (CAS 409 vira retomável, sem
  perda de trabalho).
- Teste do tracking de "assistido até o fim": aprovação sem `ended` real
  do player é rejeitada.
- Testes de paridade TS↔JS da lógica pura duplicada.
- Rotas novas ou estendidas com testes de contrato, no padrão de
  `routes.test.ts`; `tests/assembly-flow.test.ts` continua valendo.
- Lógica de UI em vitest, no padrão do repo.
- Prova visual final com mídia real, registrada em
  `docs/superpowers/evidence/`, no padrão das evidências existentes.

## Critérios de aceitação

1. Da primeira abertura até a exportação, o usuário nunca muda de página;
   cada estado do projeto (vazio, preparando, editando, entrega) é visível
   no rail e o centro nunca fica sem conteúdo quando há algo pronto —
   transcrição por fonte na preparação, prosa de montagem na edição.
2. Clique em palavra mantida posiciona o playhead e reproduz dali;
   seleção abre o menu de ações no ponto; clique no riscado restaura sem
   seek; "ouvir" toca a fonte original com contexto. O playhead acompanha
   a reprodução e a faixa acende a cena atual.
3. Após qualquer edição por palavra, reordenação, inclusão ou exclusão, a
   prévia renderizada e o OTIO exportado refletem a montagem nova —
   verificado por teste de contrato, não por inspeção.
4. Reordenar cena pelos controles do cabeçalho produz a ordem esperada na
   faixa e no EDL exportado, preservando escolhas aprovadas fora do
   escopo do pedido.
5. Aprovar exige prévia atualizada **assistida de verdade até o fim**
   (tracking de player, não confiança no clique); após qualquer edição, o
   chip de frescor indica desatualização e a entrega segue trancada até
   nova aprovação.
6. Editar durante preparação ou render não perde trabalho: o conflito de
   gravação resolve em retomável, nunca em erro genérico.
7. Nenhuma chamada paga dispara sem a confirmação explícita do lote
   (arquivos, custo, envio); após opt-in, a UI mostra "já autorizado" com
   honestidade; 402 sem permissão continua testado.
8. Falha em um arquivo aparece no rail, é retomável isoladamente e não
   descarta o trabalho dos demais; categoria, incluir/excluir, relink e
   continuar-sem-fonte moram no rail.
9. `decupa limpar` permanece funcionando sem alteração (verificado pelos
   testes existentes).

## Fora de escopo

- Contrato de edição direta de apoio (`move-support`/`resize-support`) —
  apoio muda por pedido em linguagem natural nesta etapa.
- Troca de tomada por clique no painel de contexto (`takes[]` é fala
  ordenada; não há alternativas no modelo).
- Drag-and-drop de blocos de cena (reordenação é por controles e pedido).
- Edição por arrasto na faixa de sequência (ela só navega).
- Migração da limpeza para a nova shell (etapa 2 futura; a tela de prosa
  atual permanece).
- Frameworks, build step, novos serviços ou dependências.
- Mudanças nos motores de análise, triagem, planejamento e render — exceto
  a recompilação pós-edição e as peças listadas em Organização técnica.

Após a revisão deste documento, usar a skill writing-plans para detalhar a
implementação. Nenhuma implementação foi realizada nesta etapa.

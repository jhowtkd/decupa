# Revalidação das correções V1–V8

Data: 2026-09-11. Base: `2b4300cafad46b5f70d8a0404329a58e03f5b23f` mais o diff não commitado do executor. **Aceite final ainda reprovado: quatro achados reproduzidos permanecem.**

Esta rodada não alterou código do produto, não fez commit/push, não chamou Z.ai e não modificou o projeto Feira. Todos os testes de falha usaram cópias sintéticas descartáveis. O diff de implementação e as evidências foram preservados em [work/revalidation-v1-v8-20260911](</Users/jhonatan/Repos/Video editor/work/revalidation-v1-v8-20260911>).

## O que passou nesta rodada

- A suíte de montagem completa, **fora do sandbox**, passou: **144/144 testes, 16/16 arquivos, exit 0**. Comando: `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts`.
- `pnpm typecheck`: PASS.
- Prova real do motor via `scripts/assembly-proof.ts`: **50 frames e primeiro azul no frame 25**, nos dois regimes 25/1 e 30000/1001.
- **V1:** repetir o caso inválido depois de válido agora devolve erro sem substituir a referência boa. Os testes de concorrência válido + inválido também passaram na suíte.
- **V2, cenário de sucesso:** corromper o MP4 exportado e reexportar recupera o SHA256 aprovado. A falha ao gravar a substituta permanece problemática, conforme R4.
- **V3, catálogo:** “Nilton Pinto → João Silva” agora aparece como `João Silva e Tom` na função real da UI, com IDs aceitos pelo servidor para remoção. Este é um fixture sintético, sem afirmação sobre a fala real da Feira. O percurso completo de correção com alinhador real continua sem aceite independente.
- **V4, edição isolada:** remover e restaurar pela UI dispara a prévia automaticamente, conserva a anterior enquanto processa e chega à revisão atual. Não foi necessário clicar Atualizar prévia. A edição concorrente ainda falha, conforme R2.
- **V5, áudio:** o caso de erro de áudio e a retomada passaram nos testes atualizados. A barreira ainda deixa passar erro visual, conforme R1.
- **V6, busca simples:** clicar Tom no fixture posicionou o vídeo em 1s. A inclusão pela UI criou o novo take e a prévia seguinte, mas a edição dessa ocorrência falhou, conforme R3.
- **V7:** estilo claro, fonte sem serifa, nomes de fonte e título “Cena 1” observados no navegador. Isso não constitui o aceite completo em 1280/390px nem aprovação editorial do usuário.
- **V8:** import HTTP com `/var → /private/var` voltou a retornar `source`; os testes de import e lote passaram.

## Achados restantes

### R1 — P1 — V5: a barreira ignora erro/pendência visual

Local: [preparation.ts:335](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/preparation.ts:335>).

O novo filtro valida `state.media`, `state.audio` e `analysis.status`. Não exige `state.visual === ready` para fontes com vídeo nem valida cobertura necessária. Uma falha de `describeClient.send` grava `visual: error`, mas não muda o status da análise de áudio. O runner passa pela barreira e chama proposta/render mesmo assim.

Reprodução: usar os fakes existentes com áudio bem-sucedido e fazer o cliente visual lançar `visual provider unavailable`. Resultado gravado em `visual-failure-results.json`: **duas fontes com visual error, propose=1, render=1, uma cena e previewRevision=1**, terminando em attention. Nenhuma chamada externa ocorreu.

Correção esperada: exigir prontidão de todas as modalidades aplicáveis e da cobertura requerida antes da proposta. Etapa inaplicável deve ser tratada explicitamente. Acrescentar o teste de falha visual com `propose=0` e `render=0`, seguido de retomada bem-sucedida. O teste de falha apenas de áudio não cobre esse requisito.

### R2 — P1 — V4: editar durante render paralisa a atualização automática

Local: [page.js:75](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:75>) e [page.js:90](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:90>).

Foi usado o motor real com uma barreira controlada exclusivamente na chamada de `render-assembly.py`, sem atrasar miniaturas e sem sleeps para decidir a concorrência.

Percurso pelo navegador, em `http://127.0.0.1:53544`:

1. Revisão 1 com prévia válida. Remover Tom cria revisão 2 e dispara o render automático, que fica na barreira.
2. Restaurar Tom antes de liberar o render cria revisão 3. A resposta dessa edição informa operation=rendering.
3. Liberar o render da revisão 2. O servidor recusa sua gravação com 409, pois o projeto já está na revisão 3.
4. A UI permanece em **“revisão desatualizada: base 2, atual 3”**, `prévia null`, exibindo o vídeo da revisão 1 e “atualizando para a revisão 3…”. Não começa um segundo render.

O servidor já estava com operation=ready, revision=3 e previewRevision=null; o navegador reteve operation=rendering da resposta anterior. A resposta 409 não traz projeto/operação, e o reagendamento no finally retorna pela guarda de operação ocupada.

Correção esperada: reconciliar o estado do servidor quando o render termina obsoleto e agendar a revisão mais recente; distinguir conflito por nova edição de erro real de render, sem repetir chamadas em loop. Gate: o mesmo percurso precisa chegar sozinho à prévia 3, com apenas os trabalhos necessários. Evidências: `held-preview.mjs`, `held-preview.json`, `held-preview-result.json`.

### R3 — P1 — V6: palavra reincluída perde a capacidade de edição

Local: [page.js:699](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:699>), em conjunto com `renderOmitted` e a seleção global por wordId.

Percurso real da UI em `http://127.0.0.1:53337`:

1. Remover Tom de um take; aguardar a prévia automática.
2. Abrir “Incluir trecho do original”, que oferece esse Tom removido, e clicar “Incluir seleção nesta cena”.
3. A revisão 5 contém o take antigo com Tom removido e um novo take 1.0s–1.3s com Tom ativo; a prévia 5 fica pronta.
4. Selecionar somente o botão Tom ativo e clicar Remover.

Resultado: **“Selecione palavras de um mesmo trecho.”** Nenhuma edição é feita. `selectedWords` guarda apenas o ID da palavra da fonte; `selectedTake` encontra o mesmo ID nos dois takes e considera ambos selecionados, mesmo que apenas uma ocorrência esteja selecionada na tela.

Correção esperada: distinguir a ocorrência editorial selecionada por cena/take/palavra, preservando a identidade da palavra na fonte. Alternativamente, o fluxo de reinclusão precisa impedir a ambiguidade sem retirar a restauração de palavras removidas. Testar incluir → remover/preservar/corrigir a ocorrência ativa, além de restaurar a antiga.

### R4 — P2 — V2: reparo remove a entrega existente antes de concluir a substituta

Local: [export.ts:192](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/export.ts:192>).

A correção faz `rm(dest, { recursive: true })` antes de criar/gravar a exportação temporária. O lock serializa escritores, mas não protege contra falha de gravação. Se a substituta falha, os arquivos ainda utilizáveis da entrega anterior já foram apagados.

Reprodução em cópia descartável: exportar normalmente, corromper somente o MP4 e manter OTIO/manifest válidos; preparar o diretório temporário do teste sem permissão de escrita; reexportar. Resultado: EACCES ao escrever a nova timeline, **previousOtioStillExists=false e previousManifestStillExists=false**. A permissão do diretório de QA foi restaurada depois. A mesma janela de perda existe para outras falhas de escrita/cópia, como falta de espaço.

Correção esperada: preparar e validar toda a substituta antes de retirar a entrega existente; publicar de forma recuperável, ou rejeitar o destino inconsistente mantendo-o intacto. Teste deve provocar falha na nova gravação e verificar que os arquivos anteriores continuam disponíveis. Evidência: `export-write-failure.json` e seu script.

## Próxima revalidação

1. Corrigir R1–R4 e acrescentar apenas os casos de regressão correspondentes ao setup existente.
2. Reexecutar a suíte focada e typecheck; repetir os percursos de navegador com edição durante render e edição após reinclusão.
3. Conferir correção com alinhador real, reload/retomada e interface em 1280/390px. Os checks de catálogo/DOM não substituem esse percurso.
4. Com os gates determinísticos resolvidos, rodar os vídeos da Feira e Z.ai numa nova cópia, depois importar a entrega no DaVinci. A autorização anterior de Z.ai continua válida para esse escopo; não é necessário pedi-la por etapa.

Os 144 testes verdes são evidência de regressão automatizada. Os quatro achados acima foram reproduzidos fora dessa cobertura; portanto o produto ainda não está pronto para o aceite final.

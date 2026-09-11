# Validação independente do Decupa — 2b4300c

Data: 2026-09-11. Veredito: **REPROVADO para aceite final; devolver ao executor para correções.**

Branch conferida: `codex/fluxo-automatico-edicao-textual`, HEAD `2b4300c`. Os commits citados no relatório existem. Esta revisão não alterou código de produto, não fez push e não modificou o projeto real Feira. Os casos de falha abaixo usaram projetos sintéticos isolados. As alterações locais preexistentes foram preservadas.

## Resultado dos checks

| Check executado nesta revisão | Resultado |
| --- | --- |
| `pnpm typecheck` | PASS |
| `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts`, fora do sandbox | **135 passaram, 4 falharam; exit 1. Não houve listen EPERM.** |
| Prova `scripts/assembly-proof.ts` com motor local em d9fe300 e seu patch de render presente | PASS: 50 frames e primeiro azul no frame 25, tanto em 25/1 quanto em 30000/1001 |
| Duas requisições HTTP simultâneas de preview com o motor real e mídia sintética | Ambas 200; estado final com previewRevision 2 e SHA256 do arquivo igual ao registrado. PASS para esse cenário feliz. Uma resposta intermediária ainda veio com previewRevision null. |
| Substituição da prévia por resultado inválido | **FAIL: resultado inválido destrói a referência válida antes do probe.** |
| Reutilização de exportação cujo MP4 foi corrompido | **FAIL: retorna sucesso com hash diferente do aprovado.** |
| Correção textual seguida de remoção usando o catálogo da UI | **FAIL: mostra palavras antigas e envia IDs recusados pelo servidor.** |
| Remoção de palavra pela interface no navegador | Salva revisão 2, mas remove o src do player e exige atualização manual. **FAIL para o fluxo aprovado.** |
| Selecionar palavra para buscar o trecho | **FAIL: Tom, em 1s no fixture, fica selecionado, mas currentTime permanece 0.** |
| Preparação com falha de áudio de uma fonte incluída | Preserva a outra fonte, mas também chama proposta e render. **FAIL para a barreira anterior à proposta definida no plano.** |
| Z.ai com vídeos reais; audição independente do caso Nilton Pinto; nova importação no DaVinci | Não executados nesta revisão. Não são PASS. |

Logs, scripts de reprodução e resultados: [work/validation-2b4300c](</Users/jhonatan/Repos/Video editor/work/validation-2b4300c>). As cópias originais dos logs também estão em `/private/tmp/decupa-validation-*`.

## Achados que bloqueiam o aceite

### V1 — P1: validar o render antes de substituir a prévia publicada

Local: [render.ts:149](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/render.ts:149>).

`renderAssembly` renomeia a nova saída para `rev-N/reference.mp4` e só depois executa `probe(dest)`. Se o motor retorna código 0 com saída inválida, a função devolve erro, mas já substituiu o vídeo bom da mesma revisão. Isso viola a conservação do último artefato válido e também afeta chamadas concorrentes quando uma delas falha.

Reprodução independente: primeiro gravar uma referência válida; usar um executor que devolve código 0 e grava bytes inválidos no caminho `--out`; chamar `renderAssembly`. Resultado: `prévia sem integridade`, com `previousPreviewPreserved: false`. O teste de corrupção aconteceu somente numa cópia de QA.

Correção mínima esperada: validar o arquivo exclusivo do job antes da publicação; revalidar a identidade da operação/revisão no ponto de publicação. Um erro não pode substituir a referência anterior. Cobrir o caso válido + inválido concorrentes, além de dois renders válidos.

### V2 — P1: a exportação reutilizada não verifica seus arquivos

Local: [export.ts:140](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/export.ts:140>), e retorno alternativo em [export.ts:167](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/export.ts:167>).

O caminho idempotente compara os valores gravados no manifest com os hashes esperados, mas não lê o MP4/OTIO já exportados. Depois de uma primeira exportação válida, substituir apenas `exports/1/reference.mp4` por conteúdo inválido e exportar novamente devolve sucesso no mesmo diretório. A referência original aprovada permanece intacta; é a entrega que está corrompida. Além disso, o tratamento de destino existente aceita qualquer manifest presente depois de uma colisão de rename.

Reprodução: `returnedSuccess: true`; SHA256 entregue `7eaac7b42ddfdd717b534f6f472dad99b7a044be8d024e6e2bf3146616483c11`, aprovado `31fae1a21c3078a70c383f20ed4842731004287fa97d99941822b56e1aa31dc2`.

Correção esperada: verificar os arquivos reais antes de reutilizar a entrega; destino inconsistente precisa ser recusado ou recuperado explicitamente. Não basta a existência do manifest. Estender o teste existente com MP4 e OTIO ausentes/corrompidos.

### V3 — P1: corrigir o texto deixa a UI incompatível com o catálogo do servidor

Local: [page.js:70](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:70>). Contrato existente: [words.ts:68](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/words.ts:68>) e [words.ts:390](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/words.ts:390>).

`takeWords` parte de `analysis.words`, mas procura as correções pelos IDs novos criados pelo alinhamento. Esses IDs não existem na lista original. Após uma correção alinhada, o servidor usa `effectiveWords`, enquanto a UI continua mostrando e enviando os IDs originais.

Reprodução com as funções reais, incluindo a função de apresentação extraída sem alterações do `page.js`: corrigir o fixture “Nilton Pinto” para “João Silva”. Catálogo efetivo: `João Silva e Tom`; catálogo da UI: `Nilton Pinto e Tom`. Remover o primeiro botão mostrado resulta em `palavra não encontrada na fonte a: w1`.

Correção esperada: a apresentação e as ações precisam usar o mesmo catálogo efetivo. Exibir pending/error do alinhamento e atualizar o resultado assíncrono na tela. Testar corrigir → aguardar alinhamento → remover/restaurar → reload. Estes nomes são texto de fixture sintético; não representam uma audição dos vídeos da Feira.

### V4 — P1: editar ainda exige atualizar manualmente a prévia e retira o vídeo anterior

Local: [page.js:376](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:376>) e ações finais da página. Requisito: [desenho:57](</Users/jhonatan/Repos/Video editor/docs/superpowers/specs/2026-09-11-fluxo-automatico-edicao-textual-design.md:57>).

As ações de texto salvam a revisão, mas não disparam nem agrupam nova prévia. O único caminho de atualização posterior é o botão `Atualizar prévia`. Quando `previewRevision` vira null, `renderReview` remove o `src` do player. Não mantém o último vídeo disponível como anterior.

Reprodução pela interface em `http://127.0.0.1:65127`, projeto sintético: selecionar Tom e clicar Remover. A revisão passa de 1 para 2; `src` fica null, a tela mostra `prévia null`, Aprovar fica desabilitado e Atualizar prévia fica habilitado. O estado continuou assim enquanto outros checks eram executados. As duas requisições de preview realizadas depois foram disparadas explicitamente pelo teste de concorrência, não pela UI.

Correção esperada: agendar a prévia atual após as edições, conservar a anterior identificada e descartar resultados obsoletos. Testar o percurso pelo navegador, sem pressionar Atualizar prévia.

### V5 — P1: o runner monta e renderiza antes de resolver falhas necessárias

Local: [preparation.ts:331](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/preparation.ts:331>). O plano exige que proposal só comece quando todas as análises necessárias do conjunto incluído estiverem prontas.

O runner testa apenas se existe alguma fala antes de chamar `proposeScenes` e `applyProposal`. A avaliação de `needsAttention` acontece depois do render. Uma fonte incluída com erro de áudio não impede a aplicação de uma montagem parcial.

Reprodução usando os mesmos fakes existentes, sem provedor externo: falha de áudio da segunda fonte deixa a primeira salva, mas também produz `propose: 1`, `render: 1`, uma cena e `previewRevision: 1`; estado final attention. O próprio teste existente aceita esse comportamento, portanto seu PASS não prova o requisito aprovado.

Correção esperada: continuar análises independentes, persistir o progresso e parar antes da proposta se houver etapa necessária pendente/com erro. Retomar deve completar o que falta. Prosseguir sem fonte requer a exclusão explícita dessa fonte.

## Demais achados de produto e contrato

### V6 — P2: selecionar palavra não busca o trecho e incluir fala do original não tem interface

Local: [page.js:312](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.js:312>). O handler apenas alterna a seleção; não posiciona o player. A UI só lista palavras dentro dos takes atuais e não conecta a ação `include` existente no backend a uma seleção de fala que ficou de fora. Assim, Restaurar só recupera palavras removidas dos takes existentes, sem atender à inclusão de conteúdo omitido na proposta.

Reprodução da busca no navegador: clicar Tom, localizado em 1s no fixture, mantém o vídeo em 0. Correção esperada: mapear fonte → timeline para a busca e oferecer o catálogo/trecho original para inclusão. Testar depois de cortes, quando tempo de fonte e de montagem divergem.

### V7 — P2: a direção visual aprovada não foi implementada integralmente

Local: [page.css:1](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/page.css:1>). O [desenho:60](</Users/jhonatan/Repos/Video editor/docs/superpowers/specs/2026-09-11-fluxo-automatico-edicao-textual-design.md:60>) determina fundo claro suave, superfícies brancas e tipografia sem serifa. A página entregue mantém fundo `#12171a`, painéis escuros e corpo `ui-serif, Georgia, serif`; isso foi observado no navegador, não apenas inferido do CSS. Ela ainda exibe IDs técnicos como identificação principal de cenas/fontes.

Há uma composição em duas colunas no desktop, mas isso sozinho não comprova a execução da interface A aprovada. A validação completa em 1280/390px e dos controles ainda precisa ocorrer após as correções funcionais. Usar a referência aprovada sem instalar outro framework ou contratar geração de interface.

### V8 — P2: import em caminho com symlink devolve 200 sem source

Local: [routes.ts:586](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/routes.ts:586>).

`sourceFromFile` salva `realpath(path)`, mas a resposta procura a fonte comparando com `stored` sem canonicalizar. No macOS, `/var/folders/...` e `/private/var/folders/...` apontam ao mesmo arquivo, mas as strings diferem. O campo source fica undefined e é omitido do JSON, embora o arquivo esteja registrado no projeto. Isso explica dois dos quatro testes que falharam.

Reprodução HTTP independente: status 200, `hasSource: false`, fonte persistida sob `/private/var/folders/...`. Corrigir a identidade retornada pelo import, sem depender da grafia do caminho.

## As quatro falhas da suíte, classificadas

| Teste | Causa verificada | Próximo passo |
| --- | --- | --- |
| assembly-flow: briefing → proposta → exportação | O teste chama approve-final sem o novo watchedRevision e recebe 400. | Atualizar o cliente de teste ao contrato de confirmação explícita; não retirar a validação do produto para fazer o teste passar. |
| routes: duas prévias da mesma revisão | O fake grava uma string em reference.mp4 e recebe 500 no probe. | O fake precisa produzir mídia válida. O cenário com duas prévias reais passou; V1 continua sendo uma falha distinta e reproduzida. |
| routes: import por stream | Campo source ausente devido a caminhos canonicalizados de forma diferente. | Corrigir V8. |
| routes: lote/categorias | Falha ao ler one.source.id pelo mesmo problema de import. | Corrigir V8 e então reexecutar as verificações de lote. |

Portanto, não são quatro bugs de produção distintos, nem quatro falhas de ambiente: são dois testes que precisam acompanhar o contrato e duas falhas expostas pelo mesmo defeito de resposta HTTP.

## Ordem de correção e revalidação

1. Corrigir V1 e V2; provar conservação da referência boa e integridade dos dois arquivos entregues.
2. Corrigir V3–V6; testar no navegador corrigir, remover, restaurar, incluir, preservar e desfazer, com busca e atualização automática da prévia.
3. Corrigir V7–V8 e os dois fakes/contratos de teste desatualizados; repetir a suíte focada e typecheck até ficarem verdes.
4. Reexecutar os dois regimes de frames e a concorrência incluindo uma saída inválida. Não mexer no WIP do motor nem rodar setup-engine.sh.
5. Só então executar prepare/ajustes com os dois vídeos da Feira numa nova cópia, conferir o uso da análise visual e ouvir os cortes. A autorização anterior para Z.ai nesse escopo continua válida; não exigir nova autorização por etapa. Não houve consumo pago nesta validação.
6. Importar o OTIO dessa entrega no DaVinci e conferir mídia online, pistas, duração, canvas, taxa e recortes. A prova de render sintético que passou não substitui essa importação.
7. Atualizar a evidência do executor com o SHA validado, comandos/resultados reais e gates pendentes. Uma leitura ou auto-review não equivale a QA de navegador ou revisão independente.

O relato T10 foi lido como relato do executor. Não houve nova audição independente nem confirmação adicional do usuário nesta revisão; a ausência do nome em ASR/words/índice não seria suficiente, por si só, para provar sua ausência na fala original.

Durante um check extra, o sistema retornou ENOSPC ao criar um here-document; o disco mostrava aproximadamente 116 MiB disponíveis. O check de concorrência foi concluído sem esse arquivo temporário. Nenhum dado do usuário foi apagado. Verificar espaço disponível antes de rodar mídia real, sem confundir esse incidente posterior com as quatro falhas já reproduzidas da suíte.

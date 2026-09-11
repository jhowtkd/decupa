# Decupa — fluxo automático e edição pelo texto

Data: 2026-09-11
Status: desenho aprovado pelo usuário em 2026-09-11 (“aprovo”); implementação não iniciada.

## Decisões confirmadas

- Após selecionar e categorizar os materiais e informar o objetivo, o app prepara automaticamente a montagem: análise de áudio, transcrição, análise visual, proposta e prévia renderizada.
- A primeira entrega ao usuário já contém vídeo para assistir e texto editável.
- É possível corrigir a transcrição e editar cortes removendo ou restaurando palavras.
- Direção visual escolhida: **A — Texto + vídeo**, com vídeo à esquerda, texto à direita e navegação por cenas. Escolha recebida pelo chat: “a”.
- Pesquisa visual baseada no catálogo Builder do 21st.dev, sem instalar componentes nem usar geração de interface por IA do serviço.

Esta especificação substitui o fluxo manual de análise, pedido, aplicação e aprovação intermediária da especificação anterior de montagem multiarquivo. Preserva originais, revisão editorial e exportação para DaVinci.

## Resultado esperado

O usuário organiza o material, descreve o vídeo e aciona **Preparar montagem**. O app executa as etapas necessárias e abre uma proposta editável com prévia pronta. O usuário revisa, faz ajustes e exporta.

Não precisa conhecer IDs de fontes, comandos, caminhos internos, flags ou contratos de modelos para realizar esse trabalho.

## 1. Materiais e objetivo

- Área de arrastar arquivos e botão de seleção; miniaturas, nome curto e duração de cada material.
- Categorias em português: **Fala**, **Apoio** e **Fala + apoio**. A classificação inicial é uma sugestão; presença de áudio sozinha não comprova fala.
- Arrastar miniaturas entre categorias; seleção em lote e menu de categoria oferecem a mesma função por teclado e sem arrastar.
- Clicar numa miniatura abre o original no player. Informações técnicas e caminho completo ficam nos detalhes; relink aparece quando necessário.
- Briefing e duração desejada ficam junto dos materiais. Um único botão inicia a preparação do conjunto confirmado, evitando iniciar enquanto o usuário ainda organiza os arquivos.
- Ao acrescentar ou substituir material posteriormente, recalcular apenas o que depende da alteração e conservar a revisão editada até a nova proposta estar disponível.

## 2. Preparação automática

Fluxo: verificar arquivos → preparar mídia reproduzível → analisar áudio e imagem → montar proposta → renderizar prévia → abrir revisão.

- Reutilizar transcrições, descrições e proxies válidos. A autorização de uso do provedor já concedida pelo usuário persiste; não criar aprovações por arquivo ou por etapa.
- Mostrar progresso real por etapa e por fonte: concluído, em andamento ou precisa de atenção. Usar contagens conhecidas; não inventar porcentagem nem prazo.
- Usar todas as fontes selecionadas como insumo da proposta. Ausência de fala é um resultado possível, não uma falha de transcrição.
- Análise visual registra os intervalos efetivamente examinados. Uma resposta com poucos pontos não deve ser apresentada como cobertura de todos os segundos.
- A proposta precisa identificar as evidências de fala e imagem que sustentam cada cena e cada apoio escolhido.
- Persistir resultados conforme ficam prontos. Falha ou cancelamento de uma fonte não apaga outra fonte concluída.
- Se uma etapa falhar, continuar o trabalho independente e mostrar ação **Retomar** no ponto da falha. Não apresentar a proposta como completa enquanto houver análise necessária pendente.
- Se o usuário optar explicitamente por continuar sem uma fonte, registrar sua exclusão e preparar a proposta com o conjunto restante.
- Atualizar a página recupera o estado. Após reiniciar o servidor, identificar trabalho interrompido e permitir retomada; não deixar um indicador infinito de processamento.
- Um segundo clique não duplica trabalho em andamento. Mudanças durante uma operação impedem que seu resultado antigo substitua a revisão atual.

## 3. Revisão — direção A

Área principal ocupada por vídeo à esquerda e texto à direita, com espaço adequado para leitura. Abaixo, sequência de cenas com miniatura, título e duração. Em telas estreitas, vídeo e texto ficam empilhados.

- Cabeçalho mostra projeto, duração da montagem e estado de salvamento.
- O player reproduz a montagem; selecionar uma palavra ou cena posiciona a reprodução no trecho correspondente.
- **Ouvir original** abre o trecho da fonte com contexto anterior e posterior. Deve ficar claro se o usuário está assistindo à montagem ou ao original.
- Cada cena mostra fala escolhida, fonte identificável, tempo e apoio visual. A explicação editorial e as evidências visuais ficam disponíveis em detalhes, sem ocupar o lugar do texto editável.
- Indicação **Análise visual considerada** só aparece quando há evidência válida utilizada pela proposta. Mostrar também quando não foi encontrado apoio adequado.
- Reordenar e excluir cenas por ações visíveis; arrastar é alternativa. Permitir desfazer alterações.
- **Pedir ajuste** refina a montagem existente sem exigir que o usuário aplique manualmente um contrato de proposta. A revisão anterior permanece recuperável.
- Ao editar, salvar o projeto e atualizar a prévia automaticamente após uma breve pausa, agrupando edições próximas. Mostrar **Atualizando prévia** até ela corresponder à revisão atual.
- Manter o último vídeo válido disponível enquanto renderiza, identificado como prévia anterior. Não permitir exportá-lo como se refletisse alterações ainda pendentes.

Direção de estilo: fundo claro suave, superfícies brancas, texto escuro, tipografia sem serifa, destaque amarelo moderado e estados discretos. Priorizar espaço de leitura, miniaturas úteis e controles com foco visível. Evitar caminhos enormes, logs brutos e cartões vazios como interface principal.

## 4. Corrigir texto e editar cortes

São duas ações distintas na mesma área de texto, com rótulos claros:

| Ação | Efeito |
| --- | --- |
| Corrigir texto | Corrige grafia/transcrição; não muda o áudio nem corta mídia. |
| Remover da montagem | Exclui o intervalo de áudio/vídeo correspondente à seleção. |
| Restaurar trecho | Recupera palavras e mídia originais removidas da montagem. |
| Incluir trecho do original | Acrescenta fala existente na fonte, preservando sua origem e seus tempos. |

- Texto original reconhecido, correções e seleção editorial permanecem separáveis. Remover da montagem não destrói a transcrição original.
- Palavras precisam de identidade estável e vínculo com intervalos da fonte; cortes usam esse vínculo, não a posição de caracteres de um texto reescrito.
- Correções que alteram a divisão de palavras precisam de novo alinhamento do trecho antes de permitir cortes individuais nelas. Durante o alinhamento, o trecho permanece intacto e seu estado é visível.
- Inserir texto não cria voz. Se a fala existe no áudio mas não foi reconhecida, recuperá-la a partir do original e alinhar os tempos. Texto sem correspondência no áudio não pode fingir ser um trecho reproduzível.
- Nomes compostos e expressões não devem ser interrompidos por um corte automático no meio. O usuário pode preservar um trecho para que ajustes posteriores mantenham seu conteúdo.
- Ajustar limites de corte ao áudio para evitar sílabas truncadas, sem restaurar palavras que o usuário removeu deliberadamente.

### Caso Nilton Pinto

O catálogo local consultado já apresentava “Tom Carvalho” sem “Nilton Pinto”. Isso não identifica sozinho a origem do problema. A investigação deve ouvir o original e comparar reconhecimento, alinhamento, seleção de cena e render final.

Aceite: quando “Nilton Pinto e Tom Carvalho” estiver presente no áudio original e fizer parte da cena escolhida, a reprodução precisa manter o nome completo. Se houve omissão no reconhecimento, a correção deve recuperar e alinhar a fala existente; apenas trocar a legenda não resolve.

## 5. Integração com o que já existe

A implementação atual está na cópia de teste `/private/tmp/decupa-review-e4e68443`; o repositório principal ainda não contém todas as correções validadas nessa cópia. Reconciliar a autoria local e o patch do Cursor antes da implementação do redesign.

- Reutilizar análise, persistência incremental, validação de propostas, controle de revisão, renderização e exportação existentes.
- O modelo atual da montagem guarda fala em intervalos, embora o fluxo inferior de transcrição tenha tempos por palavra. Preservar esses tempos ao formar o catálogo usado pela edição.
- Estender o projeto somente com os dados necessários para palavras, correções, seleção de trechos e estado recuperável da preparação. Não introduzir banco de dados nem um serviço de filas para esse uso local.
- Projetos existentes precisam continuar abrindo. Fazer evolução compatível e preservar dados anteriores; catálogos antigos podem exigir alinhamento antes de habilitar cortes por palavra.
- Manter a UI atual em HTML/JavaScript e as dependências existentes como ponto de partida. Referências do catálogo 21st.dev orientam a apresentação; não obrigam migração para React.
- Uma seleção temporal consistente deve alimentar prévia e exportação. Trabalhar com frames inteiros e taxa racional para evitar divergência em 30000/1001.
- Renderizações escrevem em artefatos próprios e só publicam o resultado validado para a revisão correspondente. Duas prévias não podem corromper `reference.mp4`.
- Conferir identidade/conteúdo das fontes antes de renderizar e exportar. Arquivo alterado no mesmo caminho exige reanálise ou relink, preservando a revisão anterior para consulta.

## 6. Exportação

- Disponibilizar **Exportar para DaVinci** quando a prévia atual estiver pronta e o usuário tiver feito a revisão final.
- A confirmação final deve se referir à mesma revisão do vídeo assistido. Uma alteração posterior invalida esse estado.
- Entregar os dois arquivos com nomes claros: montagem para DaVinci e MP4 de referência. Mostrar os dois downloads e sua localização.
- A etapa automática não aprova editorialmente nem exporta por conta própria.

## 7. Referências consultadas no catálogo 21st.dev

| Referência | Aplicação no desenho |
| --- | --- |
| [File Upload with Preview](https://21st.dev/@ephraimduncan/components/file-upload-01) | Entrada de material com miniaturas e ações locais. |
| [Video Player](https://21st.dev/@chetanverma16/components/video-player) | Player como parte central da revisão. |
| [Stepper](https://21st.dev/@originui/components/stepper) | Progresso legível durante preparação automática. |
| [Inline Edit](https://21st.dev/@0xUrvish/components/inline-edit) | Correção pontual no contexto da transcrição. |

Exploração preservada em `.superpowers/brainstorm/24976-1789133742/content/layouts-feira-v3.html`. As três opções foram inspecionadas no navegador; A foi escolhida pelo usuário. O protótipo simula edição e reprodução: não comprova comportamento do aplicativo.

## 8. Verificação e critérios de aceite

1. Com os dois vídeos de Feira, um único início percorre análise de áudio e imagem, proposta e prévia sem aprovações intermediárias. A tela final permite assistir ao resultado.
2. A preparação mostra cobertura real e a proposta permite rastrear quais evidências visuais foram consideradas. Não atribuir evidência a segundos não examinados.
3. Uma falha na segunda fonte preserva a primeira; retomar reutiliza os resultados válidos. Recarregar a página não perde o estado.
4. Corrigir uma palavra não modifica o áudio. Remover corta o trecho correto; restaurar o recupera. Desfazer e reabrir o projeto preservam essas distinções.
5. Verificar o caso “Nilton Pinto e Tom Carvalho” ouvindo o original e o resultado. Não aceitar apenas a presença do nome no texto.
6. Assistir à montagem e ao original pelo player, com busca por palavra/trecho. Nenhum estado de sucesso com player vazio.
7. Edição durante análise, proposta ou render não permite sobrescrita por resultado antigo. Duas renderizações não corrompem o arquivo publicado.
8. Substituir conteúdo no mesmo caminho bloqueia exportação desatualizada e indica reanálise/relink.
9. Exportar e abrir os dois arquivos. Conferir 25 fps e corrigir a regressão existente em 30000/1001: apoio azul deve iniciar no frame 25, não no 26.
10. Conferir navegação por teclado, alternativa a arrastar, foco visível, leitura em tela estreita e ausência de overflow horizontal no texto.

Usar testes existentes para regressões de estado, revisão e seleção temporal, sem chamar provedores reais na suíte. Validação real com mídia e provedor autorizado é uma evidência separada. A aparência do protótipo não substitui o teste de uso do app implementado.

## Fora deste desenho

Geração de voz para palavras inexistentes, editor completo de efeitos, migração de framework, publicação e trabalho colaborativo multiusuário. O foco é concluir a montagem automática e torná-la corrigível pelo texto com prévia confiável.

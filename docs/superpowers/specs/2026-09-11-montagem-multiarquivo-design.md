# Decupa — montagem de vários arquivos para o DaVinci

Data: 2026-09-11
Estado: documento aprovado pelo usuário em 2026-09-11; planejamento autorizado.

## Objetivo e decisões aprovadas

Evoluir o Decupa atual para montar vídeos a partir de vários arquivos de fala
e imagens de apoio, orientado por roteiro pronto ou briefing. O usuário aprova
a estrutura de cenas, revisa uma prévia e recebe uma timeline editável para o
DaVinci e um vídeo de referência da mesma montagem.

Fluxo: arquivos + roteiro/briefing → transcrição e compreensão visual →
proposta de cenas → aprovação da estrutura → prévia → ajustes aprovados →
timeline editável + vídeo de referência.

O estudo anexado é referência, não autorização para adotar todas as suas
recomendações. HyperFrames, Remotion, geração de cenas sintéticas e integração
com agentes externos não fazem parte deste escopo. Não construir um editor
generalista nem operar obrigatoriamente dentro do DaVinci.

Esta evolução amplia as restrições de produto da especificação de limpeza de
2026-09-04: o novo projeto aceita vários arquivos e montagem de cenas. O fluxo
de limpeza existente permanece funcional; não haverá outra implementação da
mesma triagem.

## Base existente e limites observados

- `apps/cli/src/app/pipeline.ts`: transcrição, índice de fala, índice visual,
  triagem, planejamento e renderização vinculados atualmente a um vídeo.
- `packages/triage`: seleção editorial e sinais visuais. Sinais de rosto,
  olhar e mãos não substituem compreensão de ações, objetos e contexto.
- `apps/cli/src/app/server.ts`: revisão e exportação do fluxo atual.
- `apps/cli/src/app/edl.ts`: EDL restrito a uma fonte, uma pista de vídeo e
  frame rate inteiro. Não satisfaz sozinho a entrega multiarquivo e multipista.

Esses pontos foram inspecionados no código; não foi executada uma importação
no DaVinci nem validado o novo fluxo em runtime.

## 1. Entrada e análise

O projeto reúne referências aos arquivos locais, roteiro ou briefing e duração
desejada. O usuário pode indicar quais arquivos são falas e quais são apoio.
Um arquivo pode oferecer ambos os usos. Os originais não são modificados.

A transcrição mantém palavras/trechos vinculados à fonte e ao tempo original.
A compreensão visual produz um mapa consultável por segundo e intervalos úteis
de ações, pessoas, objetos e enquadramentos. Toda observação aponta para mídia
e intervalo verificáveis; o usuário pode abrir o trecho correspondente.

“Por segundo” define a granularidade de consulta, não a promessa de observar
todos os frames nem a obrigação de uma chamada de IA por segundo. A análise
deve considerar contexto temporal; informações incertas ou indisponíveis devem
ser indicadas, sem inventar descrições para preencher intervalos.

Reaproveitar resultados quando a fonte e a configuração de análise forem as
mesmas. Alterar o briefing não exige transcrever ou analisar novamente arquivos
inalterados. A falha de um arquivo fica visível e pode ser retomada isoladamente.

## 2. Proposta e revisão das cenas

Com roteiro pronto, procurar trechos que atendam à sequência e sinalizar partes
sem cobertura. Com briefing, propor a narrativa com base no material disponível
e na duração desejada. Não inventar falas nem alterar seu sentido para cumprir
a duração; incompatibilidades devem ser apresentadas para decisão.

Cada cena apresenta:

- Objetivo na narrativa e posição na sequência.
- Fala selecionada, texto e intervalos exatos nas fontes.
- Imagens de apoio sugeridas e posição/duração sobre a fala.
- Duração resultante e justificativa das escolhas.
- Lacunas e incertezas que exigem revisão.

O usuário pode reordenar, excluir, ajustar cenas e substituir tomadas ou apoio.
Também pode solicitar alterações em linguagem natural. O app apresenta a
proposta de mudanças antes de aplicá-la. Escolhas aprovadas são preservadas
fora do escopo solicitado; efeitos sobre outras cenas devem ser mostrados.

A aprovação da estrutura identifica uma revisão concreta. Mudanças posteriores
não podem ser confundidas com aquela estrutura aprovada.

## 3. Prévia, ajustes e entrega

A prévia segue a sequência aprovada e insere imagens de apoio sobre as falas
nos pontos definidos. O áudio da fala continua sob essas imagens; áudio de apoio
não deve substituir ou sobrepor a fala automaticamente. Mudanças de áudio devem
ficar explícitas na proposta e ser audíveis na prévia.

O usuário assiste e ajusta cortes, tomadas e duração/posição de apoio, diretamente
ou por pedidos em linguagem natural sujeitos à revisão descrita acima. Alterar
a montagem torna a prévia anterior desatualizada. A aprovação final refere-se
à revisão efetivamente visualizada.

A entrega contém:

- Timeline editável com falas e imagens de apoio em pistas separadas, fontes
  identificáveis e áudio preservado para continuar a edição no DaVinci.
- Vídeo de referência correspondente à mesma revisão aprovada.
- Indicação de mídias ausentes e referências necessárias para localizá-las.

Timeline e vídeo devem consumir a mesma representação da montagem. Não gerar
duas decisões editoriais independentes para as duas saídas. Proxies servem à
análise/prévia; a entrega editável referencia os originais. Se uma fonte estiver
ausente, conservar a montagem e pedir sua localização antes de concluir uma
entrega que dependa dela.

## 4. Organização interna

Reutilizar o servidor local, os componentes de análise e os padrões existentes.
As responsabilidades necessárias são:

1. Projeto: fontes, briefing/roteiro e revisões aprovadas.
2. Análise por arquivo: transcrição, observações visuais e intervalos úteis.
3. Composição editorial: cenas que referenciam os resultados e as fontes.
4. Montagem: cortes, pistas e posicionamento temporal aprovados.
5. Saídas: prévia, referência e intercâmbio com o DaVinci.

São responsabilidades, não exigência de novos serviços, pacotes ou frameworks.
Usar chamadas diretas internas. Preservar a triagem existente; acrescentar
planejamento entre arquivos e compreensão visual sem substituí-la silenciosamente.

O contrato concreto de armazenamento e as rotas serão propostos no plano de
implementação, limitados a essas responsabilidades. A presente aprovação é do
desenho; não autoriza alterações de API, esquema ou dependências ainda não
apresentadas, chamadas pagas, publicação ou mudanças em produção.

## 5. Decisões técnicas a resolver antes da implementação dependente

O plano deve começar pela compatibilidade de saída: identificar a versão de
DaVinci alvo e selecionar um único formato de intercâmbio capaz de representar
fontes múltiplas, pistas e áudio. Não assumir que o EDL atual pode ser expandido
sem perda. A escolha exige documentação atual e uma prova de importação pequena;
falha nessa prova impede prometer a entrega editável, mas não invalida os demais
requisitos do produto.

Também devem ser propostas a seleção local dos arquivos e a forma de análise
visual. Não introduzir upload remoto ou trocar o provedor/modelo da triagem por
dedução. Confirmar os custos e o envio de mídia antes de qualquer chamada paga.

Essas são etapas de decisão obrigatórias do plano, não opções para o
implementador escolher silenciosamente. Não adotar dois motores de renderização
ou dois formatos de exportação como precaução.

## 6. Falhas e preservação do trabalho

- Validar fontes, durações e limites dos trechos antes de montar ou exportar.
- Registrar progresso e erro por etapa/arquivo; não declarar sucesso parcial
  como entrega concluída nem ocultar ausência de compreensão visual.
- Preservar análises válidas, escolhas aprovadas e originais após falha ou
  cancelamento. Retomar somente o trabalho necessário.
- Vincular prévias e exportações à revisão de montagem que as produziu; uma
  operação antiga não pode substituir o resultado de uma revisão mais nova.
- Mostrar incompatibilidades de mídia ou de intercâmbio antes da entrega;
  nunca arredondar frame rate de forma silenciosa ou perder pistas sem avisar.

## 7. Critérios de aceitação

Usar um conjunto pequeno e conhecido de falas com tomadas alternativas e
imagens de apoio. Respostas de análise armazenadas permitem testar a montagem
sem pagar novamente ou confundir regressão com variação de modelo.

1. Roteiro e briefing produzem propostas revisáveis a partir de vários arquivos.
2. A consulta visual por segundo e os intervalos úteis abrem a fonte correta;
   amostras são verificadas manualmente contra as imagens reais.
3. Falas, tomadas e apoio selecionados são rastreáveis e respeitam os limites
   da mídia. Trechos ausentes ou incertos aparecem como lacunas.
4. Reordenar/substituir uma cena produz a alteração esperada e preserva escolhas
   aprovadas fora do pedido. Uma proposta ainda não aceita não muda a montagem.
5. Alterar somente o briefing reaproveita análises válidas; falhar e retomar um
   arquivo não descarta os resultados dos demais.
6. A prévia reproduz a montagem aprovada, inclusive continuidade da fala sob
   imagens de apoio. A avaliação editorial inclui assistir e ouvir as junções.
7. Timeline e referência correspondem à mesma revisão. Importar no DaVinci e
   comparar fontes, ordem, pistas, início/fim dos cortes, áudio e sincronização.
   Limites de vídeo devem coincidir nos frames da timeline, sem deriva de áudio.
8. O fluxo de limpeza de um vídeo continua passando nas verificações existentes.

Usar os testes existentes e acrescentar apenas verificações dos contratos novos
e riscos acima. Verificação local de arquivos não substitui a importação real
no DaVinci; sem essa evidência, a integração permanece não validada.

## Sequência de planejamento

Planejar entregas verticais: primeiro comprovar uma montagem mínima de várias
fontes chegando ao DaVinci; depois conectar análise e proposta de cenas; por fim,
completar revisão, retomada e entrega. Cada etapa deve produzir algo verificável
sem construir previamente um editor completo.

Após a revisão deste documento pelo usuário, usar a skill writing-plans para
detalhar a implementação. Nenhuma implementação foi realizada nesta etapa.

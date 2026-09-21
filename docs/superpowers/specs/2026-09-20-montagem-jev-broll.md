# Montagem funcional: decisões Jev e b-roll

## Objetivo e limites

Entregar montagem de entrevista ou narração com imagens de apoio relevantes, decisões reais do Jev e controle humano dos resultados. Esta especificação registra as escolhas propostas nesta conversa; a revisão do plano confirma essas escolhas antes da implementação.

A entrega é dividida em dois planos executáveis: `../plans/2026-09-20-montagem-jev.md` e `../plans/2026-09-20-montagem-broll.md`. O primeiro funciona sem o segundo. O segundo reutiliza o adaptador do primeiro.

Default: fala/narração conduz a sequência. Vídeos apenas de imagens e música não entram nesta entrega: exigem outra base de duração e montagem sem takes de fala. Não criar botões simulando essa modalidade. Projetos/equipes/login, redesign geral, novo exportador e geração de música também ficam fora.

## Requisitos globais

- Node.js >=22.6; pnpm 10.32.1; TypeScript, Vitest e FFmpeg existentes.
- Não adicionar dependências, frameworks, serviços nem infraestrutura de testes.
- Preservar mídias originais, alterações locais existentes e projetos version 2.
- Toda aplicação editorial exige baseRevision atual e invalida a aprovação da prévia anterior.
- Não criar confirmação de pagamento a cada operação; usar a configuração já autorizada.
- Testes automáticos usam transportes simulados, nunca chaves ou APIs reais.
- Segredos, frames e transcrições não entram em logs de diagnóstico.
- Revisão humana da prévia continua necessária para exportar.

## Evidência da base em 20/09/2026

`startAssemblyApp` chama `bootProjectDecision`, descarta seu retorno e injeta `lazyPaidSend` tanto em análise visual quanto em proposta. A configuração atual resolve Z.ai/glm-5.3-flash. `scenes.test.ts` inclusive fixa o comportamento antigo de não participação do TypeSafe. O plano de 17/09 limitava Jev ao fluxo Limpar; esta especificação amplia o escopo apenas em Montar.

`proposeScenes` recebe catálogo de fala e visual, mas ignora `project.input`. `runPreparation` aplica a proposta sem gravar o snapshot de histórico. `compileScenes` já produz V1, V2 e A1; V2 não acrescenta áudio. Cada apoio aponta para um VisualSpan e é limitado à duração desse span. Logo, uma janela de três segundos descrita em três spans de um segundo precisa de três entradas consecutivas de apoio, e não de um pedido de três segundos para um único span.

## Responsabilidades dos modelos

WhisperX transcreve e alinha localmente. O provedor visual descreve imagens. O gerador atual propõe estrutura narrativa e candidatos de cortes. Jev recebe exclusivamente texto e JSON para decidir entre candidatos fechados; não recebe mídia nem gera JSON livre de uma timeline. FFmpeg renderiza localmente.

O briefing salvo, seu tipo e a duração alvo entram no prompt; o pedido de ajuste entra como instrução adicional, sem apagar o briefing. Duração alvo é um objetivo editorial, não autorização para cortar palavras pela metade. Ausência de candidato não é prova de material limpo. Não prometer aceleração: medir chamada de geração, decisão e render separadamente.

## Entrega A: decisões reais de cortes

O gerador devolve a proposta existente e, opcionalmente, `cutCandidates: [{sceneId, speechId, reason}]`. São sugestões de remover um take completo da proposta, não novas fontes nem tempos. `reason` é texto não vazio. O servidor resolve o take, atribui ID estável `cut:<sceneId>:<takeId>` e inclui fala, contexto vizinho, briefing, pedido e proteções no estado enviado ao Jev. Recusar candidatos desconhecidos ou duplicados; takes protegidos, já editados, em cenas com apoio existente ou que deixariam a cena sem fala são inelegíveis.

O servidor limita cada chamada a vinte candidatos de corte, processados na ordem de cena/take; lotes posteriores respeitam as decisões já tomadas. Jev responde `noul` para candidatos elegíveis. Reutilizar `authorizesCut`; não inventar um limiar diferente. Resposta ausente, inválida, erro ou recusa mantém a fala. Uma resposta não autoriza alterações em IDs que não foram perguntados. Aplicar cortes autorizados em ordem de cena/take e nunca remover o último take restante de uma cena. Revalidar a proposta completa depois da decisão. Alterações narrativas gerais continuam pertencendo ao gerador: não afirmar que Jev tomou todas as decisões do vídeo.

Configuração de montagem: respeitar `decision.json` explícito off/observe/hybrid. Sem arquivo, usar hybrid somente quando `DECUPA_TYPESAFE=1` e chave resolvida existirem; caso contrário off. Não mudar os defaults globais de `parseDecisionConfig` nem do fluxo Limpar. Observe consulta, registra e não aplica. Nenhum ping pago na inicialização; o teste de conectividade é a operação útil. Sem candidatos, não chamar Jev.

Acrescentar `Proposal.decisionReport?`: `{mode: 'off'|'observe'|'hybrid', status: 'not-run'|'completed'|'fallback', model: string|null, elapsedMs: number, reason?: string, cuts: [{id, sceneId, takeId, applied, score: number|null}]}`. Projetos antigos sem o campo permanecem válidos. Somente campos permitidos, sem resposta bruta nem chave; erro de provedor vira categoria sanitizada. A ausência de relatório é exibida como “Decisão não registrada”.

Manter a primeira montagem e o ajuste como operações aplicadas pelo fluxo atual, com resumo explícito e Desfazer funcional. Renomear “Propor mudanças” para “Aplicar ajuste com IA”: não fingir uma revisão de propostas ainda inexistente. Uma tela geral de comparação antes/depois é entrega independente, não requisito oculto destes planos.

## Entrega B: b-roll sobre a fala

Não gerar apoio a partir de fonte excluída ou de categoria speech. `both` pode servir de apoio em outro momento, mas não usar a mesma fonte do take que está sendo coberto. Nunca usar observações unavailable/uncertain na seleção automática inicial; uncertain permanece consultável e poderá entrar por decisão manual explícita em trabalho futuro.

Formar candidatos locais por fonte a partir de spans observed ordenados. Cada candidato começa no início de um span, reúne cobertura contígua por até três segundos e contém os IDs reais, sem atravessar lacuna. A janela pode ser menor que três segundos no fim da fonte. Não alterar nem substituir a análise visual original.

Para cada cena alterada sem apoio existente, perguntar ao Jev uma `choice` entre candidatos elegíveis e `none`, incluindo fala da cena, objetivo e descrições. Lotes determinísticos de no máximo vinte candidatos; vencedor de cada lote concorre em rodada final, também limitada a vinte, repetida até um vencedor. Em toda rodada oferecer `none`. Sem cliente, erro ou escolha none: manter V1 e registrar “Sem apoio automático”; não bloquear a montagem.

Uma inserção automática por cena nesta versão, iniciando a um segundo do começo da cena e limitada a três segundos e ao espaço restante. Cena com menos de dois segundos permanece sem apoio automático. Após os cortes do plano A, recalcular todas as posições. Não reutilizar intervalo de fonte já usado como apoio em outra cena; processar na ordem das cenas. Preservar apoio que já existia quando o ajuste começou, salvo ação manual explícita.

Representar uma janela selecionada usando as entradas existentes `{visualId, offsetFrames, durationFrames}`. Resolver durações por fronteiras de frames usando fps racional e truncar apenas o último span quando necessário. Sem expansão de storage para spans agregados. Fonte, entrada e continuidade precisam permanecer verificáveis em cada entrada.

Adicionar somente `EditAction {type:'set-support', sceneId, support: Scene['support']}` à API de edição existente. Esse comando substitui o apoio completo de uma cena, permite lista vazia para remover e exige validação idêntica à proposta. Histórico, recompilação, revisão, aprovação e atualização de prévia seguem o caminho existente. Não criar endpoint paralelo.

No inspetor, mostrar descrição, fonte, entrada na fonte, início na cena e duração; oferecer trocar entre candidatos locais, alterar início/duração e remover. Trocar manualmente não chama IA. Cada grupo contínuo de entradas da mesma fonte aparece como um único apoio; alterações desse grupo preservam os demais grupos da cena. A trilha V2 seleciona a cena e o grupo correspondente, sem confundir seleção com reprodução. A1 mantém a voz; o áudio da fonte de apoio permanece mudo.

O status geral do relatório é fallback se alguma fase falhou, completed se houve ao menos uma resposta útil sem falhas e not-run se nenhuma chamada ocorreu. Acumular o tempo das duas fases. Acrescentar ao relatório opcional `supports?: [{sceneId, candidateId: string|null, outcome:'selected'|'none'|'fallback', reason:string}]`. A justificativa mostrada vem da descrição existente e do vínculo com a fala; não inventar explicação atribuída ao Jev, cuja API retorna escolhas/probabilidades.

## Aceitação e limites de evidência

Ambas as entregas precisam de testes unitários, integração HTTP simulada e inspeção de navegador. Um teste audiovisual local com fontes sintéticas distinguíveis prova V2 visível, retorno a V1 e A1 contínuo. Um piloto real autorizado mede tempos frios/quentes e confirma chamada útil ao Jev, sem mudar o projeto atual nem aprová-lo automaticamente.

Aceitar b-roll semanticamente relevante requer revisão humana de material representativo, não apenas compilação ou ausência de erro. Registrar candidatos rejeitados, nenhum apoio, fonte substituída, cancelamento e revisão concorrente. Adições de interface propostas para aprovação: relatório opcional em Proposal; ação set-support; campos derivados undoRevision e brollCandidates no envelope GET /project. brollCandidates inclui entries de apoio relativas ao início zero, sem caminhos de mídia. GET mantém o projeto sem mutação. Após mutação editorial síncrona, a UI atualiza essas capacidades por um GET; operações assíncronas as recebem pelo polling existente. Aprovar a implementação destes planos autoriza essas adições, não mudanças adicionais de contrato.

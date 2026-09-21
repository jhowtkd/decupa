# Decupa — Templates editoriais e entrega nativa no DaVinci

Data: 2026-09-21
Estado: desenho aprovado em conversa; especificação escrita aguardando revisão do usuário. Implementação e plano ainda não iniciados.

## Objetivo e escopo aprovado

Transformar um vídeo base em uma receita editorial adaptável, validada exclusivamente pelo usuário, que gere montagens revisáveis em outros projetos. Manter a prévia no Decupa e tornar a criação de um projeto nativo no DaVinci Resolve a entrega padrão, inclusive em projetos sem template.

Sucesso significa reutilizar intenção editorial sem forçar a mesma quantidade de cenas, preservar o sentido das falas e entregar a revisão aprovada em um projeto editável no Resolve, com pendências explícitas.

Este documento consolida as decisões desta conversa e prevalece sobre o desenho de `2026-09-12-inspiracao-de-edicao-design.md` nos pontos de entrada da interface, validação pessoal, aplicação e entrega. O desenho anterior é referência técnica; seus detalhes adicionais não se tornam automaticamente requisitos desta entrega.

## Decisões

- Biblioteca Templates independente dos projetos, com seleção opcional dentro de cada projeto.
- Um vídeo base por template; receita adaptável, sem quantidade fixa de cenas.
- Orientações sobre seleção e ordem das falas, função dos trechos, B-rolls, ritmo, formato, durações e animações.
- Análise gera rascunho editável. Apenas aprovação explícita do usuário libera uma revisão para uso; a IA nunca aprova.
- Aplicação gera proposta revisável. A prévia continua no Decupa antes da aprovação e entrega.
- Entrega padrão: criar e salvar projeto nativo no Resolve, inicialmente importando a timeline existente automaticamente. Exportar `.drp` é uma opção.
- Montagem direta de clipes pela API fica fora desta primeira implementação; considerar apenas diante de limitações comprovadas da importação.
- Animações não executadas são pendências visíveis, com marcadores e handoff para execução no Resolve ou After Effects.

## Criação e validação do template

1. Em Templates, importar um vídeo local e nomear a receita. Validar mídia sem alterar o original.
2. Analisar imagem e áudio com progresso e possibilidade de cancelamento. Reutilizar configuração e mecanismos existentes; chamadas externas seguem o consentimento aplicável, sem troca automática para provedores pagos.
3. Exibir observações vinculadas a intervalos reproduzíveis do vídeo base. Separar evidência observada, interpretação incerta e instrução editada pelo usuário.
4. Permitir corrigir, remover ou desativar orientações e salvar rascunhos.
5. A ação explícita do usuário aprova a revisão e a disponibiliza na biblioteca.

A receita contém identidade, nome, revisão, estado de aprovação, identificação da mídia base e orientações com categoria, função editorial, evidências temporais, confiança e instrução reutilizável. Durações observadas são referências, não obrigações. Aparência visual não prova a ferramenta ou configuração exata usada para um efeito.

Reanálise ou edição de receita aprovada produz rascunho de nova revisão; não modifica a revisão aprovada nem projetos que já a usaram. Aprovação é uma ação do usuário local, sem introduzir sistema de equipes, permissões ou autenticação novo.

Manter a referência consultável. Se o arquivo for movido, indicar indisponibilidade e permitir religação com verificação de identidade; não apagar a receita. Análise incompleta ou inválida não recebe aprovação silenciosa. Ausência legítima de um recurso, como áudio em vídeo mudo, aparece como indisponível.

## Aplicação e prévia

O projeto permite escolher um template aprovado ou seguir sem template. Uma cópia da receita e sua revisão acompanham a proposta, para impedir mudanças retroativas ao editar a biblioteca.

A receita orienta a seleção e ordenação das falas, escolha de imagens de apoio, distribuição temporal e sugestões de animação. A montagem usa apenas mídias e trechos válidos do projeto atual. Não copia falas, pessoas, música ou imagens do vídeo base e não inventa material para preencher uma estrutura.

Exemplo: uma referência com três depoimentos pode orientar um projeto com cinco. A função narrativa é preservada quando possível; número de cenas e duração se adaptam ao conteúdo. Não truncar frases para imitar duração ou ritmo.

A proposta relata orientações aplicadas, adaptações e lacunas. Recursos não executados aparecem como pendentes associados às cenas e tempos correspondentes, sem simular que já estejam no vídeo. O usuário pode assistir à prévia, editar e aprovar pelo ciclo existente.

Aplicar ou trocar template em projeto editado cria uma proposta sem sobrescrever a montagem anterior. Aceitar a proposta passa pelo mecanismo de revisões existente. Alterações posteriores invalidam prévia e aprovação conforme as regras atuais.

## Entrega padrão no DaVinci

Fluxo comum com ou sem template: montar → assistir à prévia → ajustar → aprovar → abrir montagem no DaVinci.

1. Validar revisão aprovada, identidade da montagem, prévia e mídias antes da entrega.
2. Reutilizar a exportação OTIO da mesma revisão, sem nova decisão editorial ou renderização escondida.
3. Conectar ao Resolve disponível e criar projeto com nome do projeto Decupa e revisão, sem carregar um projeto existente para sobrescrevê-lo.
4. Configurar vídeo, importar a timeline e organizar as mídias. Incluir marcadores e handoff das pendências.
5. Conferir mídia vinculada, FPS/resolução, número de clipes, posições, intervalos de origem e durações de vídeo e áudio; salvar o projeto somente com resultado de entrega claramente registrado.
6. Abrir a montagem criada no Resolve. Disponibilizar exportação do projeto em `.drp`, verificando sucesso e existência do arquivo.

Cada nova revisão entregue cria outro projeto; alterações manuais no Resolve são preservadas. Em repetição da mesma entrega, reutilizar o registro de sucesso sem reimportar ou sobrescrever. Se precisar criar outra cópia, usar nome único. Em falha parcial, registrar o projeto criado e a etapa com erro; não apagar automaticamente projetos do usuário nem declarar sucesso.

O `.drp` não inclui por si só a mídia original. A interface deve explicar a dependência dos arquivos vinculados; empacotamento portátil de toda a mídia não faz parte desta versão.

O Resolve precisa estar em execução com scripting acessível. Quando indisponível ou incompatível, explicar o impedimento, preservar a montagem e a prévia e oferecer a timeline como alternativa explícita. Não mudar silenciosamente o tipo de entrega.

Reutilizar OTIO reduz o trabalho inicial, mas não elimina limitações de conversão. Verificação técnica e inspeção audiovisual são necessárias antes de afirmar fidelidade. O script atual de prova cria e apaga um projeto temporário: sua limpeza não deve ser transportada para o fluxo de entrega permanente.

## Handoff de animações

Para cada pendência, registrar cena, intervalo na revisão aprovada, descrição do resultado esperado, referência quando disponível e destino sugerido (Resolve ou After Effects). Textos necessários desconhecidos permanecem como pendência explícita, sem conteúdo inventado.

Marcadores no Resolve e documento legível de handoff derivam da mesma lista, com identidade e revisão do projeto. Mudanças na montagem recalculam os tempos antes da próxima entrega. Não prometer reprodução automática de efeitos, projetos After Effects ou composições Fusion nesta versão.

## Integração e persistência

Reutilizar ingestão/análise, catálogo de falas e imagens, propostas, revisões, prévia, validação e exportação existentes. Não criar outro motor de montagem ou serviço externo.

Pontos atuais de integração observados:

- `apps/cli/src/app/assembly/scenes.ts`: proposta de cenas e validação dos IDs e trechos do projeto.
- `apps/cli/src/app/assembly/types.ts` e `store.ts`: estado e persistência de projetos; preservar leitura de projetos existentes sem template.
- `apps/cli/src/app/assembly/export.ts` e `otio.ts`: exportação vinculada à aprovação e à prévia da revisão.
- `apps/cli/src/app/assembly/routes.ts` e interface existente: seleção, revisão, entrega e mensagens de erro.
- `scripts/davinci-proof.py`: referência para conexão e conferência de importação, sem reaproveitar a política de exclusão do projeto temporário.

Novas responsabilidades: biblioteca/análise da receita e ponte de entrega permanente ao Resolve. Guardar templates na área local de dados do Decupa, fora dos projetos, seguindo suas convenções e gravações atômicas. O plano deve definir os campos mínimos e compatibilidade de armazenamento antes da implementação; este desenho não autoriza migração destrutiva.

Resultados de análise e de entrega têm estado persistido suficiente para informar progresso, conclusão, cancelamento ou falha e permitir nova tentativa sem perda de trabalho. Validar respostas externas, intervalos, valores numéricos e referências à mídia; conteúdo do vídeo é dado, nunca instrução para o sistema.

## Verificação e aceitação

Usar os testes existentes e acrescentar apenas cobertura dos novos contratos:

- Rascunhos não são aplicáveis; aprovação requer ação do usuário; editar não altera a revisão anteriormente aprovada.
- Receita aplicada permanece estável após mudanças na biblioteca e só referencia mídia válida do projeto.
- Troca de template preserva montagem anterior e produz proposta revisável com lacunas explícitas.
- Projetos antigos e sem template mantêm montagem/prévia e recebem a nova entrega padrão.
- Prévia ou aprovação desatualizada bloqueia entrega; OTIO e handoff correspondem à mesma revisão.
- Ponte trata Resolve indisponível, mídias ausentes, falha de importação/salvamento/exportação, colisão de nome e repetição sem sobrescrever trabalho.
- Testes simulados cobrem chamadas e erros, mas não comprovam importação real nem fidelidade audiovisual.

Aceitação real: usar uma montagem curta com falas e B-rolls, conferir a prévia no Decupa, criar o projeto no Resolve, comparar cortes, sincronismo, mídias e pendências, exportar `.drp` e reabri-lo. Repetir o fluxo de entrega sem template. Conferir uma segunda revisão sem alterar a primeira no Resolve. Chamadas pagas continuam sujeitas a autorização específica; o desenho não as executa nem autoriza por si só.

## Limites e próxima etapa

Fora do escopo: marketplace, compartilhamento multiusuário, treinamento de IA, reprodução automática arbitrária de animações, montagem direta por API paralela ao OTIO, sincronização de edições de volta do Resolve e empacotamento de mídias.

As duas frentes compartilham o contrato de revisão aprovada e podem ser planejadas em etapas: entrega nativa comum, biblioteca/validação e aplicação editorial. A especificação deve ser revisada pelo usuário antes da criação do plano de implementação. A aprovação desta especificação permite planejar; implementação depende da revisão do plano e escolha do método de execução.

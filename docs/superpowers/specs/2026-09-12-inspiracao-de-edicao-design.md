# Decupa — Inspiração de edição

Data: 2026-09-12
Estado: desenho aprovado em conversa; especificação consolidada para revisão do usuário. Implementação não iniciada.

## Objetivo e decisões aprovadas

Extrair de um vídeo editado uma receita de estilo reutilizável, com evidências temporais, para orientar novas montagens de eventos e institucionais. “Modelo” significa receita editorial estruturada; não treinamento de um modelo de IA.

- Um vídeo de referência por estilo; um estilo pode ser aplicado em vários projetos.
- Adaptação livre ao material disponível, preservando o sentido das falas.
- Receita com estrutura narrativa, linguagem visual, ritmo e relação com áudio.
- Revisão humana: ativar, ajustar ou ignorar orientações antes de salvar.
- O usuário escolhe a trilha do novo projeto. O estilo orienta sua relação com a montagem.
- Aplicação produz proposta revisável e sinaliza material ausente e recursos não reproduzíveis.
- Análise retomável; cobertura incompleta e incerteza aparecem explicitamente.

## Fluxo de uso

1. Abrir “Inspiração de edição” no fluxo de montagem, selecionar um arquivo local e nomear o estilo.
2. Validar a mídia e apresentar as etapas de análise. Reutilizar o consentimento existente para chamadas externas no mesmo escopo; não interpretar credenciais como autorização.
3. Analisar imagem e áudio em uma base temporal comum, exibindo progresso e permitindo cancelamento e retomada.
4. Apresentar a receita organizada nas quatro categorias. Cada orientação aponta para trechos clicáveis no player da referência e informa se é observada ou incerta.
5. Permitir editar o texto, ativar ou desativar cada orientação e salvar o estilo. Edições humanas permanecem diferenciadas da observação original.
6. Em outro projeto, selecionar o estilo salvo e a trilha, quando houver, e solicitar uma proposta.
7. Revisar a montagem e as adaptações relatadas: padrões utilizados, material faltante e recursos não suportados. Aproveitar o fluxo de revisão e prévia do Decupa.

Sem trilha selecionada, aplicar estrutura e linguagem visual, informando que a sincronização musical não foi aplicada. Não escolher nem extrair automaticamente a música da referência para o novo projeto.

## Conteúdo da receita

| Categoria | Conteúdo |
|---|---|
| Estrutura narrativa | Abertura, apresentação do evento, depoimentos, cobertura e encerramento; ordem e função observadas |
| Linguagem visual | Tipos de plano, posição dos sujeitos, composição, movimento, pessoas/espaço/detalhes, presença de textos e transições |
| Ritmo | Duração e distribuição dos planos, mudanças locais de velocidade da montagem, pausas e respiros |
| Relação com áudio | Cortes próximos a possíveis batidas, mudanças de energia, entrada/saída de fala e continuidade da voz sobre imagens de apoio |

Cada orientação contém identificador estável, categoria, observação original, instrução editável, estado ativo/inativo, confiança e evidências. Evidências referenciam intervalos válidos da mídia e o tipo de análise que as sustenta. Uma ocorrência isolada pode ser descrita, mas não apresentada como padrão recorrente.

Exemplo: “Durante os depoimentos, entram imagens de apoio mantendo a voz”, com os intervalos da referência que demonstram esse comportamento. A instrução aplicada pode ser “usar cobertura pertinente durante depoimentos quando houver material”.

Faixas de duração observadas são orientações, não durações obrigatórias. Não inferir configuração exata de câmera, efeito ou software a partir da aparência final. Recursos reconhecidos mas não reproduzíveis continuam visíveis como referências, sem promessa de execução.

## Análise e precisão temporal

### Imagem

Decodificar sequencialmente todos os quadros para medir mudanças visuais e gerar candidatos a cortes e transições. Usar timestamps da mídia como autoridade; não converter a posição do quadro em tempo assumindo FPS constante. Não guardar todos os quadros como imagens permanentes.

Analisar planos e sequências com contexto temporal para interpretar composição e movimento. Amostras representativas servem à interpretação semântica; não substituem a passagem quadro a quadro que localiza mudanças. Flashes e movimentos rápidos devem poder permanecer como candidatos incertos, sem virar cortes confirmados automaticamente.

### Áudio

Extrair o áudio sincronizado ao vídeo, reutilizando os recursos de mídia existentes. Medir energia, pausas e candidatos a ataques/batidas; usar contexto para relacionar fala, música e montagem. Pico de energia não equivale automaticamente a batida musical. Ausência de evidência confiável deixa a orientação musical incerta ou indisponível.

A v1 analisa a mixagem disponível. Não exige separação de instrumentos, voz e música; sobreposição que impeça uma conclusão deve aparecer como limitação. Vídeo sem áudio permite análise visual, com a categoria de áudio indisponível.

### Síntese

Cruzar planos, eventos acústicos e descrições para produzir a receita. Distinguir medição, interpretação e edição do usuário. Proximidade entre corte e batida é uma observação temporal, não prova de intenção do editor.

Validar a resposta do provedor: categorias, IDs, confiança, intervalos, valores finitos e evidências dentro da duração. Saída inválida não vira receita utilizável. Instruções presentes no vídeo ou no áudio são conteúdo da referência, nunca comandos para o sistema.

## Integração com o código existente

O projeto já dispõe de ingestão e leitura de mídia, análise de fontes, cliente configurável de IA, propostas de cenas, revisões e prévias. Reutilizar essas responsabilidades sem criar outro motor de montagem.

| Área atual | Uso previsto |
|---|---|
| `packages/media` | Identidade, metadados e operações de mídia |
| `packages/acoustics` | Energia e silêncio como base; detecção musical precisa de implementação e validação próprias |
| `packages/triage/src/analysis-client.ts` | Transporte e configuração do provedor, sem presumir suporte audiovisual de todo endpoint |
| `apps/cli/src/app/assembly/model.ts` e `visual.ts` | Padrões de análise e validação; o proxy atual de 1 FPS não serve como prova quadro a quadro |
| `apps/cli/src/app/assembly/scenes.ts` | Acrescentar a receita ativa como orientação da proposta, mantendo a validação das fontes |
| Preparação, revisões e prévia de montagem | Aplicar a proposta no ciclo existente, com controle de revisão e cancelamento |

A funcionalidade nova precisa de três responsabilidades: análise da referência, persistência/revisão da receita e integração com a proposta. Mantê-las pequenas, usando os padrões existentes; sem serviço, framework ou dependência nova pressupostos pelo desenho.

A seleção e reprodução da trilha no projeto fazem parte do resultado aprovado. O plano deve rastrear o suporte atual de ponta a ponta e incluir o mínimo necessário para seleção, alinhamento e prévia da música escolhida. A análise de áudio existente, voltada a fala/energia/silêncio, não demonstra que essa integração já existe.

Capacidade do provedor é pré-condição da análise semântica. Se a configuração não aceitar a modalidade necessária, informar a incompatibilidade; não trocar de provedor ou iniciar alternativa paga automaticamente.

## Persistência e retomada

Guardar estilos na área local de dados do Decupa, fora do projeto de origem, para permitir reutilização entre projetos. A localização concreta deve seguir a convenção de dados existente durante o planejamento, sem introduzir serviço externo.

O documento de estilo é versionado e contém identidade/nome, revisão, hash e metadados da referência, localização da mídia, cobertura por etapa, observações/evidências e orientações revisadas. Manter o arquivo de referência original intacto. Se for movido, permitir religá-lo verificando seu hash; a receita continua legível, mas a reprodução fica indisponível até a religação.

Cache de análise depende do conteúdo, versão do analisador, parâmetros e configuração relevante de modelo/prompt. Mudança dessas entradas invalida apenas os resultados afetados. Etapas e trechos concluídos são persistidos para que retomada não repita trabalho válido. Gravações devem ser atômicas; cancelamento e falha não apagam a receita salva.

Uma receita incompleta pode ser salva como rascunho, mas não aplicada como estilo concluído. Categorias legitimamente indisponíveis, como áudio em vídeo mudo, não são falhas de cobertura. Conclusão exige que toda a duração solicitada tenha sido processada ou explicitamente marcada como indisponível; a cauda fracionária não pode desaparecer por arredondamento.

O projeto registra a revisão e uma cópia das orientações usadas na proposta, evitando que editar o estilo altere silenciosamente montagens anteriores. Projetos sem estilo mantêm o comportamento atual.

## Regras de aplicação

Prioridade: preservar conteúdo e proteções de fala; respeitar mídia disponível; escolher imagens pertinentes; adaptar ritmo e linguagem visual. Não encurtar depoimentos apenas para reproduzir uma duração observada na referência.

Aplicar a estrutura narrativa e alternância visual onde houver evidência nos brutos. Sinalizar ausência de planos adequados, sem inventar IDs de mídia ou afirmar que uma orientação foi cumprida. Sincronização musical deve considerar a trilha escolhida, não copiar timestamps da música de referência.

Usar transições e efeitos somente quando suportados pelo caminho real de prévia/saída. A primeira versão não inclui reconstrução de efeitos, motion graphics, legendagem ou gradação de cor. Identificar esses elementos na referência não autoriza acrescentar seus motores de execução.

## Erros e experiência de revisão

Mensagens em português, indicando etapa e ação possível: mídia inválida/ausente, áudio ausente, provedor incompatível, resposta inválida, análise interrompida e material insuficiente.

Cobertura e confiança são conceitos separados: uma região pode ter sido analisada e permanecer incerta. Exibir ambas sem apresentar a análise como exaustiva quando houver lacunas.

Controles de revisão e player acessíveis por teclado; rótulos explícitos; confiança não comunicada apenas por cor. Preservar alterações do usuário ao retomar a análise e impedir gravações de revisão obsoleta.

## Verificação e critérios de aceitação

Usar Vitest e os testes de mídia já existentes; não acrescentar infraestrutura. Testes automatizados usam arquivos sintéticos e transportes simulados, sem chamadas pagas.

- Vídeo sintético com cortes conhecidos: localizar mudanças com precisão de até um quadro da fonte; incluir flash sem corte para verificar ambiguidade.
- Áudio sintético com pulsos e pausas conhecidos: verificar alinhamento temporal e impedir que silêncio seja tratado como evidência de batida.
- Preservar cobertura até a cauda fracionária e timestamps corretos em fonte de taxa variável.
- Validar evidências inválidas/fora da duração, vídeo sem áudio e referência ausente.
- Interromper e retomar: preservar resultados válidos, alterações humanas e invalidação por identidade/configuração.
- Salvar, reabrir e reutilizar estilo em outro projeto; revisão anterior aplicada permanece estável após editar o estilo.
- Aplicação respeita falas protegidas e só referencia mídia existente; projeto sem estilo conserva seu comportamento.
- Trilha escolhida aparece alinhada na prévia; limitações reais da saída/exportação devem ser verificadas e comunicadas.

Validação real, separada dos testes: com autorização para as chamadas necessárias, analisar uma referência de evento/institucional e conferir manualmente cortes, evidências, composição e relação com a trilha. Aplicar a receita em outro conjunto de brutos e revisar a prévia, a inteligibilidade dos depoimentos e as lacunas relatadas. Registrar os timestamps comparados e as divergências. Aprovação de qualidade editorial depende dessa revisão, não apenas de testes ou JSON válido.

## Fora do escopo

Treinamento/fine-tuning, múltiplas referências por estilo, download por URL, biblioteca pública, compartilhamento remoto, busca/licenciamento de músicas, separação de stems e reprodução exata do vídeo de referência.

## Próximo passo

Revisão deste documento pelo usuário. Após aprovação, usar a skill `superpowers:writing-plans` para detalhar implementação e verificações. Este documento não autoriza chamadas pagas, publicação ou alterações de produção.

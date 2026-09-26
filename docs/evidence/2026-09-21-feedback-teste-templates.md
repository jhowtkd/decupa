# Feedback do teste — templates, materiais e pausas

- Barra de análise mostra etapa atual de quatro e descreve a tarefa; não simula percentual de processamento de imagens.
- Botões Fala/Apoio aparecem no cartão. Incluir/excluir, religar e ver original continuam nas opções secundárias; categoria `both` antiga é preservada até uma escolha explícita.
- Novos takes com alinhamento pronto encurtam espaços entre palavras maiores que 300 ms, deixando 50 ms de cada lado e respeitando limites acústicos e regiões protegidas. Não inventa cortes quando o alinhamento falta. Takes existentes reaproveitados preservam as edições manuais.
- Projeto de teste do usuário: base r19 com 67,03 s, r20 com 62,67 s, 13 intervalos removidos. r19 preservada no histórico; aprovação final invalidada. Prévia r20 renderizada pelo app, confirmada no GET /project e visível no navegador. Nenhuma nova chamada paga disparada pelo agente.
- Erro real de entrega r18: API externa sem conexão. Usuário confirmou Resolve gratuito. A API de automação escolhida anteriormente depende do Studio; a promessa de geração automática de projeto não se aplica a esta instalação.
- Entrega padrão agora prepara os arquivos e orienta a importação no Resolve gratuito, seguida de File → Export Project para criar o DRP. Integração automática permanece identificada como Studio. Falhas anteriores à criação permitem retry; falhas após criação preservam o tratamento de projeto parcial.
- Tentativa de concluir pelo Resolve nativo: criado projeto local `Decupa - Dia C - r18`; seletor de timeline mostrou o OTIO, porém Import permaneceu desabilitado. Posteriormente a captura nativa falhou com ScreenCaptureKit -3812. Nenhum DRP foi gerado, importação/aceitação no Resolve não foi comprovada. O projeto de tentativa não foi apagado nem apresentado como entrega concluída.
- 71 testes focados passaram; tipagem e diff check passaram. Não foi executada novamente a suíte completa alheia a estas correções.

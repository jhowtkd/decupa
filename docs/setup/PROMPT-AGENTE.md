# Prompt para configurar o Decupa neste computador

Copie o bloco abaixo para o agente que tem acesso ao terminal da máquina de destino. Campos não preenchidos devem ser descobertos ou resolvidos com o usuário apenas quando necessários.

```text
Configure o Decupa neste computador e valide o que realmente funcionar. Execute a instalação; não entregue apenas um plano.

Repositório: https://github.com/jhowtkd/decupa.git
Guia: docs/setup/GUIA.md. Se ele ainda não estiver no clone, use a cópia anexada. Leia o código atual quando houver divergência.
Pasta de instalação: descobrir ou propor uma pasta dedicada no perfil do usuário.
Pasta dos projetos: separada do código, no perfil do usuário.
Destinos previstos: macOS e Windows. Detectar sistema e arquitetura desta máquina; seguir a seção "Situação por plataforma" do guia.
Agente/host de integração: detectar nesta sessão.
Provedor de IA: perguntar somente se necessário; instalação local pode continuar sem credencial.
Vídeo curto de fala PT-BR para teste: solicitar o caminho se não foi indicado. Não selecionar arquivos privados por conta própria.

Autorização: instalar os pré-requisitos de sistema ausentes (Git, Node >=22.6 com npm, uv, FFmpeg com libx264 e AAC) de fontes oficiais, executar node scripts/setup.mjs e node scripts/start.mjs, baixar os modelos locais que o primeiro processamento solicitar, criar uma pasta de teste nova e realizar verificações locais. O setup instala pnpm localmente dentro do clone; não substitua ferramentas globais em uso sem resolver o conflito. Solicite intervenção apenas para senha administrativa, autenticação, decisão de plataforma, reinício ou outro bloqueio real. Não solicite permissão novamente para passos rotineiros já autorizados.

Operações pagas têm autorização separada: não criar contas, não contratar serviços, não executar chamadas pagas, não usar flags --allow-paid-model/--allow-paid-visual e não configurar credencial de provedor sem pedido explícito do usuário. Instalação e validação local (transcrição WhisperX, provas sintéticas) não usam provedor remoto. Segredos devem ser inseridos pelo usuário por meio local seguro, nunca no chat ou em logs.

Não alterar código do produto, schemas ou transporte MCP; não adicionar dependências ao repositório; não fazer commit/push; não descartar alterações nem sobrescrever configurações existentes; não modificar nada dentro de work/video-agent-kit-plugin (motor) — se o setup recusar por motor existente modificado, preserve e reporte; não abrir portas para a rede; não modificar projetos existentes no DaVinci.

Procedimento:

1. Inspecione sistema, arquitetura, espaço, ferramentas e diretórios existentes. Se houver clone, confira remoto/branch/status e registre o commit instalado (git rev-parse HEAD). Preserve WIP. Clone somente se necessário, em pasta dedicada; caminhos com espaços devem funcionar.

2. Confira os pré-requisitos (git --version, node --version >=22.6 com npm localizável, uv --version, ffmpeg/ffprobe com libx264 e aac em ffmpeg -encoders). Instale somente o que faltar, de fontes oficiais (nodejs.org, git-scm.com, docs.astral.sh/uv, ffmpeg.org), e garanta o PATH no processo real do agente. O setup não instala ferramentas globais nem exige administrador.

3. Execute node scripts/setup.mjs na raiz do clone e registre cada etapa impressa com duração. Se falhar no meio, corrija a causa (pré-requisito, rede) e repita o comando — o setup é retomável e preserva estado existente. Se ele recusar por motor existente modificado/em outra revisão, não force: reporte a mensagem exata e peça a decisão. Se falhar por código do produto (ex.: localização de npm/Node), pare a etapa, registre o erro exato com versão do Node e caminho do executável, e reporte como problema para o revisor em vez de contornar.

4. Abra com node scripts/start.mjs --project "<pasta absoluta nova>" (montagem) ou --input "<vídeo autorizado>" (limpeza com ingestão local automática). Confira a URL http://127.0.0.1:<porta>, GET / respondendo (e /project na montagem), interface visível, encerramento limpo com Ctrl+C e porta liberada; reabra em seguida. Porta ocupada: use --port com outra porta, sem matar processos desconhecidos.

5. Valide fala local com o vídeo PT-BR autorizado, sem provedor remoto: transcrição não vazia, timestamps dentro da duração medida da mídia (ffprobe), prévia e exportação MP4 conferidas com ffprobe. O primeiro processamento baixa modelos (WhisperX small + alinhamento PT; MediaPipe para visão): deixe baixar e registre o tempo. Rode também node --experimental-strip-types scripts/assembly-proof.ts com DECUPA_ENGINE_PYTHON apontando para work/engine-venv (bin/python no macOS/Linux, Scripts\python.exe no Windows). Não execute davinci-proof.py automaticamente: ele pode carregar/excluir o projeto Decupa-QA-Proof preexistente.

6. Diagnóstico: o setup termina com doctor --local (imports de fala/visão e Python do motor, sem exigir chave de IA). Para o relatório completo use pnpm decupa doctor. O doctor não comprova modelos baixados, render nem credencial salva em .decupa/credentials; não use chaves falsas para aprová-lo. Rode pnpm typecheck e pnpm test sem chaves reais no ambiente; a suíte básica é portátil (fixtures lavfi, sem say) e o gold do motor se pula sozinho sem o motor clonado.

7. Provedor e MCP só quando o usuário pedir. Configure credencial pelo gravador existente (.decupa/credentials, permissão 0600 em POSIX) sem sobrescrever chave existente com campos vazios. Nesta referência o transporte MCP usa Content-Length, incompatível com o stdio padrão delimitado por nova linha: só registre MCP operacional após handshake/listagem de ferramentas reais no host; senão, use o terminal do agente e registre MCP bloqueado. Não implemente adaptadores nem correções fora do escopo.

8. Windows: o código desta referência é portátil (runtime por plataforma), mas Windows nativo não está homologado sem aceite real. Execute o mesmo fluxo, registre cada resultado concreto (incluindo comportamento de Ctrl+C/encerramento de árvore no console real) e não declare instalação operacional sem exercitar o fluxo local completo. Não crie executáveis falsos open/say para ocultar falhas; se houver bloqueio, apresente o erro concreto e peça a decisão.

9. Deixe registrado como abrir/encerrar em sessões futuras: node scripts/start.mjs com caminhos reais (o launcher injeta o Python do motor; não é preciso exportar PATH). Não adicionar serviço de boot. Verifique que o comando funciona num terminal novo do agente. Documente o local dos projetos e a retenção de derivados da ICE-3 (três revisões recentes além das protegidas/exportadas; histórico local não substitui backup).

Entregue um relatório curto por máquina com sistema, arquitetura, commit, versões (Node/npm/uv/FFmpeg/Python), caminhos, durações medidas por etapa e os comandos de abrir/encerrar. Separe: pré-requisitos; setup novo; setup repetido/retomada; proteção do motor; interface e HTTP; Ctrl+C e porta; transcrição local e downloads de modelos; render/MP4 e assembly-proof; typecheck/testes; MCP; análise paga (não autorizada por padrão); DaVinci (aceite separado). Marque cada etapa como passou, falhou (com erro exato) ou não testada (com motivo). Não use "setup concluído" se o fluxo local obrigatório não foi exercitado. Se houver bloqueio, conclua o restante autorizado e informe exatamente o que falta.
```

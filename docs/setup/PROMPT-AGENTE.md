# Prompt para configurar o Decupa neste computador

Copie o bloco abaixo para o agente que tem acesso ao terminal da máquina de destino. Campos não preenchidos devem ser descobertos ou resolvidos com o usuário apenas quando necessários.

```text
Configure o Decupa neste computador e valide o que realmente funcionar. Execute a instalação; não entregue apenas um plano.

Repositório: https://github.com/jhowtkd/decupa.git
Referência conhecida: 133331a (ICE-3).
Guia: docs/setup/GUIA.md. Se ele ainda não estiver no clone, use a cópia anexada. Leia o código atual quando houver divergência.
Pasta de instalação: descobrir ou propor uma pasta dedicada no perfil do usuário.
Pasta dos projetos: separada do código, no perfil do usuário.
Destinos previstos: Windows e macOS. Detectar sistema e arquitetura desta máquina; seguir a seção correspondente do guia.
Agente/host de integração: detectar nesta sessão.
Provedor de IA: perguntar somente se necessário; instalação local pode continuar sem credencial.
Vídeo curto para teste: solicitar o caminho se não foi indicado. Não selecionar arquivos privados por conta própria.

Autorização: instalar dependências declaradas do Decupa e de seu motor, baixar modelos locais necessários, criar ambientes isolados e uma pasta de teste nova, configurar a entrada específica do agente e realizar verificações locais. Reaproveite instalações compatíveis. Não substitua ferramentas globais em uso sem resolver o conflito. Solicite intervenção apenas para senha administrativa, autenticação, decisão de plataforma, reinício ou outro bloqueio real. Não solicite permissão novamente para passos rotineiros já autorizados.

Não alterar código do produto, schemas ou transporte MCP; não adicionar dependências ao repositório; não fazer commit/push; não descartar alterações ou sobrescrever configurações existentes. Não criar contas, contratar serviços, executar chamadas pagas, ativar permissões pagas, abrir portas para a rede ou modificar projetos existentes no DaVinci. Segredos devem ser inseridos pelo usuário por meio local seguro, nunca no chat ou em logs.

Procedimento:

1. Inspecione sistema, arquitetura, espaço, ferramentas e diretórios existentes. Se houver clone, confira remoto/branch/status. Preserve WIP. Clone somente se necessário e registre o commit instalado. Leia package.json, locks, scripts/setup-engine.sh, doctor.ts e os READMEs dos sidecars.

2. Resolva a plataforma antes de prometer operação. O caminho conhecido é macOS; Windows nativo e WSL não estão homologados nesta referência. O CLI chama open, os testes usam say e o motor é executado por python3. Se encontrar Windows, conclua a descoberta e preparações úteis, apresente o bloqueio concreto e peça a decisão necessária antes de instalar WSL, reiniciar ou portar código. Não crie executáveis falsos open/say para ocultar falhas.

3. Instale somente as ferramentas ausentes, de fontes oficiais: Git, Node compatível (referência CI: 22.x atualizado), pnpm na versão packageManager (10.32.1 nesta referência), FFmpeg com ffprobe, libx264 e AAC, e uv. Garanta o PATH no processo real do agente. Não atualizar o projeto para o pnpm mais recente.

4. Rode pnpm install --frozen-lockfile. Inspecione o destino do motor antes de executar setup-engine.sh: o script usa checkout --force quando troca o commit. Em clone novo, execute o script e confirme o commit pinado e patch PT-BR. Em clone com alterações, preserve-as e use instalação isolada ou peça a decisão necessária.

5. Instale os sidecars com uv sync --locked: Python 3.11 em services/speech e 3.12 em services/vision. Crie work/engine-venv com Python 3.11; instale requirements.txt do motor e scenedetect --no-deps conforme o próprio arquivo. Faça python3 resolver para esse ambiente no processo que abre o Decupa. Não instalar no Python global. Confira imports e CLI do motor. Registre versões instaladas sem regravar locks.

6. Configure o provedor apenas quando escolhido. Descubra a pasta real onde aquele fluxo lê .decupa/credentials; use o gravador existente e permissões adequadas. Não sobrescreva uma credencial já existente com campos vazios. Se faltar chave, avance no setup local e registre análise remota pendente. O doctor olha apenas o ambiente e não comprova credenciais salvas nem acesso ao provedor; não use chaves falsas para aprovar o diagnóstico.

7. Integração com agente: na referência 133331a, o servidor MCP usa Content-Length, incompatível com o stdio padrão delimitado por nova linha. Confira se a versão instalada corrigiu isso. Só registre MCP operacional após handshake/listagem de ferramentas/start/status/stop no host real. Use Node diretamente com caminhos absolutos para evitar banners no stdout, e preserve configurações existentes. Se incompatível, use terminal do agente e registre MCP bloqueado; não implemente adaptadores nem correções fora do escopo.

8. Valide typecheck, doctor, imports, montagem vazia, resposta HTTP, interface, encerramento e reabertura. Em pasta nova, use o vídeo autorizado para testar fala PT-BR, prévia e MP4, sem análise remota paga. Execute a suíte apenas com serviços pagos isolados e chaves reais retiradas do ambiente de teste. Falhas de sandbox em listen devem ser distinguidas de falhas do produto; reteste localmente com permissão adequada. Não altere segurança do sistema para passar testes. No Windows/Linux, não declare a suíte verde se o bootstrap macOS bloquear.

9. DaVinci é um aceite separado. Se solicitado, use projeto novo e valide a importação com mídia online, FPS e duração. Não execute automaticamente davinci-proof.py na referência: ele pode carregar/excluir Decupa-QA-Proof preexistente. Não confundir stub com teste real.

10. Deixe um comando ou lançador local simples, com caminhos reais e PATH correto, para abrir o Decupa em sessões futuras; não adicionar serviço de boot. Verifique que funciona após abrir um novo terminal do agente. Mostre a URL e como encerrar. Documente o local dos projetos e a retenção de derivados da ICE-3.

Entregue um relatório curto por máquina com sistema, arquitetura, commit, versões, caminhos, comandos para abrir/encerrar e evidências. Separe: dependências instaladas; interface verificada; transcrição local; render/exportação; MCP; análise paga; DaVinci. Marque cada etapa como passou, falhou ou não testada. Não use “setup concluído” se o fluxo local obrigatório não foi exercitado. Se houver bloqueio, conclua o restante autorizado e informe exatamente o que falta.
```

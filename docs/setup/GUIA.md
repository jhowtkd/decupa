# Instalar o Decupa em outro computador

Referência: branch `feat/setup-simplificado`, atualizada em 14/09/2026. Registre o commit instalado com `git rev-parse HEAD`. Repositório: https://github.com/jhowtkd/decupa.
Este guia instala o código existente; não é um instalador nem uma certificação de compatibilidade.
O prompt para entregar ao agente está em [PROMPT-AGENTE.md](PROMPT-AGENTE.md).
O resultado do aceite real por plataforma está na [evidência de 14/09/2026](../superpowers/evidence/2026-09-14-setup-simplificado.md).

## 1. Instalar e abrir: dois comandos

Na raiz do clone do Decupa:

```bash
node scripts/setup.mjs
node scripts/start.mjs --project "/caminho/absoluto/Meu Projeto"
```

`node scripts/setup.mjs` prepara tudo uma vez, com etapas nomeadas em PT-BR:

1. Confere os pré-requisitos da tabela abaixo e aponta links oficiais quando falta algo.
2. Instala o pnpm 10.32.1 **local** em `work/setup-tools` (usando o npm que acompanha o Node; nenhuma ferramenta global é alterada) e instala as dependências JS com `pnpm install --frozen-lockfile`.
3. Instala o motor de condense em `work/video-agent-kit-plugin` no commit pinado `d9fe30076c00ce2968d570622dd22ba068337568`, com o patch PT-BR aplicado. Nunca usa force/reset/stash: motor existente é preservado (seção 5).
4. Instala Python 3.11/3.12 via uv e cria os três ambientes isolados (seção 4).
5. Testa o motor (`condense.py --help`) e roda o diagnóstico local (`doctor --local`), que dispensa chave de IA.
6. Baixa e carrega os modelos padrão de fala (Whisper small, VAD e alinhamento PT-BR) e visão (MediaPipe). Só declara sucesso se todos carregarem.

`node scripts/start.mjs` abre o Decupa sem configurar PATH:

- `--project <pasta>` abre a montagem multiarquivo (cria ou reabre o projeto na pasta).
- `--input <vídeo>` abre a tela de limpeza e inicia a ingestão local automaticamente (transcrição PT-BR com WhisperX, sem provedor remoto).
- Informe **exatamente uma** das duas fontes; `--port N` é opcional (padrão 7788). O launcher não tem flags pagas de propósito.
- O servidor responde em `http://127.0.0.1:<porta>` e o navegador abre sozinho (apenas URL loopback). O Python do motor é injetado no ambiente pelo launcher.
- **Ctrl+C** encerra: fecha o servidor, mata os subprocessos e libera a porta.

Caminhos absolutos e com espaços funcionam — os scripts não passam por shell.

## 2. O que preparar antes

- Acesso do usuário aos repositórios `jhowtkd/decupa` e `jhowtkd/video-agent-kit-plugin`.
- Pasta de instalação e pasta separada para projetos.
- Um vídeo curto de fala PT-BR autorizado para validação local.
- Provedor de IA: na máquina do funcionário, defina `DECUPA_COMPANY_API_KEY` (e `DECUPA_COMPANY_PRESET` se não for Z.ai) **antes** do setup — o formulário é pulado. Sem isso, a primeira abertura pede a chave no app. Nunca envie a chave no prompt.
- Internet para baixar dependências e modelos. Transcrição local usa CPU por padrão; GPU não é requisito do código atual. Não há mínimo de RAM/disco homologado: medir no computador antes de prometer desempenho.

O agente deve instalar os pré-requisitos ausentes antes de executar o setup, conforme o prompt. Pré-requisitos de sistema — o script confere todos e **não instala nenhum deles** (sem ferramentas globais, sem administrador):

| Ferramenta | Versão/observação | Instalação oficial |
|---|---|---|
| Git | versão recente (aceite conferido com 2.54) | https://git-scm.com/ |
| Node.js **com npm** | >= 22.6 (referência de CI: 22.x) | https://nodejs.org/ |
| uv | recente (aceite conferido com 0.11.6) | https://docs.astral.sh/uv/ |
| FFmpeg e ffprobe | com encoders `libx264` e `aac` — o setup confere `ffmpeg -encoders` | https://ffmpeg.org/ |

Não é preciso instalar pnpm global: o setup instala pnpm 10.32.1 dentro do clone. Reaproveite versões compatíveis já instaladas e não substitua outra instalação de Node usada por projetos existentes. O PATH precisa valer também para o processo do agente, não apenas para o seu terminal.

## 3. Modelos instalados durante o setup

O setup baixa e carrega os modelos antes de declarar a instalação concluída, usando os mesmos carregadores do processamento real:

- Fala em CPU: Whisper `small` (~464 MB), detector de fala (VAD) e alinhamento PT-BR (~2,4 GB). Os downloads do HuggingFace reutilizam o cache do usuário e respeitam sua configuração de cache.
- Visão: MediaPipe Face Landmarker e Hand Landmarker (~11 MB) em `services/vision/.models/`.

Aguarde essas etapas: conexão indisponível, download incompleto ou falha ao carregar um modelo fazem o setup terminar com erro. Corrija a causa e repita `node scripts/setup.mjs`; os caches existentes são reutilizados, sem apagar dados.

O primeiro vídeo com os modelos padrão usa esse cache, desde que rode com o mesmo usuário e configuração. Trocar idioma/modelo ou remover o cache pode exigir novos downloads. Transcrição continua local (CPU); downloads de arquivos não são chamadas a um provedor de IA. A configuração do provedor (arquivo `~/.decupa/credentials` ou o formulário, se o ambiente não tiver chave) é obrigatória antes de análise paga, mesmo que a transcrição em si rode localmente.

Registre o tempo de instalação dos modelos separado do processamento do vídeo. As medições anteriores de setup (44 s/4 s) e ingestão (158 s para vídeo de 107 s) ocorreram antes desta etapa obrigatória e não estimam uma instalação fria atual. Carregar os modelos comprova sua disponibilidade, mas o teste com vídeo continua necessário para validar transcrição e render.

## 4. Onde fica cada coisa

| Caminho | Conteúdo |
|---|---|
| `work/setup-tools/` | pnpm 10.32.1 local (o pnpm global não é tocado) |
| `node_modules/` | dependências JS da workspace |
| `work/video-agent-kit-plugin/` | motor de condense pinado + patch PT-BR |
| `work/engine-venv/` | Python 3.11 do motor (`requirements.txt` do motor + `scenedetect --no-deps`) |
| `services/speech/.venv/` | sidecar de fala — Python 3.11, WhisperX |
| `services/vision/.venv/` e `services/vision/.models/` | sidecar de visão — Python 3.12, MediaPipe e modelos |
| pasta passada em `--project` | projeto de montagem (mantenha fora da pasta do código) |
| `.decupa-<nome>/` ao lado do vídeo | derivados da limpeza (transcrição, índice, plano, render) |

`work/`, `.venv` e derivados são ignorados pelo Git. O `--no-deps` do scenedetect segue a orientação do `requirements.txt` do motor para evitar duas distribuições conflitantes de OpenCV. Não copie `node_modules`, `.venv`, a pasta `work` ou credenciais de outro computador: instale para o sistema e a arquitetura de destino.

Para chamar o CLI diretamente sem o launcher (`pnpm decupa ...`), aponte `DECUPA_ENGINE_PYTHON` para `work/engine-venv/bin/python` (`work\engine-venv\Scripts\python.exe` no Windows) — é exatamente o que o `start.mjs` faz.

## 5. Instalação falhou no meio: retomada e proteção do motor

- O setup é retomável: **repita `node scripts/setup.mjs`**. Ele inspeciona o estado existente, continua de onde parou e não faz reset forçado de nada.
- Motor existente em `work/video-agent-kit-plugin` nunca é sobrescrito. Se só estiver modificado, o setup avisa e **continua** (Python, modelos, credencial). Se estiver em outra revisão, use `node scripts/setup.mjs --keep-engine` para preservar e seguir; clone inválido ainda aborta. Restaurar o motor continua sendo decisão sua.
- Se `work/engine-venv` existir sem um Python válido, o setup falha informando o caminho e pedindo para remover a pasta manualmente — ele não apaga nada automaticamente.
- Porta ocupada: escolha outra com `--port`, sem encerrar processos desconhecidos.
- `bash scripts/setup-engine.sh` continua existindo, mas apenas delega para `node scripts/setup.mjs --engine-only` (mesma instalação segura, sem lógica Git duplicada).

## 6. Situação por plataforma

| Sistema | Situação nesta referência |
|---|---|
| macOS arm64 | Aceite real em 14/09/2026 (commit `5c9bd89`): **aprovados** setup novo (44 s com caches quentes) e repetido (4 s, idempotente), proteção do motor com recusa WIP, caminhos com espaços, servidor de montagem (GET 200, SIGINT/Ctrl+C com porta fechada, porta ocupada com erro claro, reabertura), fala local PT-BR (ingestão de vídeo de 107 s em 158 s, sem chamada remota) e MP4 baseline do `assembly-proof`. Pendências: a asserção do `assembly-proof` em 29,97 fps falha por 1 frame (achado preexistente, código não mudado nesta branch) e a suíte completa/CI remota não rodaram no clone de aceite. Na 1ª rodada (`029bd6e`) o setup falhava ao localizar o npm do Node Homebrew — corrigido em `5c9bd89`. Detalhes na [evidência](../superpowers/evidence/2026-09-14-setup-simplificado.md). |
| Windows x64 nativo | Código portátil nesta referência (abertura de navegador, Python do motor e encerramento de árvore por plataforma em `apps/cli/src/runtime.ts`; suíte sem `say`; matriz CI macOS+Windows configurada). **Não homologado**: sem aceite em máquina Windows real, embora testes e typecheck tenham passado na [CI Windows/macOS](https://github.com/jhowtkd/decupa/actions/runs/34837104426) antes da adição do preparo de modelos. |
| Windows com WSL2/Linux | Possível caminho de avaliação, ainda sem validação deste produto. Não misture Python/Node do Windows com ambientes Linux nem copie `.venv` entre eles; no DaVinci/Resolve do Windows, religue a mídia se o OTIO conter caminhos Linux. [Instalação oficial do WSL](https://learn.microsoft.com/en-us/windows/wsl/install). |

Se encontrar um bloqueio de plataforma, registre o erro concreto e peça a decisão necessária antes de instalar WSL, reiniciar ou portar código. Não crie executáveis falsos `open`/`say` para ocultar falhas.

## 7. Provedor: chave da empresa no ambiente (funcionários)

Não cole a chave no chat, no Git, nem no prompt de um agente. Ela entra só no ambiente da máquina.

Antes de `node scripts/setup.mjs` (ou da primeira abertura), defina no perfil do usuário ou no MDM:

No zsh interativo o `#` não inicia comentário: não cole explicações na mesma linha do `export`.

```bash
export DECUPA_COMPANY_PRESET=zai
export DECUPA_COMPANY_API_KEY='cole-a-chave-de-analise-aqui'
export TYPESAFE_API_KEY='cole-a-chave-do-jev-aqui'
```

`DECUPA_COMPANY_PRESET` aceita `zai`, `gemini`, `minimax` ou `custom`. A primeira chave é a de análise; a segunda é o Jev (TypeSafe).

Equivalente já reconhecido: `ZAI_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY` ou `DECUPA_API_KEY` (custom também precisa de `DECUPA_BASE_URL` e `DECUPA_MODEL`). O Jev também aceita `TYPESAFE_API_KEY`. Sem `DECUPA_TYPESAFE=0`, gravar a chave do Jev já o deixa disponível neste usuário (o projeto ainda precisa de `.decupa/decision.json` em modo hybrid para usá-lo).

O setup e a primeira abertura gravam `~/.decupa/credentials` com permissão só daquele usuário (`0600` no macOS/Linux; ACL no Windows) e **pulam o formulário**. Arquivo existente não é sobrescrito. A chave não aparece nas respostas HTTP. Para custom, o endpoint precisa ser HTTPS.

Sem essas variáveis, o app continua pedindo provedor e chave na primeira abertura. Configurações incompletas mantêm o app bloqueado. A credencial vale para os próximos projetos.

Salvar valida os campos e o endpoint HTTPS, sem chamada remota: não comprova validade da chave, saldo nem suporte a imagens. A autorização de processamento pago permanece nos controles de cada fluxo. Para montagem com vídeo, selecione um modelo com suporte visual: a análise extrai localmente frames JPEG a 1 FPS e os envia via `image_url`, de modo que o endpoint custom precisa ser compatível com chat/completions e o modelo precisa aceitar imagens. Ações mais curtas que um segundo podem ficar incertas ou indisponíveis. O launcher disponibiliza o provedor configurado para esses controles sem exigir flags no terminal.

Credenciais específicas do projeto têm precedência sobre a configuração do usuário. Configurar a primeira abertura não sobrescreve essas credenciais.


O código oferece presets `zai`, `gemini`, `minimax` e `custom`. Isso não comprova acesso, saldo ou suporte visual de cada modelo. Para custom, são necessários endpoint compatível com chat/completions e nome do modelo.

As variáveis reconhecidas são `ZAI_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY` e `DECUPA_API_KEY`; custom também usa `DECUPA_BASE_URL` e `DECUPA_MODEL`. Evite várias chaves no mesmo processo: a resolução automática prioriza Z.ai, Gemini, MiniMax e custom, nessa ordem.

Alternativa: `.decupa/credentials` na pasta do projeto, com JSON contendo `preset`, `apiKey` e, opcionalmente, `model`/`baseUrl`. Use `writeCredentials` do código existente ou o MCP após validar sua conexão; não coloque o segredo na conversa, em linha de comando, log ou Git. No macOS/Linux, o gravador usa permissão `0600`. Windows exige conferir as permissões locais, sem assumir equivalência de ACL.

Em montagem, use a pasta passada em `--project`. Em limpeza, confirme a pasta calculada pelo servidor para aquele arquivo; não presuma que é a raiz do repositório. `configure_provider` precisa receber `projectDir` explicitamente e substitui o conteúdo salvo: não o use com campos incompletos para atualizar uma chave existente.

**Limite do doctor:** ele consulta as chaves do ambiente, não lê a credencial salva no projeto. Pode reportar ausência de chave mesmo com arquivo válido; não duplique o segredo para deixar o diagnóstico verde. Também não testa a API e pode mostrar uma nota Z.ai mesmo usando outro preset. `doctor --local` dispensa a chave e prova só a prontidão local (imports de fala/visão nos venvs dos sidecars e Python do motor). Não executar chamada paga para validar instalação sem autorização específica.

## 8. MCP: opcional e com bloqueio conhecido

O código oferece `doctor`, `configure_provider`, `start`, `status` e `stop`. Porém, nesta referência o transporte usa cabeçalhos `Content-Length`; o [MCP stdio padrão exige mensagens delimitadas por nova linha](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). Portanto, não prometa que copiar `mcp.json.example` conecta Codex/Cursor/Claude.

Até corrigir e testar o transporte, use o terminal do agente. Se avaliar um host compatível, exija handshake e listagem de ferramentas reais. Use Node com caminho absoluto e argumento absoluto `apps/cli/src/index.ts mcp`, evitando banners do pnpm no stdout; configure cwd e `DECUPA_ENGINE_PYTHON` conforme o formato do host. Preserve as outras entradas MCP. Não crie um adaptador nem altere o protocolo como parte deste guia.

## 9. Aceite por computador

1. Registre sistema, arquitetura, commit e versões (Node/uv/FFmpeg/Python). Execute `node scripts/setup.mjs` — aguarde `doctor --local` e o carregamento dos modelos de fala/visão; explique cada erro. Rode também `pnpm typecheck`.
2. Abra uma montagem vazia: `node scripts/start.mjs --project "<pasta nova>"`. Confira resposta HTTP (GET `/` e `/project` na montagem), interface visível, encerre com Ctrl+C, verifique a porta fechada e reabra o projeto.
3. Com um vídeo curto autorizado, teste transcrição PT-BR local (`--input`), timestamps dentro da duração medida da mídia, prévia e exportação MP4. Registre downloads e duração; uma tela aberta não comprova esse fluxo.
4. Prova sintética de render/OTIO: `node --experimental-strip-types scripts/assembly-proof.ts` com `DECUPA_ENGINE_PYTHON=<clone>/work/engine-venv/bin/python`; confira o MP4 com ffprobe (streams e decodificação sem erro).
5. Se DaVinci fizer parte da entrega, importe OTIO manualmente em projeto de teste e confira mídia online, FPS, duração e cortes. Mídia precisa continuar acessível nos caminhos exportados. Não execute `davinci-proof.py` automaticamente: ele pode carregar e excluir um projeto existente chamado `Decupa-QA-Proof`.
6. A suíte básica é portátil (fixtures gerados pelo FFmpeg/lavfi, sem `say`): `pnpm test` sem chaves reais de provedores. O gold do motor se pula sozinho quando o motor não está clonado. A matriz CI (macOS+Windows) roda remotamente após push autorizado; resultado local não é CI aprovado.

O doctor não comprova downloads de modelos, render nem importação no Resolve.

## 10. Uso e manutenção

- Deixe projetos/mídias fora da pasta do código. Não mova os originais após montar sem tratar os vínculos.
- A ICE-3 poda derivados antigos após render: mantém três revisões recentes, além das protegidas/exportadas. Histórico local não substitui backup.
- Para atualizar um clone limpo: confira `git status`, depois `git pull --ff-only`, repita `node scripts/setup.mjs` e refaça o diagnóstico. Pare em divergência ou WIP; não faça reset/clean.
- Guarde um relatório sem segredos por máquina: o que funciona, o que falta e os comandos de abertura/encerramento com caminhos reais.

# Instalar o Decupa em outro computador

Referência: commit `133331a`, conferido em 14/09/2026. Repositório: https://github.com/jhowtkd/decupa.
Este guia instala o código existente; não é um instalador nem uma certificação de compatibilidade.
O prompt para entregar ao agente está em [PROMPT-AGENTE.md](PROMPT-AGENTE.md).

## 1. O que preparar

- Acesso do usuário aos repositórios `jhowtkd/decupa` e `jhowtkd/video-agent-kit-plugin`.
- Agente com acesso ao terminal do computador e um navegador.
- Pasta de instalação, pasta separada para projetos e um vídeo curto de fala PT-BR para validação local.
- Se for usar análise por IA: provedor, modelo/endpoint quando necessário e credencial inserida localmente pelo usuário. Não enviar a chave no prompt.
- Internet para baixar dependências e modelos. Transcrição local usa CPU por padrão; GPU não é requisito do código atual. Não há mínimo de RAM/disco homologado: medir no computador antes de prometer desempenho.

| Sistema | Situação na versão de referência |
|---|---|
| macOS | Caminho com evidência local e CI. Os comandos abaixo usam bash/zsh. |
| Windows nativo | Não homologado. Há chamadas a `python3`, scripts Bash e abertura via `open`; não basta trocar `brew` por `winget`. |
| Windows com WSL2/Linux | Possível caminho de avaliação, ainda sem validação deste produto. Mesmas limitações de `open` e do fixture `say`; caminhos Linux precisam ser relincados no Resolve do Windows. |

Se o destino for Windows, execute a descoberta e as verificações portáveis com o agente, registre bloqueios e não declare instalação operacional antes de testar o fluxo. Não instalar WSL, reiniciar ou alterar o produto silenciosamente. [Instalação oficial do WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

## Preparação específica no Windows

Comece no PowerShell com verificações somente de leitura:

```powershell
[System.Runtime.InteropServices.RuntimeInformation]::OSDescription
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Get-Command git,node,pnpm,ffmpeg,ffprobe,uv,python3 -ErrorAction SilentlyContinue
wsl --list --verbose
```

O agente pode instalar as dependências ausentes e clonar em uma pasta dedicada, por exemplo `$env:USERPROFILE\Apps\decupa`. Use os instaladores oficiais de [Node.js](https://nodejs.org/en/download), [Git](https://git-scm.com/downloads/win), [FFmpeg](https://ffmpeg.org/download.html) e [uv](https://docs.astral.sh/uv/getting-started/installation/), compatíveis com a arquitetura detectada. Após instalar Node, instale a versão exigida de pnpm:

```powershell
npm install --global pnpm@10.32.1
node --version
pnpm --version
```

Isso prepara ferramentas; não resolve a portabilidade do Decupa. Não misture Python/Node do Windows com ambientes Linux, nem copie `.venv` entre eles.

Há dois caminhos a decidir com o responsável:

- **Windows nativo:** exige uma tarefa separada para tratar abertura do navegador, descoberta do Python, setup do motor e bootstrap dos testes, seguida de validação real. O prompt de instalação não autoriza essa alteração de produto.
- **WSL2:** se aprovado, siga a instalação oficial da Microsoft (`wsl --install` pode exigir administrador/reinício). Instale todas as dependências dentro da distribuição Linux e mantenha o código e seus ambientes ali. Ainda é necessário resolver/testar a abertura por `open`; WSL não elimina esse problema. Para DaVinci no Windows, valide o acesso aos arquivos e religue a mídia se o OTIO contiver caminhos Linux.

Até um desses caminhos ser implementado e validado, registre **Windows: ambiente preparado, operação bloqueada por portabilidade**. Não distribua como instalação pronta.

## 2. Dependências no macOS

Reaproveite versões compatíveis já instaladas. O projeto declara Node >=22; a referência de CI usa Node 22. Prefira uma versão 22.x atualizada. Use pnpm **10.32.1**, conforme `package.json`, mesmo se o site oferecer uma versão mais recente.

Com Homebrew já instalado, instale somente o que faltar:

```bash
brew install git node@22 ffmpeg uv
export PATH="$(brew --prefix node@22)/bin:$PATH"
npm install --global pnpm@10.32.1
node --version
pnpm --version
ffmpeg -version
ffprobe -version
uv --version
```

Se Homebrew não existir, o agente deve consultar a instalação oficial e resolver a permissão administrativa com o usuário. O PATH precisa existir também no processo do agente, não apenas neste terminal. Não substituir outra instalação de Node usada por projetos existentes.

Referências: [Homebrew](https://brew.sh/), [pnpm](https://pnpm.io/installation), [uv](https://docs.astral.sh/uv/getting-started/installation/).

## 3. Código e motor

Exemplo para uma instalação nova. Se a pasta já existir, confira remoto, branch e alterações antes de atualizar; não sobrescreva o diretório.

```bash
mkdir -p "$HOME/Apps"
git clone https://github.com/jhowtkd/decupa.git "$HOME/Apps/decupa"
cd "$HOME/Apps/decupa"
git rev-parse HEAD
pnpm install --frozen-lockfile
bash scripts/setup-engine.sh
```

O script instala o motor em `work/video-agent-kit-plugin`, no commit `d9fe30076c00ce2968d570622dd22ba068337568`, e aplica o patch PT-BR. **Em motor existente, examine o status antes:** o script contém `checkout --force` quando precisa trocar de commit. Preserve mudanças locais ou use um clone separado.

Não copie `node_modules`, `.venv`, credenciais ou a pasta `work` de outro computador. Instale dependências para o sistema e arquitetura de destino.

## 4. Python: três ambientes separados

Execute na raiz do Decupa. Os dois sidecars têm versões diferentes de Python e locks próprios:

```bash
uv python install 3.11 3.12
(cd services/speech && uv sync --locked --python 3.11)
(cd services/vision && uv sync --locked --python 3.12)
```

O motor é chamado por `python3` no PATH. Crie um ambiente separado, dentro de `work` (ignorado pelo Git), e instale as dependências declaradas pelo próprio motor:

```bash
uv venv --python 3.11 work/engine-venv
uv pip install --python work/engine-venv/bin/python -r work/video-agent-kit-plugin/requirements.txt
uv pip install --python work/engine-venv/bin/python --no-deps 'scenedetect>=0.6'
export PATH="$PWD/work/engine-venv/bin:$PATH"
python3 scripts/condense.py --help
python3 scripts/render-assembly.py --help
(cd services/speech && uv run --locked python -c 'import whisperx; print("speech OK")')
(cd services/vision && uv run --locked python -c 'import mediapipe; print("vision OK")')
```

O `--no-deps` de scenedetect é a orientação do `requirements.txt` do motor para evitar duas distribuições conflitantes de OpenCV. Esses comandos não atualizam os locks dos sidecars. O motor usa intervalos de dependências: registre as versões efetivamente instaladas.

Os modelos de fala/alinhamento e visão podem baixar na primeira execução. Importar os pacotes não comprova que os modelos funcionam. [Python via uv](https://docs.astral.sh/uv/guides/install-python/).

## 5. Provedor e credenciais

O código oferece presets `zai`, `gemini`, `minimax` e `custom`. Isso não comprova acesso, saldo ou suporte visual de cada modelo. Para custom, são necessários endpoint compatível com chat/completions e nome do modelo.

Na montagem, o Decupa não envia o vídeo inteiro para a análise visual: extrai localmente frames JPEG a 1 FPS, identifica cada frame pelo segundo da fonte e envia lotes via `image_url`. O endpoint custom precisa ser um endpoint completo compatível com chat/completions, e o modelo precisa aceitar imagens — escolha um modelo que aceite imagens no endpoint informado. Salvar a configuração não verifica saldo, chave ou capacidade remota.

A densidade inicial de 1 FPS é um limite intencional: ações mais curtas que um segundo podem ficar incertas ou indisponíveis na análise visual. A barreira de cobertura visual impede que alegações sem suporte em frames virem evidência de montagem.

As variáveis reconhecidas são `ZAI_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY` e `DECUPA_API_KEY`; custom também usa `DECUPA_BASE_URL` e `DECUPA_MODEL`. Evite várias chaves no mesmo processo: a resolução automática prioriza Z.ai, Gemini, MiniMax e custom, nessa ordem.

Alternativa: `.decupa/credentials` na pasta do projeto, com JSON contendo `preset`, `apiKey` e, opcionalmente, `model`/`baseUrl`. Use `writeCredentials` do código existente ou o MCP após validar sua conexão; não coloque o segredo na conversa, em linha de comando, log ou Git. No macOS/Linux, o gravador usa permissão `0600`. Windows exige conferir as permissões locais, sem assumir equivalência de ACL.

Em montagem, use a pasta passada em `--project`. Em limpeza, confirme a pasta calculada pelo servidor para aquele arquivo; não presuma que é a raiz do repositório. `configure_provider` precisa receber `projectDir` explicitamente e substitui o conteúdo salvo: não o use com campos incompletos para atualizar uma chave existente.

**Limite do doctor:** ele consulta as chaves do ambiente, não lê a credencial salva no projeto. Pode reportar ausência de chave mesmo com arquivo válido; não duplique o segredo para deixar o diagnóstico verde. Também não testa a API e pode mostrar uma nota Z.ai mesmo usando outro preset. Não executar chamada paga para validar instalação sem autorização específica.

## 6. Abrir pelo agente

No macOS, execute na raiz do repositório com o PATH do ambiente do motor:

```bash
export PATH="$PWD/work/engine-venv/bin:$PATH"
pnpm decupa montar --project "$HOME/DecupaProjetos/teste-setup"
```

Mantenha o processo vivo e abra a URL impressa, normalmente `http://127.0.0.1:7788`. `Ctrl+C` encerra. Não use flags `--allow-paid-model`/`--allow-paid-visual` no setup. Para limpeza, após escolher um vídeo de teste:

```bash
pnpm decupa limpar --input "/caminho/absoluto/teste.mp4"
```

A limpeza inicia ingestão local automaticamente. A montagem vazia é preferível para verificar somente a interface. Porta ocupada: escolha outra com `--port`, sem encerrar processos desconhecidos.

Em Windows/Linux, **não trate estes comandos como funcionais sem verificar**: a chamada `spawn("open", ...)` pode emitir erro não tratado quando o executável não existe. Isso é um bloqueio de portabilidade, não um problema de navegador.

### MCP: opcional e com bloqueio conhecido

O código oferece `doctor`, `configure_provider`, `start`, `status` e `stop`. Porém, em `133331a`, o transporte usa cabeçalhos `Content-Length`; o [MCP stdio padrão exige mensagens delimitadas por nova linha](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). Portanto, não prometa que copiar `mcp.json.example` conecta Codex/Cursor/Claude.

Até corrigir e testar o transporte, use o terminal do agente. Se avaliar um host compatível, exija handshake e listagem de ferramentas reais. Use Node com caminho absoluto e argumento absoluto `apps/cli/src/index.ts mcp`, evitando banners do pnpm no stdout; configure cwd e PATH do motor conforme o formato do host. Preserve as outras entradas MCP. Não crie um adaptador nem altere o protocolo como parte deste guia.

## 7. Aceite por computador

1. Registre sistema, arquitetura, commit e versões. Rode `pnpm typecheck` e `pnpm decupa doctor`; explique cada ERR.
2. Confirme imports dos dois sidecars e disponibilidade do motor no mesmo PATH usado pelo agente.
3. Abra montagem vazia, confira resposta HTTP e interface visível, encerre e reabra o projeto.
4. Com um vídeo curto autorizado, teste transcrição PT-BR local, timestamps dentro da mídia, prévia e exportação MP4. Registre downloads e duração; uma tela aberta não comprova esse fluxo.
5. Se DaVinci fizer parte da entrega, importe OTIO manualmente em projeto de teste e confira mídia online, FPS, duração e cortes. Mídia precisa continuar acessível nos caminhos exportados. Não execute `davinci-proof.py` automaticamente: na referência, ele pode carregar e excluir um projeto existente chamado `Decupa-QA-Proof`.
6. No macOS, a suíte completa usa fixtures locais, incluindo `say`/voz Luciana. Execute sem chaves reais de provedores. No Windows/Linux, o bootstrap de testes depende de `say`; registre essa limitação, sem fabricar um PASS nem alterar fixtures silenciosamente.

Referência anterior: 776 testes passaram no computador de origem. Isso não valida o computador novo. O doctor também não comprova downloads de modelos, render nem importação no Resolve.

## 8. Uso e manutenção

- Deixe projetos/mídias fora da pasta do código. Não mova os originais após montar sem tratar os vínculos.
- A ICE-3 poda derivados antigos após render: mantém três revisões recentes, além das protegidas/exportadas. Histórico local não substitui backup.
- Para atualizar um clone limpo: confira `git status`, depois `git pull --ff-only`, reinstale com os locks e repita o diagnóstico. Pare em divergência ou WIP; não faça reset/clean.
- Guarde um relatório sem segredos por máquina: o que funciona, o que falta e os comandos de abertura/encerramento com caminhos reais.

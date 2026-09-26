# Decupa — setup simplificado, etapa 1

## Resultado

Em um clone do Decupa, executar `node scripts/setup.mjs` para preparar dependências locais e diagnosticar pré-requisitos. Depois, `node scripts/start.mjs --project <pasta>` abre a montagem no navegador. Limpeza: `node scripts/start.mjs --input <arquivo>`. O agente é opcional. Não haverá instalador gráfico nesta etapa.

## Restrições globais

- Plataformas de aceite: macOS arm64 e Windows x64 nativo; outras arquiteturas não são declaradas homologadas.
- Node >=22.6; pnpm 10.32.1; fala Python 3.11; visão Python 3.12; motor Python 3.11.
- Nenhuma dependência nova de aplicação; Node stdlib, uv, FFmpeg e testes Vitest existentes.
- Git, Node, uv e FFmpeg/ffprobe são pré-requisitos do sistema; o setup não instala ferramentas globais nem exige administrador.
- Setup instala pnpm 10.32.1 localmente com npm, sem substituir o pnpm global.
- Mensagens ao usuário em PT-BR; caminhos absolutos e com espaços devem funcionar.
- Sem chamadas pagas, credenciais em logs, serviço no boot, atualização automática, push ou publicação.
- Preservar projetos, mídias, credenciais, configurações globais e alterações locais do motor.
- Não alterar API HTTP, formato dos projetos, protocolo MCP nem política de retenção.

O mínimo Node 22.6 reflete o uso de `--experimental-strip-types`, que não existe nas primeiras versões 22.x. Validar também a versão concreta usada nos dois computadores de aceite.

## Comportamento

1. Setup verifica ferramentas e codecs antes de baixar dependências. Falhas mostram todos os pré-requisitos ausentes e links oficiais; sem fingir que instalou o app. Downloads de pacotes ficam restritos à instalação local. Autenticação Git é feita pelo usuário, nunca com token no comando.
2. Setup usa locks existentes para JS/fala/visão. Instala o motor no commit já definido por `scripts/setup-engine.sh`, com o mesmo patch PT-BR. Se houver motor incompatível ou WIP diferente do patch esperado, para sem checkout forçado. Uma segunda execução é segura e pode sincronizar dependências novamente.
3. Python do motor fica em `work/engine-venv`; pnpm local em `work/setup-tools`. Sem manifesto adicional de instalação, sem duplicar ambientes por execução.
4. Launcher verifica dependências locais, inicia o servidor existente, imprime URL e tenta abrir o navegador sem matar o servidor se falhar. Reutiliza os fluxos CLI atuais; monta sem permissões pagas. Uma instância por processo, Ctrl+C encerra seus filhos. Não mata processos por nome e não ocupa uma porta usada silenciosamente.
5. Doctor separa prontidão local de análise remota. Verifica imports reais, executável do motor e patch; ausência de chave não reprova setup local. O comando doctor atual mantém seu modo completo; novo `--local` exclui apenas a dependência de provedor.
6. Modelos pesados continuam baixando no primeiro processamento, com os logs existentes visíveis. Setup não afirma que transcrição funciona antes do teste real com fala; não inventa percentual de download.
7. A suíte básica deixa de depender de `say` quando ninguém usa speech.wav. Windows entra na matriz de CI; testes locais reais de fala/render e cancelamento complementam CI.

## Fora do escopo

MSI/DMG, Electron/Tauri, distribuição assinada, instalador de um clique em máquina sem pré-requisitos, GPU/CUDA, updater, tela de credenciais, migração de dados, compatibilidade MCP e automação do Resolve. Cada um exige plano separado. Não vender esta etapa como experiência final para usuário sem suporte técnico.

## Aceite

- Setup novo e repetido nos dois sistemas; falha interrompida recuperável e motor modificado preservado.
- Abertura com caminho contendo espaços, navegador indisponível, porta ocupada e término sem processos órfãos.
- Doctor local passa sem chave; doctor completo mantém a informação de provedor.
- Testes/typecheck locais e CI, com skips explicitados.
- Transcrição PT-BR real, montagem/prévia/MP4 e reabertura em cada sistema, sem chamadas pagas; evidência registra commit, versões e duração.
- Integração com DaVinci continua aceite separado e não bloqueia este setup quando não executada.

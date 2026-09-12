# Decupa — arranque pelo agente e provedores OpenAI-compatible

Data: 2026-09-12
Estado: design aprovado em conversa (brainstorm). Sem implementação.

## Objetivo

A pessoa inicia o Decupa pelo agente dela (Claude Code, Codex, MiniMax Code, opencode). O agente sobe o app e devolve a URL; preparação e edição continuam na web. A análise (triagem, visual, proposta de cenas) deixa de depender só do transporte Z.ai/GLM: um cliente OpenAI-compatible, com presets.

## Decisões aprovadas

1. No primeiro contato o agente **só liga o app** (doctor + start + URL). Não transcreve nem propõe pelo chat.
2. Superfície: **skill + MCP stdio**. A skill ensina a registrar o MCP; o contrato estável são as tools.
3. Análise: **qualquer endpoint chat/completions**. Presets `zai` | `gemini` | `minimax` | `custom`.
4. MCP também **configura provedor** (URL, modelo, chave). Chave nunca vai para o HTML.
5. Ciclo de vida: o servidor vive na sessão do agente; encerrar a sessão mata o processo (como Ctrl+C hoje). Sem daemon.

## Fora da v1

Daemon/launchd; MCP editando cenas/exportando; UI web de provedor; ASR/TTS de terceiros; instalar o MCP automaticamente em todos os produtos.

## Arquitetura

```
agente (Claude/Codex/MiniMax)
  → skill `decupa` (descoberta)
  → MCP stdio `pnpm decupa mcp`
       doctor | configure_provider | start | status | stop
  → spawn do servidor HTTP atual (127.0.0.1)
  → URL na conversa
  → pessoa edita na web

análise paga (web ou CLI)
  → OpenAiCompatClient.fetch(chat/completions)
  → preset resolve base URL + modelo + env/credentials
```

O MCP é o mesmo binário Node do CLI (`--experimental-strip-types`), sem SDK MCP pesado se der para falar JSON-RPC stdio com o mínimo. Nenhuma dependência nova no `package.json` a menos que o stdio MCP fique ilegível à mão — nesse caso uma lib já usada ou stdlib.

`decupa limpar` / `decupa montar` continuam abrindo o navegador com `open`. O MCP **não** chama `open`: devolve a URL para o agente mostrar. Isso é o que falta hoje (o `open` é opaco para o agente).

## Tools MCP

| Tool | Entrada | Saída |
|---|---|---|
| `doctor` | — | linhas ok/erro do `runDoctor` atual |
| `configure_provider` | `preset`, `model?`, `baseUrl?`, `apiKey?` | preset ativo, modelo, base URL (sem chave) |
| `start` | `mode: limpar\|montar`, `input?`, `project?`, `port?`, flags de consentimento pago | `{ url, port, mode, projectDir? }` |
| `status` | — | servidor vivo ou não, url, porta |
| `stop` | — | ok; mata o filho spawnado por `start` |

`start` com porta ocupada: se o ocupante for um Decupa já nosso, devolve esse `status`; senão tenta a próxima porta (7788–7798) ou erro acionável.

Um `start` por processo MCP. Segundo `start` sem `stop` devolve o `status` atual.

## Credenciais

- Arquivo gitignorado `.decupa/credentials` (JSON: `{ preset, model, baseUrl }` **sem** a chave) + a chave só em env.
- Alternativa aceita: a tool `configure_provider` com `apiKey` grava a chave em `.decupa/credentials` com permissão 0600, nunca em `project.json`.
- `.gitignore` ganha `.decupa/`.
- Resolução: `--provider` explícito > `.decupa/credentials` > env (`ZAI_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY`, ou `DECUPA_API_KEY` + `DECUPA_BASE_URL` + `DECUPA_MODEL`).
- `configure_provider` não dispara chamada de modelo. Consentimento pago na web/CLI permanece (`--allow-paid-model` / `--allow-paid-visual`).

## Cliente de análise

Substituir o transporte de `ZaiClient` por `OpenAiCompatClient` (mesmo `fetch`, `timeout`, retry). O corpo continua `messages` + `response_format: json_object` quando o provedor aceitar; Gemini/MiniMax que não aceitarem `response_format` caem em instrução no prompt (já é o formato JSON pedido).

Presets (URL e modelo default; valores exatos na implementação, conferidos na doc oficial na hora do plano):

| preset | env da chave | papel |
|---|---|---|
| `zai` | `ZAI_API_KEY` | default; Coding Plan atual |
| `gemini` | `GEMINI_API_KEY` | OpenAI-compat do Google |
| `minimax` | `MINIMAX_API_KEY` | OpenAI-compat MiniMax |
| `custom` | `DECUPA_API_KEY` | URL e modelo obrigatórios |

WhisperX e o motor de condense não mudam. Sem chave, a web sobe; triagem/proposta pagas recusam com a mesma honestidade de hoje.

`resolveProvider` deixa de ser `"zai"` só. Gemini **volta** só como preset desse cliente — não se reintroduz o SDK `@google/genai`.

## Skill

Nova `docs/skills/decupa/SKILL.md` (descoberta: “abrir o Decupa”, “ligar a montagem”, “começar o editor”). Passos: `doctor` → `configure_provider` se faltar chave → `start` → colar a URL. Se o MCP não estiver no `mcp.json` do host, a skill aponta para `docs/skills/decupa/mcp.json.example` (`command`: `pnpm`, `args`: `decupa`, `mcp`).

A skill `limpar-fala` permanece para o fluxo editorial via CLI; não é o arranque.

## Erros

Mensagens em pt-BR, acionáveis: binário ausente, motor sem patch, chave do preset, porta, `start` sem `--input`/`--project`. Doctor MCP e CLI compartilham `runDoctor`.

## Testes

- Cliente: `fetch` injetado (os testes atuais de `zai.ts` migram).
- Presets: tabela URL/modelo, sem rede.
- MCP: transporte fake; `start` com servidor injetado (não `open`, não browser).
- `configure_provider` não escreve em `project.json`; escreve só em tmp `.decupa/`.
- Vitest continua zerando chaves live no env.
- Nenhuma chamada paga na suíte.

## Componentes (arquivos previstos)

- `apps/cli/src/mcp/server.ts` — stdio, tools
- `apps/cli/src/index.ts` — comando `decupa mcp`
- `packages/triage/src/openai-compat.ts` — transporte
- `packages/triage/src/provider.ts` — presets + resolve
- `packages/triage/src/zai.ts` — passa a delegar ao compat (ou some o POST duplicado)
- `docs/skills/decupa/SKILL.md` + `mcp.json.example`
- `.gitignore` → `.decupa/`

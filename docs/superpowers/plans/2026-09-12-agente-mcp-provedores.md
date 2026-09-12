# Arranque MCP + provedores OpenAI-compatible — plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** O agente da pessoa liga o Decupa via MCP (`doctor` / `start` / `status` / `stop` / `configure_provider`) e recebe a URL; a análise usa um cliente `chat/completions` com presets zai/gemini/minimax/custom.

**Architecture:** MCP stdio no mesmo CLI (`decupa mcp`). `start` spawna o servidor HTTP atual e **não** chama `open`. Transporte de análise: extrair o POST de `ZaiClient` para `OpenAiCompatClient`; presets só preenchem URL/modelo/env. Credenciais em `.decupa/` gitignorado, nunca no HTML.

**Tech Stack:** TypeScript strip-types, vitest, `fetch`. Sem dependência nova. Sem chamada paga nos testes.

**Spec:** `docs/superpowers/specs/2026-09-12-agente-mcp-provedores-design.md`

## Global Constraints

- Sem `package.json` novo. Sem `.gitignore` alheio (`.foglamp/` do usuário). Acrescentar só a linha `.decupa/`.
- pt-BR em erros, testes e skill.
- `git add` só dos arquivos da tarefa.
- `pnpm test` do recorte + `pnpm run typecheck` no fim de cada tarefa.

---

### Task 1: Cliente OpenAI-compatible

**Files:**
- Create: `packages/triage/src/openai-compat.ts`
- Create: `packages/triage/src/openai-compat.test.ts`
- Modify: `packages/triage/src/zai-client.ts` — `ZaiClient.send` delega ao compat (ou `ZaiClient` vira fachada)

**Step 1:** Teste com `fetchImpl` injetado: 200 devolve `choices[0].message.content`; 503 + retry; timeout; 400 não retenta.

**Step 2:** Ver falhar (módulo ausente).

**Step 3:** Implementar `OpenAiCompatClient` com `baseUrl`, `apiKey`, `model`, `timeoutMs`, `retries`, o mesmo `isRetryable` de `zai-client.ts`. POST `{ model, messages, response_format?, max_tokens }`. Reusar `readChoice`.

**Step 4:** `ZaiClient` usa o compat com `ZAI_DEFAULT_BASE` / `ZAI_DEFAULT_MODEL`. Os testes de `zai.test.ts` continuam verdes.

**Step 5:** Commit `feat: OpenAI-compatible chat client for analysis transport`

---

### Task 2: Presets e resolveProvider

**Files:**
- Modify: `packages/triage/src/provider.ts`
- Modify: `packages/triage/src/provider.test.ts`

Tabela de presets (conferir URLs oficiais na hora de implementar; se a doc mudou, gravar a URL real no código e no teste):

```ts
export type Provider = "zai" | "gemini" | "minimax" | "custom";
```

Resolução: explícito > `.decupa/credentials` (sem chave) > env. Sem chave: erro nomeando a variável do preset. `gemini` deixa de ser “retirado”.

**Commit:** `feat: resolve analysis provider presets including OpenAI-compatible custom`

---

### Task 3: Credenciais gitignoradas

**Files:**
- Create: `packages/triage/src/credentials.ts` + teste
- Modify: `.gitignore` — acrescentar `.decupa/` **no fim**, sem remover `.foglamp/`

`writeCredentials(dir, { preset, model, baseUrl, apiKey? })` grava `.decupa/credentials` mode 0600. `readCredentials` não loga a chave. Recusa path que não seja o dir do projeto.

**Commit:** `feat: store provider credentials under gitignored .decupa/`

---

### Task 4: MCP stdio (doctor, start, status, stop, configure_provider)

**Files:**
- Create: `apps/cli/src/mcp/protocol.ts` — initialize / tools/list / tools/call em JSON-RPC por linha
- Create: `apps/cli/src/mcp/tools.ts` — implementação pura com deps injetadas (`runDoctor`, `startApp`, credentials)
- Create: testes adjacentes com stdin/stdout fake
- Modify: `apps/cli/src/index.ts` — `decupa mcp`

`start` **não** chama `spawn("open")`. Devolve `{ url, port, mode }`. Segundo start sem stop devolve status. Porta ocupada: 7788–7798 ou reusa se for o nosso servidor.

**Commit:** `feat: stdio MCP to doctor, start, and configure Decupa`

---

### Task 5: Skill + exemplo MCP

**Files:**
- Create: `docs/skills/decupa/SKILL.md`
- Create: `docs/skills/decupa/mcp.json.example`

Skill curta: quando a pessoa pedir para abrir o Decupa. Passos doctor → configure se faltar → start → mostrar URL. Sem `open`.

**Commit:** `docs: skill and MCP example to launch Decupa from the user's agent`

---

## Recorte consciente

Não migrar `describeSource` / proposta para outro prompt. Elas já passam pelo mesmo `ZaiClient`/`send`; ao trocar o transporte, herdam o preset. Se algum caminho ainda instancia `ZaiClient` com URL cravada, apontar para `OpenAiCompatClient` resolvido pelo provider — isso é parte da Task 2/1, não uma tarefa extra de produto.

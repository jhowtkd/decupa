# Blindagem GLM — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blindar o Decupa para o cenário em que GLM 5.3 Flash via Z.ai é o único provedor de triagem: retira o caminho Gemini, cura os modos de falha documentados no próprio `zai.ts`, e fecha as brechas de parse e contrato que a revisão ICE de 2026-09-09 apontou.

**Architecture:** Oito tarefas independentes, cada uma com seu ciclo de teste e seu commit. Nenhuma muda o comportamento editorial do corte — o keep-list produzido antes e depois é o mesmo (congelado por `mechanical.gold.test.ts`). O que muda é o que acontece quando o thinking estoura o orçamento, quando o JSON do sidecar vem torto, quando alguém roda `decupa triage` com o vídeo original, e quando a página errada faz POST no marcador.

**Tech Stack:** TypeScript ESM rodado com `node --experimental-strip-types`, vitest 4, pnpm workspaces, Python 3.11/3.12 nos sidecars via `uv`, GitHub Actions.

**Spec:** Levantamento ICE de 2026-09-09 (revisão GLM-only) sobre o repositório inteiro. Tarefas 1 e 8 fecham lacunas que os designs de 2026-09-04 registraram; as demais curam evidência citada por arquivo abaixo.

## Global Constraints

- **Node >= 22** (`package.json:engines`). O CLI roda com `--experimental-strip-types`, que é *strip-only*: nada de `enum`, `namespace`, decorator ou parameter property (`constructor(private x: T)`). A guarda é [apps/cli/src/strip-types.test.ts](../../../apps/cli/src/strip-types.test.ts) e ela **tem** que continuar passando.
- **pnpm 10.32.1** (`packageManager`). Nada de `npm install`.
- **Comentários, mensagens de erro e texto de tela em português**, como o resto do repo. Comentário explica *por quê*, não *o quê*.
- **Testes ao lado do fonte** como `<módulo>.test.ts`, rodados com `pnpm test`. Arquivo único: `pnpm vitest run <caminho>`.
- **Nenhuma etapa falha em silêncio devolvendo resultado vazio.** NaN atravessado e stdout não-JSON parseado como `{}` são exatamente este modo de falha.
- **O modelo nunca emite tempo.** Nada neste plano toca nessa fronteira.
- **Não mexer no comportamento do corte.** Se `pnpm test` acusar diferença em `packages/triage/src/mechanical.gold.test.ts`, a mudança está errada.
- **Z.ai é o único provedor.** `ZAI_API_KEY` é a única chave de triagem que o repo reconhece a partir da Tarefa 2.
- **Um commit por tarefa**, mensagem em conventional commits com escopo (`fix(mark-web):`, `refactor(triage):`, `perf(triage):`). Commit feito por agente leva o trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Rodar `pnpm test` e `pnpm typecheck` antes de cada commit.** Linha de base: suíte verde e typecheck limpo antes de começar.

## Origem

Levantamento ICE de 2026-09-09, cenário GLM-only. Cada linha é evidência verificada no código:

| # | Problema | Evidência |
|---|----------|-----------|
| 1 | mark-web aceita `POST /truth` de qualquer página aberta no navegador | `mark-web/server.ts:88` sem checagem de `Origin`; o app `limpar` já valida via `http/origin.ts` (commit `4a248d9`) |
| 2 | O caminho Gemini tem fetch sem teto e `JSON.parse` sem guarda — e saiu de produção | `gemini.ts:119-136`; a decisão é GLM-only, então o certo é retirar, não consertar |
| 3 | O erro "Suba max_tokens" manda fazer o que nenhuma flag permite | `zai.ts` `readChoice` (`finish_reason === "length"`) + `ZaiTriageModel` só construível via `opts.maxTokens`, que nenhum comando expõe |
| 4 | Consumo da API invisível — Coding Plan tem cota e `readChoice` descarta `usage` | `zai.ts` `once()` lê o corpo inteiro e devolve só o content |
| 5 | `index.units.find()` linear dentro de loops | `claims.ts:101,141`, `density.ts` no map de candidatos, `apps/cli/src/triage.ts:191`, `speech-index.ts` `topicSpan` |
| 6 | `parseSpeechIndex` aceita NaN e `transcribe` parseia stdout sem guarda | `speech-index.ts:57-70` (`Number()` cru), `transcribe.ts:48` (`JSON.parse(stdout)`) |
| 7 | `decupa triage` standalone envia o vídeo original inteiro em base64 | só o app gera `triage-proxy.mp4` (`pipeline.ts:274-295`); acima de ~5 MB a Z.ai devolve "1234 internal network failure" genérico (medido, comentário em `zai.ts:203`) |
| 8 | A triagem roda como subprocesso `pnpm decupa triage` com parse de stdout por regex | `pipeline.ts:297-317` — contrato frágil entre dois pedaços do mesmo código |

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `apps/cli/src/mark-web/server.ts` | Sobe o marcador; ganha checagem de origem no POST. | 1 |
| `packages/triage/src/provider.ts` | Provedor único: só `zai`. | 2 |
| `packages/triage/src/zai.ts` | Auto-escalonamento de `max_tokens` e medidor de uso. | 3, 4 |
| `packages/triage/src/speech-index.ts` | `unitsById` (Map) e guarda `num()` contra NaN. | 5, 6 |
| `packages/transcript/src/transcribe.ts` | `parseSidecarOutput` com guarda de JSON e forma. | 6 |
| `apps/cli/src/triage.ts` | `ensureLightVideo` (proxy standalone) e resolução de provider interna. | 7, 8 |
| `apps/cli/src/app/pipeline.ts` | `runTriage` chama a biblioteca, não o subprocesso. | 8 |

Deletados na Tarefa 2: `packages/triage/src/gemini.ts`, `packages/triage/src/gemini.test.ts`.

---

### Task 1: Checagem de Origin no POST do mark-web

O app `limpar` recusa POST de origem estranha (commit `4a248d9`); o marcador não. Qualquer página aberta na mesma máquina pode fazer POST em `http://127.0.0.1:7777/truth` e sobrescrever o truth-file.

**Files:**
- Modify: `apps/cli/src/mark-web/server.ts:62-133`
- Test: `apps/cli/src/mark.test.ts` (adicionar describe)

**Interfaces:**
- Consumes: `originAllowed(origin: string | undefined, port: number): boolean` de `apps/cli/src/http/origin.ts` (existe, testado).
- Produces: nada novo — comportamento de rota.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao final de `apps/cli/src/mark.test.ts` (o arquivo já importa `runMarkWeb` ou seus vizinhos — siga o padrão de imports dele):

```ts
describe("runMarkWeb: origem do POST /truth", () => {
  it("recusa POST de outra origem com 403", async () => {
    // Mesma garantia do app limpar: bind em 127.0.0.1 protege da rede, não
    // do navegador. A diferença é que aqui o POST sobrescreve o truth-file
    // da medição — dado de bancada, não só estado de tela.
    const acme = await runMarkWeb({
      input: fixtureWav, // o mesmo caminho de fixture que os testes vizinhos usam
      outPath: join(tmp, "truth.json"),
      port: 0,
    });
    const res = await fetch(`http://127.0.0.1:${acme.port}/truth`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ boundariesMs: [100] }),
    });
    expect(res.status).toBe(403);
    await acme.close();
  });
});
```

Nota: se `runMarkWeb` não resolver com `close()` no shape atual, o teste mata o servidor via `POST /truth` legítimo (o servidor fecha sozinho após salvar) — nesse caso asserted 403 antes, e um segundo POST com origem certa encerra a sessão. Adapte ao helper que o arquivo já tiver.

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/mark.test.ts`
Expected: FAIL — o POST retorna 200 hoje.

- [ ] **Step 3: Implementar**

Em `apps/cli/src/mark-web/server.ts`, adicionar o import:

```ts
import { originAllowed } from "../http/origin.ts";
```

Dentro de `runMarkWeb`, antes do `return new Promise` (linha ~62), capturar a porta de escuta — o valor é determinístico porque o listen usa `opts.port ?? 7777` e falha se estiver ocupada:

```ts
  const port = opts.port ?? 7777;
```

E no topo do handler assíncrono `handle`, antes da primeira rota (linha ~67), o mesmo portão que o app usa:

```ts
      if (req.method !== "GET" && !originAllowed(req.headers.origin, port)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `pnpm vitest run apps/cli/src/mark.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/mark-web/server.ts apps/cli/src/mark.test.ts
git commit -m "fix(mark-web): recusa POST de outra origem no /truth

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Retirar o caminho Gemini

Com GLM-only, `gemini.ts` é um fetch sem teto e um `JSON.parse` sem guarda atrás de `--provider gemini` — código que ninguém exercita e cujos bugs acumulam em silêncio. `stampModelClaims` só é usado dentro do próprio arquivo (verificado por grep). Retirar é mais barato e mais honesto do que consertar.

**Files:**
- Delete: `packages/triage/src/gemini.ts`
- Delete: `packages/triage/src/gemini.test.ts`
- Modify: `packages/triage/src/provider.ts`
- Modify: `packages/triage/src/index.ts:16`
- Modify: `apps/cli/src/triage.ts:6-34,148-152`
- Modify: `apps/cli/src/index.ts` (texto de uso dos comandos `triage` e `limpar`)
- Test: `packages/triage/src/provider.test.ts` (reescrever)

**Interfaces:**
- Consumes: nada.
- Produces: `Provider = "zai"` (tipo); `resolveProvider(explicit, env)` devolve `"zai"` ou throwa — a assinatura externa não muda.

- [ ] **Step 1: Reescrever o teste de provider para o mundo de um só provedor**

Substituir o conteúdo de `packages/triage/src/provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("aceita a escolha explícita", () => {
    expect(resolveProvider("zai", {})).toBe("zai");
  });

  it("recusa gemini nomeando o que aconteceu", () => {
    // Quem voltar de um shell antigo com --provider gemini merece um erro
    // que explica a decisão, não "valor inválido".
    expect(() => resolveProvider("gemini", { ZAI_API_KEY: "z" })).toThrow(/Gemini foi retirado/);
  });

  it("sem flag, a chave presente decide", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" })).toBe("zai");
  });

  it("sem chave nenhuma, nomeia a variável e o caminho manual", () => {
    expect(() => resolveProvider(undefined, {})).toThrow(/ZAI_API_KEY/);
    expect(() => resolveProvider(undefined, {})).toThrow(/na mão/);
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run packages/triage/src/provider.test.ts`
Expected: FAIL — `resolveProvider("gemini", ...)` ainda devolve `"gemini"`.

- [ ] **Step 3: Reescrever provider.ts**

```ts
export type Provider = "zai";

/**
 * O decupa usa um provedor só: Z.ai (GLM 5.3 Flash). Esta função existe para
 * dar a mesma mensagem de erro boa nos dois pontos de entrada (CLI e app) —
 * chave ausente e flag inválida estouram dizendo o que fazer, não
 * "cannot read properties of undefined".
 */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Provider {
  if (explicit !== undefined) {
    if (explicit === "zai") return "zai";
    throw new Error(
      `--provider aceita "zai", não "${explicit}" — o caminho Gemini foi ` +
      "retirado; a triagem do decupa é Z.ai (GLM).",
    );
  }
  if (env.ZAI_API_KEY) return "zai";
  throw new Error(
    "ZAI_API_KEY não está setada no ambiente. Sem chave a triagem não roda — " +
    "monte o keep-list na mão e passe direto pro `condense.py plan`, que é o " +
    "caminho que o SKILL documenta.",
  );
}
```

- [ ] **Step 4: Deletar o caminho Gemini e limpar as referências**

```bash
git rm packages/triage/src/gemini.ts packages/triage/src/gemini.test.ts
```

Em `packages/triage/src/index.ts`, remover a linha:

```ts
export { DEFAULT_MODEL, GeminiTriageModel, stampModelClaims } from "./gemini.ts";
```

Em `apps/cli/src/triage.ts`: remover `DEFAULT_MODEL` e `GeminiTriageModel` do import de `@decupa/triage` (linhas 12 e 14), importar `resolveProvider`, e substituir as linhas 148-152:

```ts
  const provider = resolveProvider(opts.provider);
  const modelName = opts.modelName ?? ZAI_DEFAULT_MODEL;
  const model = opts.model ?? new ZaiTriageModel({ model: modelName });
```

No `TriageOptions` (linha ~45), o comentário `/** Qual motor responde. Default: gemini. */` e o tipo `provider?: "gemini" | "zai"` viram:

```ts
  /** Qual motor responde. Resolvido pela chave quando ausente. */
  provider?: string;
```

Em `apps/cli/src/index.ts`, atualizar o texto de uso: `[--provider gemini|zai]` → `[--provider zai]` nos comandos `triage` e `limpar`.

- [ ] **Step 5: Suíte e typecheck inteiros**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — `triage.test.ts` não referencia Gemini (verificado por grep); `apps/cli/src/triage.test.ts` injeta modelo fake e não toca no provedor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(triage): retira o caminho Gemini, Z.ai fica a única via

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Auto-escalonar max_tokens quando o thinking estoura

O `thinking` do GLM não desliga (medido: 3000 chars de raciocínio para 19 de resposta). Quando `finish_reason === "length"`, o `readChoice` estoura mandando "Suba max_tokens" — mas `maxTokens` só é injetável por código; nenhuma flag o expõe. O remédio citado não existe para quem usa a CLI.

**Files:**
- Modify: `packages/triage/src/zai.ts` (`send`, `isBudgetExhausted`, teto)
- Modify: `apps/cli/src/index.ts` (comando `triage`: flag `--max-tokens`)
- Modify: `apps/cli/src/triage.ts` (`TriageOptions.maxTokens`)
- Test: `packages/triage/src/zai.test.ts`

**Interfaces:**
- Consumes: `readChoice` (Task anterior não mudou sua assinatura).
- Produces: `isBudgetExhausted(error: Error): boolean` exportado; `TriageOptions.maxTokens?: number`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `packages/triage/src/zai.test.ts` (o arquivo já importa `mkdtemp`/`writeFile`/`tmpdir`/`join` e `ZaiTriageModel`):

```ts
describe("auto-escalonar max_tokens", () => {
  it("dobra o orçamento e repete quando o thinking comeu tudo", async () => {
    // A resposta de verdade do modo de falha: HTTP 200, content vazio,
    // finish_reason "length". A segunda chamada tem de sair com max_tokens
    // dobrado e content de verdade.
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      bodies.push(sent);
      if (bodies.length === 1) {
        return new Response(JSON.stringify(body({ content: "", reasoning_content: "x".repeat(3000) }, "length")));
      }
      return new Response(JSON.stringify(body({ content: '{"claims":[]}' })));
    }) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    const claims = await model.structure({ unitsBlock: "u001 texto", videoPath: video });

    expect(claims).toEqual([]);
    expect(bodies[1]!.max_tokens).toBe(32_000);
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run packages/triage/src/zai.test.ts`
Expected: FAIL — a primeira resposta estoura e ninguém repete.

- [ ] **Step 3: Implementar**

Em `packages/triage/src/zai.ts`, ao lado de `isRetryable`:

```ts
/** O thinking comeu o orçamento e não sobrou resposta. */
export function isBudgetExhausted(error: Error): boolean {
  return /gastou o orçamento inteiro|Suba max_tokens/.test(error.message);
}
```

Teto do escalonamento, ao lado de `DEFAULT_MAX_TOKENS`:

```ts
/** Teto do auto-escalonamento. Dobrar além disto não compra nada: o corpo
 *  inteiro (vídeo em base64 + prompt) já é o gargalo real da chamada. */
const MAX_TOKENS_CEILING = 64_000;
```

No construtor, `private readonly maxTokens` vira `private maxTokens` (mutável — é isso que o escalonamento precisa). E `send` vira:

```ts
  private async send(content: unknown[]): Promise<string> {
    let retriesLeft = this.retries;
    for (;;) {
      try {
        return await this.once(content);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Orçamento estourado não é azar de rede, é remédio conhecido:
        // dobra e tenta de novo na hora, sem gastar o retry.
        if (isBudgetExhausted(error) && this.maxTokens < MAX_TOKENS_CEILING) {
          this.maxTokens = Math.min(this.maxTokens * 2, MAX_TOKENS_CEILING);
          continue;
        }
        if (!isRetryable(error) || retriesLeft <= 0) throw error;
        retriesLeft -= 1;
      }
    }
  }
```

Em `apps/cli/src/triage.ts`, adicionar a `TriageOptions`:

```ts
  /** Teto de tokens por chamada; default 16000. O thinking do GLM consome
   *  antes da resposta — chamadas com unitsBlock grande podem precisar de mais. */
  maxTokens?: number;
```

E a linha de construção do modelo (da Tarefa 2) passa a repassar:

```ts
  const model = opts.model ?? new ZaiTriageModel({ model: modelName, maxTokens: opts.maxTokens });
```

Em `apps/cli/src/index.ts`, comando `triage`: adicionar `maxTokens: { type: "string" }` às options e ao passo dos valores:

```ts
      maxTokens: values.maxTokens ? Number(values.maxTokens) : undefined,
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `pnpm vitest run packages/triage/src/zai.test.ts apps/cli/src/triage.test.ts`
Expected: PASS — inclusive os testes antigos de retry (429/5xx continuam pelo caminho `isRetryable`).

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/zai.ts packages/triage/src/zai.test.ts apps/cli/src/triage.ts apps/cli/src/index.ts
git commit -m "feat(triage): auto-escalonar max_tokens quando o thinking estoura

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Medidor de uso da Z.ai no relatório

Coding Plan é assinatura com cota, e o `once()` lê o corpo inteiro — incluindo `usage` — e joga fora. Sem os números, "a cota acabou no meio do lote" é mistério.

**Files:**
- Modify: `packages/triage/src/zai.ts` (`ZaiUsage`, acumulador em `once`)
- Modify: `packages/triage/src/report.ts` (`ReportInput.usage`, seção)
- Modify: `apps/cli/src/triage.ts` (coleta e propaga)
- Test: `packages/triage/src/zai.test.ts`, `packages/triage/src/report.test.ts`

**Interfaces:**
- Consumes: nada novo.
- Produces: `ZaiUsage { calls, promptTokens, completionTokens, reasoningChars }`; `ZaiTriageModel.usage(): ZaiUsage`; `ReportInput.usage?: ZaiUsage`; `TriageJson.usage?: ZaiUsage`.

- [ ] **Step 1: Escrever os testes que falham**

Em `packages/triage/src/zai.test.ts`:

```ts
describe("medidor de uso", () => {
  it("acumula usage e raciocínio entre chamadas", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      ...body({ content: '{"claims":[]}', reasoning_content: "think" }),
      usage: { prompt_tokens: 1000, completion_tokens: 40 },
    }))) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    await model.structure({ unitsBlock: "u001 texto", videoPath: video });
    await model.density({ unitsBlock: "u001 texto", videoPath: video, budgetSeconds: 10 });

    expect(model.usage()).toEqual({
      calls: 2, promptTokens: 2000, completionTokens: 80, reasoningChars: 10,
    });
  });
});
```

Em `packages/triage/src/report.test.ts`, adicionar (seguindo o padrão de montagem de `ReportInput` que o arquivo já usa):

```ts
it("traz o consumo da API no cabeçalho quando os números existem", () => {
  const md = renderReport({
    keepList: "u001-u002",
    model: "glm-5.3-flash",
    verdicts: [],
    density: null,
    usage: { calls: 3, promptTokens: 9000, completionTokens: 220, reasoningChars: 4200 },
  });
  expect(md).toContain("uso da API: 3 chamadas");
  expect(md).toContain("9000 tokens de prompt");
});
```

- [ ] **Step 2: Rodar e verificar que falham**

Run: `pnpm vitest run packages/triage/src/zai.test.ts packages/triage/src/report.test.ts`
Expected: FAIL — `model.usage` não existe; `ReportInput` não aceita `usage`.

- [ ] **Step 3: Implementar o acumulador em zai.ts**

Tipos e campo (a classe usa campos explícitos, não parameter properties — restrição strip-types):

```ts
/** Consumo acumulado desta instância entre os passes. */
export interface ZaiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Caracteres de raciocínio — o thinking não desliga e é consumido antes da resposta. */
  reasoningChars: number;
}
```

Na classe, campo privado `private readonly usageTotals: ZaiUsage = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningChars: 0 };` e método público:

```ts
  /** Cópia dos totais até agora — para o relatório e o triage.json. */
  usage(): ZaiUsage {
    return { ...this.usageTotals };
  }
```

No fim de `once`, antes de `return readChoice(parsed)` — contabiliza o que a chamada custou, sem mudar o que devolve:

```ts
    const usage = (parsed as Record<string, any>)?.usage;
    if (usage && Number.isFinite(usage.prompt_tokens)) {
      this.usageTotals.calls += 1;
      this.usageTotals.promptTokens += Number(usage.prompt_tokens);
      this.usageTotals.completionTokens += Number(usage.completion_tokens ?? 0);
    }
    const reasoning = (parsed as Record<string, any>)?.choices?.[0]?.message?.reasoning_content;
    this.usageTotals.reasoningChars += String(reasoning ?? "").length;
    return readChoice(parsed);
```

- [ ] **Step 4: Propagar até o relatório**

Em `packages/triage/src/report.ts`: `ReportInput` ganha

```ts
  usage?: { calls: number; promptTokens: number; completionTokens: number; reasoningChars: number };
```

E em `renderReport`, logo depois da linha `- keep-list:` :

```ts
  if (input.usage) {
    lines.push(
      `- uso da API: ${input.usage.calls} chamadas · ${input.usage.promptTokens} tokens de prompt · ` +
      `${input.usage.completionTokens} de resposta · ${input.usage.reasoningChars} chars de raciocínio`,
    );
  }
```

Em `apps/cli/src/triage.ts`: importar `ZaiTriageModel` (já importado) e, no fim de `runTriage` (antes de escrever `triage.json`), coletar:

```ts
  const usage = model instanceof ZaiTriageModel ? model.usage() : undefined;
```

`TriageJson` ganha `usage?: ZaiUsage` (importar o tipo), o `writeFile` do `triage.json` passa `payload` com `usage`, e o `renderReport` recebe `usage` no objeto de input.

- [ ] **Step 5: Rodar e verificar que passa**

Run: `pnpm vitest run packages/triage/src/zai.test.ts packages/triage/src/report.test.ts apps/cli/src/triage.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/triage/src/zai.ts packages/triage/src/report.ts apps/cli/src/triage.ts packages/triage/src/zai.test.ts packages/triage/src/report.test.ts
git commit -m "feat(triage): uso da API por pass no relatório e no triage.json

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Map por id nas buscas em loop

`index.units.find(...)` dentro de loop é O(n²) sobre o índice. Indiferente nas 42 unidades do material do ritmo; uma aula de 2h chega a centenas e cada passe varre tudo repetidamente.

**Files:**
- Modify: `packages/triage/src/speech-index.ts` (`unitsById`, `topicSpan`)
- Modify: `packages/triage/src/claims.ts` (`Context.byId`, `checkClaim`)
- Modify: `packages/triage/src/density.ts` (`applyDensityBudget`)
- Modify: `apps/cli/src/triage.ts` (loop de inspect)
- Test: `packages/triage/src/speech-index.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `unitsById(index: SpeechIndex): Map<string, IndexUnit>` exportado (também de `index.ts` do package).

- [ ] **Step 1: Escrever o teste que falha**

Em `packages/triage/src/speech-index.test.ts`:

```ts
it("unitsById devolve todas as unidades keyed por id", () => {
  const index = parseSpeechIndex(validIndex); // o fixture que o arquivo já usa
  const byId = unitsById(index);
  expect(byId.size).toBe(index.units.length);
  expect(byId.get("u001")).toBe(index.units[0]);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run packages/triage/src/speech-index.test.ts`
Expected: FAIL — `unitsById` não existe.

- [ ] **Step 3: Implementar**

Em `speech-index.ts`:

```ts
/** Busca por id dentro de loop é O(n²) no índice inteiro — o passe mecânico
 *  varre alegações × unidades. Um Map pago uma vez se liquida no primeiro loop. */
export function unitsById(index: SpeechIndex): Map<string, IndexUnit> {
  return new Map(index.units.map((u) => [u.id, u] as const));
}
```

`topicSpan` troca o find interno por `const byId = unitsById(index);` e `byId.get(id)`.

Exportar em `packages/triage/src/index.ts`: acrescentar `unitsById` à linha que já exporta de `./speech-index.ts`.

Em `claims.ts`: a interface `Context` ganha `byId: Map<string, IndexUnit>;`; onde `verifyClaims` constrói o objeto de contexto, acrescentar `byId: unitsById(index),` (import de `./speech-index.ts`); em `checkClaim`, as duas buscas viram:

```ts
    const unit = ctx.byId.get(id);
    if (!unit) return `unidade ${id} não existe no índice`;
```

```ts
      const target = ctx.byId.get(claim.restated_by);
      if (!target) return `unidade ${claim.restated_by} não existe no índice`;
```

Em `density.ts`, no topo de `applyDensityBudget`:

```ts
  const byId = unitsById(index);
```

e o map de candidatos usa `byId.get(id)` no lugar de `index.units.find((u) => u.id === id)`.

Em `apps/cli/src/triage.ts`, logo depois de `parseSpeechIndex` (linha ~153):

```ts
  const byId = unitsById(index);
```

e, no loop de inspect (linha ~191), `const unit = index.units.find((x) => x.id === u.id);` vira `const unit = byId.get(u.id);`.

- [ ] **Step 4: Suíte inteira — é ela que prova que nada mudou**

Run: `pnpm test`
Expected: PASS — `mechanical.gold.test.ts` verde é a prova de que o keep-list não mudou.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/speech-index.ts packages/triage/src/claims.ts packages/triage/src/density.ts packages/triage/src/index.ts apps/cli/src/triage.ts packages/triage/src/speech-index.test.ts
git commit -m "perf(triage): mapa por id nas buscas em loop

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Guardas de parse — NaN no índice e stdout do sidecar

`parseSpeechIndex` faz `Number(u.start)` cru: string torta vira `NaN`, `NaN` atravessa índice, verificação e vira tempo de corte — não erro. `transcribe.ts` faz `JSON.parse(stdout)` sem guarda: um log do Python que vaze para o stdout vira `SyntaxError` sem contexto.

**Files:**
- Modify: `packages/triage/src/speech-index.ts` (helper `num`)
- Modify: `packages/transcript/src/transcribe.ts` (`parseSidecarOutput` extraída)
- Test: `packages/triage/src/speech-index.test.ts`, `packages/transcript/src/transcribe.test.ts` (novo)

**Interfaces:**
- Consumes: nada.
- Produces: `parseSidecarOutput(stdout: string): SidecarOutput` exportado (privado ao package — não precisa ir ao index).

- [ ] **Step 1: Escrever os testes que falham**

Em `packages/transcript/src/transcribe.test.ts` (novo arquivo):

```ts
import { describe, expect, it } from "vitest";
import { parseSidecarOutput } from "./transcribe.ts";

describe("parseSidecarOutput", () => {
  it("lê language e words", () => {
    const out = parseSidecarOutput(
      JSON.stringify({ language: "pt", words: [{ text: "oi", startMs: 0, endMs: 100 }] }),
    );
    expect(out.language).toBe("pt");
    expect(out.words).toHaveLength(1);
  });

  it("aceita transcrição de áudio mudo: words vazio é válido", () => {
    expect(parseSidecarOutput(JSON.stringify({ language: "pt", words: [] })).words).toEqual([]);
  });

  it("stdout não-JSON estoura com o começo da saída, não com SyntaxError cru", () => {
    expect(() => parseSidecarOutput("Downloading model...\n")).toThrow(/não é JSON.*Downloading/);
  });

  it("saída sem a forma prometida nomeia o sidecar", () => {
    expect(() => parseSidecarOutput(JSON.stringify({ ok: true }))).toThrow(/transcribe\.py/);
  });
});
```

Em `packages/triage/src/speech-index.test.ts`:

```ts
it("recusa start que não é número, nomeando o campo", () => {
  const raw = JSON.parse(JSON.stringify(validIndex)); // clone do fixture existente
  raw.units[0].start = "abc";
  expect(() => parseSpeechIndex(raw)).toThrow(/start.*abc/);
});
```

- [ ] **Step 2: Rodar e verificar que falham**

Run: `pnpm vitest run packages/transcript/src/transcribe.test.ts packages/triage/src/speech-index.test.ts`
Expected: FAIL — `parseSidecarOutput` não existe; `parseSpeechIndex` aceita `"abc"`.

- [ ] **Step 3: Implementar**

Em `speech-index.ts`:

```ts
/** `Number()` cru transforma "abc" em NaN, e NaN atravessa índice e
 *  verificação até virar tempo de corte — não erro. Falhar alto é restrição
 *  do repo, não cortesia. */
function num(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`speech_index.json: campo ${field} veio "${String(value)}" e não é número`);
  }
  return n;
}
```

No map de unidades, os campos numéricos passam pelo helper: `index: num(u.index, "index")`, `start: num(u.start, "start")`, `end: num(u.end, "end")`, `duration: num(u.duration, "duration")`, `wordCount: num(u.word_count ?? 0, "word_count")`, `cps: num(u.cps ?? 0, "cps")`, `leadGap: num(u.lead_gap ?? 0, "lead_gap")`. `similarity` mantém o null-check e usa `num(...)` no lugar de `Number(...)`.

Em `transcribe.ts`, extrair e usar:

```ts
/** A ponte com o sidecar é o único ponto onde stdout vira dado. Guardar aqui
 *  é guardar uma vez para todos os chamadores. */
export function parseSidecarOutput(stdout: string): SidecarOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`a saída do sidecar de fala não é JSON: ${stdout.slice(0, 200)}`);
  }
  const out = parsed as Partial<SidecarOutput>;
  if (typeof out.language !== "string" || !Array.isArray(out.words)) {
    throw new Error(
      "a saída do sidecar de fala não tem `language`/`words` — o stdout foi " +
      "poluído ou o services/speech/transcribe.py mudou de contrato",
    );
  }
  return out as SidecarOutput;
}
```

e em `transcribe`, a linha do parse vira:

```ts
    const parsed = parseSidecarOutput(stdout);
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `pnpm vitest run packages/transcript/src/transcribe.test.ts packages/triage/src/speech-index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/speech-index.ts packages/triage/src/speech-index.test.ts packages/transcript/src/transcribe.ts packages/transcript/src/transcribe.test.ts
git commit -m "fix(transcript,triage): guardas de parse para NaN e stdout não-JSON

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Triage standalone nunca envia o vídeo original

O app sempre manda o proxy leve para a triagem; o comando `decupa triage` com o vídeo original manda tudo em base64 — acima de ~5 MB a Z.ai devolve "1234 internal network failure" genérico (medido no repo: 14,9 MB falhou, 2,2 MB passou).

**Files:**
- Modify: `apps/cli/src/triage.ts` (`ensureLightVideo` + uso em `runTriage`)
- Test: `apps/cli/src/triage.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ensureLightVideo(videoPath: string, outDir: string, deps?: { fileSize?, transcode? }): Promise<string>` exportado.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar a `apps/cli/src/triage.test.ts`:

```ts
describe("ensureLightVideo", () => {
  const mk = (mb: number, name = "original.mp4") => {
    const dir = mkdtempSync(join(tmpdir(), "decupa-triage-"));
    const path = join(dir, name);
    writeFileSync(path, Buffer.alloc(Math.round(mb * 1024 * 1024)));
    return path;
  };

  it("devolve o arquivo quando já é leve", async () => {
    const small = mk(2);
    const transcode = vi.fn();
    expect(await ensureLightVideo(small, join(dirname(small), "out"), { transcode })).toBe(small);
    expect(transcode).not.toHaveBeenCalled();
  });

  it("transcodifica o pesado com os parâmetros do proxy do app", async () => {
    const big = mk(20);
    const outDir = join(dirname(big), "out");
    const seen: Array<{ src: string; dst: string }> = [];
    const proxyPath = await ensureLightVideo(big, outDir, {
      transcode: async (src, dst) => { seen.push({ src, dst }); writeFileSync(dst, "x"); },
    });
    expect(proxyPath.endsWith("triage-proxy.mp4")).toBe(true);
    expect(seen[0]!.src).toBe(big);
  });

  it("não regera proxy que já existe no outDir", async () => {
    const big = mk(20);
    const outDir = join(dirname(big), "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "triage-proxy.mp4"), "x");
    const transcode = vi.fn();
    expect(await ensureLightVideo(big, outDir, { transcode })).toContain("triage-proxy.mp4");
    expect(transcode).not.toHaveBeenCalled();
  });

  it("proxy do app passa direto, mesmo pesado", async () => {
    const proxy = mk(20, "triage-proxy.mp4");
    const transcode = vi.fn();
    expect(await ensureLightVideo(proxy, join(dirname(proxy), "out"), { transcode })).toBe(proxy);
    expect(transcode).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/triage.test.ts`
Expected: FAIL — `ensureLightVideo` não existe.

- [ ] **Step 3: Implementar**

Em `apps/cli/src/triage.ts`, imports novos: `stat` em `node:fs/promises`, `basename` em `node:path`. Função:

```ts
/** Base64 acima disso já devolveu erro genérico na Z.ai (medido: 14,9 MB
 *  falhou com "1234 internal network failure", 2,2 MB passou). O app sempre
 *  manda o proxy leve; o perigo é o `decupa triage` standalone com o
 *  vídeo original. */
const MAX_DIRECT_VIDEO_MB = 8;

export async function ensureLightVideo(
  videoPath: string,
  outDir: string,
  deps: {
    fileSize?: (p: string) => Promise<number>;
    transcode?: (src: string, dst: string) => Promise<void>;
  } = {},
): Promise<string> {
  // O app entrega o proxy com este nome exato; re-transcodificar o proxy
  // seria gastar minuto para piorar o arquivo.
  if (basename(videoPath) === "triage-proxy.mp4") return videoPath;

  const fileSize = deps.fileSize ?? (async (p: string) => (await stat(p)).size);
  if ((await fileSize(videoPath)) / 1024 / 1024 <= MAX_DIRECT_VIDEO_MB) return videoPath;

  const proxy = join(outDir, "triage-proxy.mp4");
  const exists = await access(proxy).then(() => true, () => false);
  if (!exists) {
    const transcode = deps.transcode ?? defaultTranscode;
    await mkdir(outDir, { recursive: true });
    await transcode(videoPath, proxy);
  }
  return proxy;
}

async function defaultTranscode(src: string, dst: string): Promise<void> {
  // Os mesmos parâmetros de pipeline.makeTriageProxy: o vídeo entra pro
  // modelo dar contexto visual, não detalhe.
  const code = await new Promise<number>((resolve) => {
    const child = spawn("ffmpeg", [
      "-i", src,
      "-vf", "fps=1,scale=270:480",
      "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "24k", "-ac", "1",
      "-y", dst,
    ]);
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) throw new Error(`não consegui gerar o proxy leve em ${dst} (ffmpeg código ${code})`);
}
```

Em `runTriage`, a primeira linha depois da resolução de provider/model:

```ts
  const videoPath = await ensureLightVideo(opts.videoPath, opts.outDir);
```

e todas as referências seguintes a `opts.videoPath` dentro de `runTriage` (structure, density, `shas.videoSha`) passam a usar `videoPath`.

- [ ] **Step 4: Rodar e verificar que passa**

Run: `pnpm vitest run apps/cli/src/triage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/triage.ts apps/cli/src/triage.test.ts
git commit -m "feat(cli): triage standalone nunca envia o vídeo original

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Triagem como biblioteca, sem subprocesso nem regex

`pipeline.runTriage` invoca `pnpm decupa triage` e extrai o keep-list por regex do stdout (`pipeline.ts:314`) — contrato frágil entre dois pedaços do mesmo código que podem se importar diretamente. Bônus: mata o boot de node+pnpm a cada triagem.

**Files:**
- Modify: `apps/cli/src/app/pipeline.ts:297-317` (`runTriage`)
- Test: `apps/cli/src/app/pipeline.test.ts` (substituir os dois testes do describe `runTriage`)

**Interfaces:**
- Consumes: `runTriage` de `apps/cli/src/triage.ts` (assinatura existente: `TriageOptions` → `TriageResult`, que tem `keepList: string`).
- Produces: `pipeline.runTriage(job, exec, provider?, triageFn?)` — `triageFn` injetável, default é a chamada de biblioteca.

- [ ] **Step 1: Substituir os testes**

No describe `runTriage` de `apps/cli/src/app/pipeline.test.ts`, trocar os dois testes de subprocesso por:

```ts
  it("chama a biblioteca com o proxy leve e devolve o keep-list tipado", async () => {
    const seen: unknown[] = [];
    const keep = await runTriage(job, new FakeExecutor(), undefined, async (opts) => {
      seen.push(opts);
      return { keepList: "u001-u003" };
    });
    expect(keep).toBe("u001-u003");
    expect(seen[0]).toMatchObject({
      videoPath: join(job.workDir, "triage-proxy.mp4"),
      outDir: join(job.workDir, "out"),
    });
    expect(seen[0]).not.toHaveProperty("provider");
  });

  it("passa o provider escolhido para a biblioteca", async () => {
    const seen: unknown[] = [];
    await runTriage(job, new FakeExecutor(), "zai", async (opts) => {
      seen.push(opts);
      return { keepList: "u001" };
    });
    expect(seen[0]).toMatchObject({ provider: "zai" });
  });
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/app/pipeline.test.ts`
Expected: FAIL — `runTriage` hoje ignora o quarto argumento e faz subprocesso; o keep-list do FakeExecutor (`stdout: "keep-list: ..."`) não existe no teste novo.

- [ ] **Step 3: Implementar**

Em `apps/cli/src/app/pipeline.ts`, import no topo:

```ts
import { runTriage as runTriageLibrary } from "../triage.ts";
```

E a função inteira (linhas 297-317) vira:

```ts
export async function runTriage(
  job: PipelineJob,
  exec: Executor,
  provider?: string,
  triageFn: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
  }) => Promise<{ keepList: string }> = runTriageLibrary,
): Promise<string> {
  // O proxy continua sendo do pipeline: é Executor (testável) e o trabalho
  // de gerar não pode ficar escondido dentro da biblioteca que o teste
  // injeta. A biblioteca decide o resto — inclusive se o vídeo precisa de
  // proxy próprio (ensureLightVideo, que passa o nosso direto).
  const proxy = await makeTriageProxy(job, exec);
  const result = await triageFn({
    indexPath: indexPath(job),
    videoPath: proxy,
    outDir: join(job.workDir, "out"),
    // Sem escolha explícita, quem resolve é a biblioteca, pela chave.
    ...(provider ? { provider } : {}),
  });
  return result.keepList;
}
```

`apps/cli/src/triage.ts` já resolve `resolveProvider(opts.provider)` desde a Tarefa 2 — provider ausente com `ZAI_API_KEY` no ambiente funciona; sem chave nenhuma, o erro claro sobe pelo mesmo caminho do POST `/jobs/:id/triage` (500 com a mensagem, como hoje).

- [ ] **Step 4: Suíte inteira**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — `server.test.ts` não testa o POST de triagem com subprocesso real (verificado por grep: nenhum teste de server invoca `pnpm decupa triage`).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "refactor(app): triagem por biblioteca, sem subprocesso nem regex

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Fora de escopo (registrado, não esquecido)

Da mesma revisão ICE e não neste plano: cache de transcrição por hash de mídia (ICE 24 — precisa decisão de onde mora o cache global e política de eviction), deduplicação de `pairMotor` ×3 / `tokenize` ×2 (ICE 18 — refatoração mecânica, sem risco, encaixa em qualquer sprint morto), CI em Linux + testes dos sidecars Python (ICE 16 — esbarra no fixture `say`), e o CI instalando o motor para o `engine-gold.test.ts` deixar de se auto-pular.

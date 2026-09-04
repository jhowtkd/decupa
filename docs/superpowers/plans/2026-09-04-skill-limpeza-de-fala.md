# Skill de Limpeza de Fala — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empacotar o pipeline de limpeza de fala já provado à mão (WhisperX → `condense_index` → `condense_plan` → `condense_render` → `condense_qc`, com o léxico PT-BR) numa skill do Claude Code que qualquer sessão futura consegue seguir sem o histórico desta conversa — a "Forma A" do roadmap: instalável, sem daemon, sem UI web, o caminho mais curto até algo que o time realmente usa.

**Architecture:** Duas peças novas, uma ponte e um procedimento. `apps/cli` ganha um comando que converte o `Transcript` do Decupa (produzido pelo WhisperX) no formato JSON que o motor de terceiro espera — puro TypeScript, sem tocar Python. Um script Python fino em `scripts/` expõe as quatro funções do motor vendorizado (`condense_index/plan/render/qc`) como subcomandos de CLI, chamando as funções direto (sem transporte MCP, sem exigir `mcp==1.0.0`). Por cima dos dois, um `SKILL.md` documenta o procedimento editorial completo — inclusive a lição aprendida na mão: nunca renderizar sem antes ler `condense_script.md` em prosa contínua.

**Tech Stack:** TypeScript (Node ESM, os pacotes `@decupa/*` já existentes) · Python 3 stdlib + numpy (já usados no motor vendorizado) · o motor vendorizado em `work/video-agent-kit-plugin` (Z.ai, MIT, com o patch de léxico PT-BR já aplicado localmente)

**Spec:**
- Arquitetura do Decupa (rev. 3, conteúdo preservado em memória de projeto — artifact original apagado): separação decupagem/montagem, `EditOp`/`SpeechCut` nunca carrega timestamp vindo do modelo
- Plano de fases do Decupa (conteúdo preservado em memória de projeto — artifact original apagado): Fase 0 (bancada de medição) → Fase 1 (fatia vertical headless) → Fase 2+ (corte invisível, camada visual)
- `docs/superpowers/plans/2026-09-01-decupa-bancada-de-medicao.md`: a bancada de medição (WhisperX, alinhamento, `@decupa/transcript`) que este plano consome
- Achados desta sessão (auditoria de `jhowtkd/video-agent-kit-plugin`, patch de léxico PT-BR em `condense_lang.py`, teste A/B do snap): não há documento formal — os factos relevantes estão repetidos como constraints abaixo, com prova de execução real já feita nesta conversa

## Global Constraints

- **O motor não importa nada de editor.** Nenhum arquivo deste plano importa OpenCut, React, ou qualquer tipo de UI. (Regra R1 da arquitetura original.)
- **Nenhum código aqui chama LLM nenhum.** A decisão editorial (o que é filler, o que fica) é do `SKILL.md` — instruções pra o agente que executa a skill, nunca uma chamada de API embutida no código.
- **O motor vendorizado vive em `work/video-agent-kit-plugin`** (clone de `jhowtkd/video-agent-kit-plugin`, com o patch de `condense_lang.py` já aplicado e verificado nesta sessão — 109 inserções, zero remoção, léxico PT completo nos sete pares hard/soft/connective/anaphora/enum/enum_later/visual_reference). Este plano trata o caminho como fixo via variável de ambiente `VE_PLUGIN_ROOT`; **não** resolve empacotamento/distribuição do motor em si — isso é decisão adiada explicitamente (ver seção final).
- **Nunca renderizar sem ler `condense_script.md` primeiro.** Verificado nesta sessão: a primeira tentativa de corte (dropar uma unidade que lia como filler) foi sinalizada como `mid_thought_out` pelo próprio `condense_plan`; só a leitura da prosa contínua revelou que o corte estava errado. Todo fluxo que este plano descreve tem que forçar essa leitura antes de `condense_render`.
- **Python:** `python3` do sistema basta para este plano — nenhuma das quatro funções do motor (`condense_index/plan/render/qc`, exceto a parte visual de `condense_qc`) precisa de dependência de terceiro; a parte visual precisa de `PIL`/`numpy` (confirmado já instalados nesta máquina; ver Task 2).
- **Node:** `>=22`, ESM, `--experimental-strip-types` (mesmo padrão do resto do repo).
- **Idioma:** prosa e mensagens de commit em português; identificadores e comentários de código em inglês, seguindo o padrão já estabelecido no repo.

## Escopo

**Entra:** conversor `Transcript → transcript.json` (formato do motor), wrapper Python das quatro funções do motor, `SKILL.md` completo, teste de ponta a ponta num vídeo real.

**Fica de fora (decisão adiada, não deste plano):** empacotar o motor vendorizado como plugin instalável separado; decidir se o patch de léxico PT-BR é enviado (`git push`) para o repo do usuário no GitHub; daemon/CLI standalone (Forma B); interface web (Forma C); redesenho de `snapCut` para encaixar em intervalo de silêncio sustentado em vez de frame único (achado registrado, não resolvido); diarização multi-falante.

---

## Estrutura de Arquivos

```
Video editor/
  apps/cli/src/condense/
    prepare.ts              Transcript (nosso) -> JSON do motor (segundos, segments[].words[])
    prepare.test.ts
  apps/cli/src/index.ts     MODIFICAR: novo subcomando `condense-prep`
  scripts/
    condense.py             wrapper fino: index|plan|render|qc como subcomandos de CLI
  docs/skills/limpar-fala/
    SKILL.md                o procedimento completo, autocontido
  work/vak-smoke/           (já existe, gitignorado) — fixture real usada na Task 4
```

Três arquivos, cada um com uma responsabilidade: `prepare.ts` só converte formato (TypeScript, testável com `vitest` como o resto do repo); `condense.py` só chama as quatro funções do motor com argumentos de linha de comando (Python, sem teste unitário formal — verificado por execução real, como o resto do código Python deste projeto); `SKILL.md` só documenta o procedimento — não é código, é a peça que faz a skill funcionar sem o histórico desta conversa.

---

### Task 1: `condense-prep` — Transcript do Decupa para o formato do motor

**Files:**
- Create: `apps/cli/src/condense/prepare.ts`
- Create: `apps/cli/src/condense/prepare.test.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**
- Consumes: `Transcript`, `TranscriptToken` de `@decupa/transcript` (já existe: `{ language: string; tokens: TranscriptToken[] }`, cada token `{ id, text, startMs, endMs, confidence, sentenceIndex }`)
- Produces: `type CondenseSegment = { start: number; end: number; text: string; words: { text: string; start: number; end: number }[] }` e `toCondenseTranscript(transcript: Transcript): { segments: CondenseSegment[] }`. A Task 2 consome o arquivo JSON que isso escreve — mesmo formato verificado manualmente nesta sessão em `work/vak-smoke/adapt_transcript.py`, agora com teste.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/condense/prepare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Transcript } from "@decupa/transcript";
import { toCondenseTranscript } from "./prepare.ts";

const transcript: Transcript = {
  language: "pt",
  tokens: [
    { id: "w_000000", text: "Eu", startMs: 100, endMs: 260, confidence: 0.9, sentenceIndex: 0 },
    { id: "w_000001", text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0 },
    { id: "w_000002", text: "Vamos", startMs: 1200, endMs: 1500, confidence: 0.95, sentenceIndex: 1 },
  ],
};

describe("toCondenseTranscript", () => {
  it("agrupa tokens por sentenceIndex em segmentos", () => {
    const out = toCondenseTranscript(transcript);
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]!.text).toBe("Eu acho");
    expect(out.segments[1]!.text).toBe("Vamos");
  });

  it("converte ms para segundos em start/end do segmento e das palavras", () => {
    const out = toCondenseTranscript(transcript);
    expect(out.segments[0]!.start).toBeCloseTo(0.1, 6);
    expect(out.segments[0]!.end).toBeCloseTo(0.52, 6);
    expect(out.segments[0]!.words[0]).toEqual({ text: "Eu", start: 0.1, end: 0.26 });
  });

  it("preserva a ordem das palavras dentro do segmento mesmo se os tokens vierem fora de ordem", () => {
    const shuffled: Transcript = {
      language: "pt",
      tokens: [transcript.tokens[1]!, transcript.tokens[0]!],
    };
    const out = toCondenseTranscript(shuffled);
    expect(out.segments[0]!.words.map((w) => w.text)).toEqual(["Eu", "acho"]);
  });

  it("devolve segments vazio para transcript sem tokens", () => {
    expect(toCondenseTranscript({ language: "pt", tokens: [] })).toEqual({ segments: [] });
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run apps/cli/src/condense`
Expected: FAIL — `Failed to resolve import "./prepare.ts"`

- [ ] **Step 3: Implementar**

`apps/cli/src/condense/prepare.ts`:

```ts
import { writeFile } from "node:fs/promises";
import type { Transcript, TranscriptToken } from "@decupa/transcript";

export interface CondenseWord {
  text: string;
  start: number;
  end: number;
}

export interface CondenseSegment {
  start: number;
  end: number;
  text: string;
  words: CondenseWord[];
}

export interface CondenseTranscript {
  segments: CondenseSegment[];
}

/**
 * Converte o Transcript do Decupa (ms, tokens palavra-a-palavra) para o
 * formato que `condense_index` espera (segundos, agrupado por segmento).
 *
 * O motor lê qualquer JSON com `segments[].words[].{text,start,end}` — ver
 * `mcp/ve_tools/subtitle.py:load_timed_segments` no motor vendorizado. Não
 * depende da ASR deles (Volcano Engine): o `timing_source` que o motor deriva
 * internamente vira "word_timestamps" sempre que `words` está presente, que é
 * exatamente o que desbloqueia o modo `drop_fillers` com precisão de palavra.
 */
export function toCondenseTranscript(transcript: Transcript): CondenseTranscript {
  const bySentence = new Map<number, TranscriptToken[]>();
  for (const token of transcript.tokens) {
    const group = bySentence.get(token.sentenceIndex);
    if (group) group.push(token);
    else bySentence.set(token.sentenceIndex, [token]);
  }

  const segments: CondenseSegment[] = [...bySentence.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tokens]) => {
      const words: CondenseWord[] = tokens.map((t) => ({
        text: t.text,
        start: t.startMs / 1000,
        end: t.endMs / 1000,
      }));
      return {
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        text: tokens.map((t) => t.text).join(" "),
        words,
      };
    });

  return { segments };
}

export async function writeCondenseTranscript(
  transcript: Transcript,
  outPath: string,
): Promise<CondenseTranscript> {
  const converted = toCondenseTranscript(transcript);
  await writeFile(outPath, `${JSON.stringify(converted, null, 2)}\n`, "utf8");
  return converted;
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run apps/cli/src/condense`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Ligar na CLI**

`apps/cli/src/index.ts` — adicionar o import e o bloco do comando. Primeiro o import, junto aos outros:

```ts
import { transcribe } from "@decupa/transcript";
import { writeCondenseTranscript } from "./condense/prepare.ts";
```

Depois, um novo bloco de comando (inserir antes do `if (command === "report")`, seguindo o padrão dos outros):

```ts
  if (command === "condense-prep") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
      },
    });
    if (!values.input || !values.out) {
      console.error("condense-prep precisa de --input e --out");
      return 1;
    }
    const transcript = await transcribe({ input: values.input, model: values.model });
    const converted = await writeCondenseTranscript(transcript, values.out);
    const words = converted.segments.reduce((n, s) => n + s.words.length, 0);
    console.log(
      `${converted.segments.length} segmentos, ${words} palavras -> ${values.out}`,
    );
    return 0;
  }
```

E no `USAGE`, adicionar a linha de ajuda:

```
  decupa condense-prep --input <video|wav> --out <transcript.json> [--model small]
      Transcreve com o WhisperX do Decupa e grava no formato que o motor de
      condense (video-agent-kit-plugin) espera.
```

- [ ] **Step 6: Verificar de ponta a ponta com o WhisperX real**

```bash
cd "/Users/jhonatan/Repos/Video editor"
pnpm decupa condense-prep \
  --input work/wav/dji-0901.wav \
  --out /tmp/condense-prep-check.json
python3 -c "
import json
d = json.load(open('/tmp/condense-prep-check.json'))
print(len(d['segments']), 'segmentos')
print(d['segments'][0])
"
```

Expected: 15 segmentos (é a contagem por `sentenceIndex` do WhisperX — já observada nesta sessão rodando o precursor deste script, `work/vak-smoke/adapt_transcript.py`; **não confundir com os "22 speech unit(s)" que o `condense_index` relata na Task 2** — aquele número vem da resegmentação interna do motor, por pausa e pontuação, feita depois que este arquivo já existe, não é a mesma contagem), primeiro segmento com `start`/`end` em segundos pequenos (não milissegundos) e uma lista `words` não vazia.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/condense apps/cli/src/index.ts
git commit -m "feat(cli): condense-prep converte Transcript do WhisperX pro formato do motor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `scripts/condense.py` — wrapper de linha de comando das quatro funções do motor

**Files:**
- Create: `scripts/condense.py`

**Interfaces:**
- Consumes: `condense_index`, `condense_plan`, `condense_render`, `condense_qc` de `<VE_PLUGIN_ROOT>/mcp/ve_tools/condense.py`; `RunContext` de `<VE_PLUGIN_ROOT>/mcp/ve_tools/run_context.py` (assinaturas exatas confirmadas por leitura direta do código nesta sessão — ver schemas abaixo)
- Produces: um executável `python3 scripts/condense.py <subcomando> ...` com quatro subcomandos (`index`, `plan`, `render`, `qc`), cada um imprimindo `result.text` e terminando com código 0 em sucesso. A Task 4 usa este script.

Este script não tem teste unitário — é um wrapper fino sobre código de terceiro já extensivamente verificado nesta sessão (rodado de ponta a ponta em vídeo real, com QC PASS confirmado por inspeção visual das imagens de evidência). A verificação é de execução real, Step 4 abaixo, no mesmo padrão usado para o sidecar de fala na Task 10 do plano da bancada.

- [ ] **Step 1: Escrever o script**

`scripts/condense.py`:

```python
#!/usr/bin/env python3
"""Wrapper de CLI para as quatro funções de condense do motor vendorizado
(video-agent-kit-plugin, patch de léxico PT-BR aplicado localmente).

Chama as funções Python direto — sem transporte MCP, sem exigir mcp==1.0.0.
Isso é deliberado: o transporte MCP só importa quando o motor roda como
plugin de verdade dentro do Claude Code; para este script, que já É a camada
que uma sessão do Claude Code invoca via Bash, uma chamada de função direta é
mais simples e não fica presa ao pin de versão.

VE_PLUGIN_ROOT aponta para o clone do motor (default: work/video-agent-kit-plugin,
relativo à raiz deste repo). Mesma variável de ambiente que o motor já usa em
produção — ver .mcp.json no próprio repo do motor.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
sys.path.insert(0, str(PLUGIN_ROOT / "mcp"))

try:
    from ve_tools.condense import condense_index, condense_plan, condense_qc, condense_render
    from ve_tools.run_context import RunContext
except ImportError as exc:
    print(
        f"[ERROR] não achei o motor em {PLUGIN_ROOT} (mcp/ve_tools/condense.py). "
        f"Clone jhowtkd/video-agent-kit-plugin lá, ou aponte VE_PLUGIN_ROOT. ({exc})",
        file=sys.stderr,
    )
    raise SystemExit(1)


def _print_result(result) -> int:
    print(result.text)
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_index({"video_path": args.video, "transcript_path": args.transcript}, ctx)
    return _print_result(result)


def cmd_plan(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    plan_args: dict = {"video_path": args.video, "keep": args.keep}
    if args.drop_fillers:
        plan_args["drop_fillers"] = args.drop_fillers
    result = condense_plan(plan_args, ctx)
    return _print_result(result)


def cmd_render(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_render(
        {"video_path": args.video, "output_path": args.out, "join": args.join}, ctx,
    )
    return _print_result(result)


def cmd_qc(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_qc({"video_path": args.video}, ctx)
    return _print_result(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="mede o vídeo — disfluência, pausas, orçamento de corte")
    p_index.add_argument("video")
    p_index.add_argument("transcript")
    p_index.set_defaults(func=cmd_index)

    p_plan = sub.add_parser("plan", help="transforma keep-list em pontos de corte")
    p_plan.add_argument("video")
    p_plan.add_argument("--keep", nargs="+", required=True, help='ex: u001-u003 u005-u022')
    p_plan.add_argument("--drop-fillers", choices=["hard", "aggressive"], default=None)
    p_plan.set_defaults(func=cmd_plan)

    p_render = sub.add_parser("render", help="corta e renderiza a partir do plano")
    p_render.add_argument("video")
    p_render.add_argument("out")
    p_render.add_argument("--join", choices=["hard", "dissolve"], default="hard")
    p_render.set_defaults(func=cmd_render)

    p_qc = sub.add_parser("qc", help="verifica o arquivo renderizado (áudio + salto visual)")
    p_qc.add_argument("video", help="o ARQUIVO RENDERIZADO, não o original")
    p_qc.set_defaults(func=cmd_qc)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Verificar que acha o motor e recusa educadamente sem ele**

```bash
cd "/Users/jhonatan/Repos/Video editor"
VE_PLUGIN_ROOT=/tmp/nao-existe python3 scripts/condense.py index a.mp4 b.json
echo "código de saída: $?"
```

Expected: mensagem `[ERROR] não achei o motor em /tmp/nao-existe...` em stderr, código de saída 1 — não um traceback do Python.

- [ ] **Step 3: `index` de verdade, no fixture já preparado**

```bash
cd "/Users/jhonatan/Repos/Video editor"
rm -rf work/vak-smoke/out work/vak-smoke/.video_agent
cd work/vak-smoke
export CLAUDE_PROJECT_DIR="$(pwd)"
python3 ../../scripts/condense.py index \
  "$(cd ../.. && pwd)/work/proxy/cf8032b1efa04f5e154facf139e52d56502bcd2173d4398971615414b7c33c65.mp4" \
  "$(pwd)/transcript.json"
```

Expected: mesmo relatório já visto nesta sessão — `Indexed 22 speech unit(s)... language pt`, tabela `u001`–`u022`, `u022` ("Um abraço.") sem a flag `F`.

- [ ] **Step 4: `plan` → `render` → `qc`, a cadeia completa**

```bash
cd "/Users/jhonatan/Repos/Video editor/work/vak-smoke"
export CLAUDE_PROJECT_DIR="$(pwd)"
VIDEO="$(cd ../.. && pwd)/work/proxy/cf8032b1efa04f5e154facf139e52d56502bcd2173d4398971615414b7c33c65.mp4"

python3 ../../scripts/condense.py plan "$VIDEO" --keep u001-u022 --drop-fillers hard
python3 ../../scripts/condense.py render "$VIDEO" "$(pwd)/out/condensed.mp4"
python3 ../../scripts/condense.py qc "$(pwd)/out/condensed.mp4"
```

Expected: `Plan: 3 clip(s)...`, depois `Rendered out/condensed.mp4...`, depois `QC PASS: 0 error(s), 0 warning(s)` — os mesmos números já obtidos manualmente nesta sessão (1:44.9 → 1:43.8, snap ratio 1.00).

- [ ] **Step 5: Commit**

```bash
cd "/Users/jhonatan/Repos/Video editor"
git add scripts/condense.py
git commit -m "feat(scripts): wrapper de CLI pras quatro funções do motor de condense

Chama condense_index/plan/render/qc direto como funções Python, sem
transporte MCP — evita o pin em mcp==1.0.0 pra este caso de uso.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `SKILL.md` — o procedimento editorial completo

**Files:**
- Create: `docs/skills/limpar-fala/SKILL.md`

**Interfaces:**
- Consumes: `decupa condense-prep` (Task 1), `scripts/condense.py` (Task 2) — a skill só documenta como invocar o que já existe, não introduz código novo.
- Produces: nada que outra Task consuma — é o artefato final deste plano, o que faz o procedimento sobreviver sem o histórico desta conversa.

Sem teste automatizado — a verificação é a Task 4, que segue este documento à risca, como uma sessão nova faria.

- [ ] **Step 1: Escrever o SKILL.md**

`docs/skills/limpar-fala/SKILL.md`:

````markdown
---
name: limpar-fala
description: Remove gagueira, cacoete e repetição de vídeo falado em PT-BR, mantendo a fala soando natural. Use quando o pedido for para "limpar", "cortar cacoete/gagueira", "deixar mais direto" ou "tirar os erres" de uma gravação de fala — entrevista, aula, talking-head, vídeo institucional. Não use para montagem de múltiplos materiais, legendagem sem corte, ou conteúdo majoritariamente em outro idioma (o léxico de disfluência é PT-BR; inglês/chinês funcionam nativamente no motor, mas sem o ajuste feito aqui).
---

# Limpar Fala

Você é quem toma a decisão editorial — o motor mede e corta, você decide o
quê. Este documento assume zero contexto além do que está escrito aqui.

## Pré-requisitos

- `VE_PLUGIN_ROOT` apontando pro clone de `jhowtkd/video-agent-kit-plugin`
  com o patch de léxico PT-BR aplicado (`condense_lang.py` com
  `FILLERS_HARD_PT`/`FILLERS_SOFT_PT`/etc.). Se não estiver setado, o default
  é `work/video-agent-kit-plugin` na raiz deste repo.
- O sidecar de fala do Decupa configurado (`services/speech`, ver seu
  próprio README) — é o WhisperX que gera a transcrição com tempo por
  palavra.
- `ffmpeg`/`ffprobe` no PATH.

## O procedimento

### 1. Transcrever

```bash
pnpm decupa condense-prep --input <video ou wav> --out <pasta>/transcript.json
```

Isso roda o WhisperX do Decupa e já grava no formato que o motor espera.
Guarde o caminho de saída — as próximas etapas precisam dele.

### 2. Medir (`condense_index`)

```bash
python3 scripts/condense.py index <video> <pasta>/transcript.json
```

Leia o relatório inteiro, não só o resumo. Ele imprime uma tabela
`u001`–`uNNN` com flags por unidade:

| Flag | Significa |
|---|---|
| `D` | repetição quase-verbatim de uma unidade anterior |
| `F` | hesitação/gagueira dentro da unidade (já mecanicamente seguro de cortar) |
| `s` | soft filler — **sua decisão**, não corta sozinho |
| `Q` | é uma pergunta |
| `C` | abre com conectivo que aponta pra trás ("então", "mas", "e") |
| `A` | contém referência a algo dito antes ("isso", "esse") |
| `1`/`2` | abre/continua uma enumeração |
| `!` | **sem pontuação final — cortar logo depois desta unidade provavelmente corta no meio do pensamento** |
| `V` | referencia algo na tela ("olha aqui") — cortar perde o que foi mostrado |
| `x` | mais curta que o clipe mínimo — provavelmente interjeição, não decisão que vale a pena |

A seção BUDGET no relatório já diz quanto dá pra cortar só com tightening de
pausa e remoção de hesitação, sem tocar em conteúdo nenhum — leia antes de
decidir o quanto cortar.

### 3. Decidir o que fica (você, não o motor)

Monte uma lista de unidades a manter (`keep`), como faixas: `u001-u003
u005-u022`. Regras que valem sempre:

- **Nunca termine um clipe numa unidade flagada `!`** sem checar o que vem
  depois — é exatamente onde um corte lê como frase truncada.
- Soft filler (`s`) é candidato, não veredito. Leia a unidade inteira antes
  de decidir se o "tipo"/"né"/"então" ali é cacoete ou conteúdo.
- Se dropar uma unidade, confira se a unidade seguinte abre com `C` ou `A` —
  se abrir, ela provavelmente está se referindo a algo que você acabou de
  cortar.

### 4. Planejar (`condense_plan`)

```bash
python3 scripts/condense.py plan <video> --keep u001-u003 u005-u022 --drop-fillers hard
```

`--drop-fillers hard` remove só a categoria mecanicamente segura (gagueira e
hesitação), nunca soft filler. Não use `aggressive` sem ter lido cada soft
filler que ele afetaria — `aggressive` corta soft filler marcado como
"standalone" automaticamente, e isso é decisão editorial, não mecânica.

### 5. **Ler `condense_script.md` inteiro, em voz alta ou não, antes de seguir**

Isso não é opcional e não é burocracia. Nesta mesma sessão, um corte que
parecia limpo pela tabela de flags (dropar uma unidade marcada `s`/`C`/`A`)
foi sinalizado pelo próprio `condense_plan` como `mid_thought_out`: a unidade
anterior não tinha pontuação final, e o corte lia como frase truncada. Só a
leitura da prosa contínua — não a tabela, não os flags — revelou o problema.

O arquivo fica em `out/condense_script.md`, na pasta de onde você rodou o
comando. Se alguma junção não soar como uma pessoa falando, **volte pro passo
3 e ajuste o keep-list** — não segue pro render torcendo pra dar certo.

### 6. Renderizar

```bash
python3 scripts/condense.py render <video> <saída.mp4>
```

Um encode bem-sucedido só prova que o filtro rodou. Não prova que o corte
soa como gente falando — isso é o próximo passo.

### 7. Verificar (`condense_qc`)

```bash
python3 scripts/condense.py qc <saída.mp4>
```

Isso audita o **arquivo renderizado**, não o plano. Gera duas imagens de
evidência (`join_frames.jpg`, `join_waveforms.png`) — **abra as duas e olhe**
antes de declarar pronto. `QC PASS` na saída de texto não substitui olhar a
imagem: o relatório classifica o salto visual em cada corte como
subtle/visible/severe, mas só a imagem mostra se aquele "subtle" ainda
incomoda pra este material específico.

### 8. Entregar

Mande pro usuário o vídeo renderizado **e** as duas imagens de evidência —
não só o vídeo. A pessoa do outro lado não tem como confiar num "ficou bom"
sem ver o que você viu.

## O que esta skill não faz

Multi-material, montagem, geração de B-roll, legenda, tradução — o motor tem
outras skills próprias pra isso (`video-edit-assembly`,
`video-speech-workflows/talking-head-subtitles`). Esta skill é só o passe de
limpeza de fala.
````

- [ ] **Step 2: Commit**

```bash
cd "/Users/jhonatan/Repos/Video editor"
git add docs/skills/limpar-fala/SKILL.md
git commit -m "docs(skill): procedimento completo de limpeza de fala

Codifica o fluxo já provado nesta sessão — inclusive a lição de nunca
renderizar sem ler condense_script.md primeiro, aprendida na prática quando
o primeiro corte tentado foi sinalizado como mid_thought_out.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Teste de ponta a ponta seguindo só o `SKILL.md`

O teste real deste plano: alguém (ou uma sessão nova do Claude, sem o
histórico desta conversa) consegue, só lendo `docs/skills/limpar-fala/SKILL.md`,
produzir um corte limpo num vídeo diferente dos já usados.

**Files:** nenhum arquivo novo — este é um teste de processo, não de código.

- [ ] **Step 1: Escolher um vídeo ainda não testado nesta sessão**

Use `work/wav/iphone.wav` (o clipe com 60 pausas longas em 4 minutos,
identificado no início do projeto como o mais rico em hesitação real —
nunca processado pelo motor até agora). Precisa do vídeo original
correspondente, não só do WAV:

```bash
ls -la "/Users/jhonatan/Downloads/Brutos/IMG_4334.mov"
```

- [ ] **Step 2: Seguir o SKILL.md do passo 1 ao 4, sem atalho**

```bash
cd "/Users/jhonatan/Repos/Video editor"
mkdir -p work/skill-e2e-check
cd work/skill-e2e-check
export CLAUDE_PROJECT_DIR="$(pwd)"

pnpm decupa condense-prep \
  --input ../wav/iphone.wav \
  --out transcript.json

python3 ../../scripts/condense.py index \
  "/Users/jhonatan/Downloads/Brutos/IMG_4334.mov" \
  "$(pwd)/transcript.json"
```

Expected: relatório com contagem de unidades compatível com 4 minutos de
fala (bem mais que as 22 do clipe anterior), `language pt` detectado sem
precisar passar a flag.

- [ ] **Step 3: Montar keep-list real, ler o script, ajustar se preciso**

Ler a tabela impressa no Step 2. Montar uma `--keep` cobrindo as unidades
que fazem sentido manter (ignorar unidades muito curtas/interjeições
isoladas se fizer sentido editorial — decisão real, não mecânica). Rodar:

```bash
python3 ../../scripts/condense.py plan \
  "/Users/jhonatan/Downloads/Brutos/IMG_4334.mov" \
  --keep <as faixas decididas> \
  --drop-fillers hard
cat out/condense_script.md
```

Ler o `condense_script.md` inteiro. Se alguma junção ler mal, voltar e
re-rodar `plan` com o keep-list ajustado — repetir até a prosa fazer
sentido.

- [ ] **Step 4: Render + QC, e checar as imagens**

```bash
python3 ../../scripts/condense.py render \
  "/Users/jhonatan/Downloads/Brutos/IMG_4334.mov" \
  "$(pwd)/out/condensed.mp4"
python3 ../../scripts/condense.py qc "$(pwd)/out/condensed.mp4"
```

Abrir `out/.video_agent/condense_qc/*/join_frames.jpg` e `join_waveforms.png`
(usar a ferramenta de leitura de imagem, não só confiar no texto). Confirmar
visualmente, como foi feito no clipe anterior, que os cortes marcados
"subtle" realmente parecem sutis nas imagens.

Expected: `QC PASS` ou, se houver warning, uma decisão explícita registrada
sobre por que ele é aceitável ou o que foi ajustado pra resolver.

- [ ] **Step 5: Entregar e registrar**

Mandar o vídeo renderizado + as duas imagens de evidência pro usuário (mesmo
padrão da Task anterior desta sessão). Anotar em
`docs/skills/limpar-fala/SKILL.md` (comentário ou nota) qualquer ponto onde
o procedimento escrito não bateu com o que realmente foi preciso fazer —
esse é o sinal de que o documento precisa de ajuste antes de ser considerado
pronto para uma sessão sem contexto nenhum.

- [ ] **Step 6: Commit**

```bash
cd "/Users/jhonatan/Repos/Video editor"
git add docs/skills/limpar-fala/SKILL.md
git commit -m "test(skill): verifica limpar-fala de ponta a ponta em material novo

iPhone/IMG_4334, nunca processado nesta sessão antes — prova que o
procedimento escrito é suficiente sem o histórico da conversa que o gerou.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Decisões explicitamente adiadas (não deste plano)

1. **Empacotar o motor como dependência de verdade.** Hoje ele vive em
   `work/video-agent-kit-plugin` (gitignorado). Funciona via `VE_PLUGIN_ROOT`,
   mas isso não é uma história de instalação para o time — é uma pendência.
2. **`git push` do patch de léxico PT-BR** para `jhowtkd/video-agent-kit-plugin`.
   Decisão do usuário, não tomada ainda nesta sessão.
3. **Forma B (daemon/CLI standalone)** e **Forma C (interface web)** — o
   roadmap original (`decupa-projeto` na memória de projeto) trata essas como
   fases posteriores à prova de que a Forma A funciona.
4. **`snapCut` reprojetado para intervalo de silêncio sustentado** em vez de
   frame único — achado real do teste A/B desta sessão (o snap às vezes
   alcança um fechamento de consoante dentro de outra palavra), registrado em
   memória de projeto, não resolvido.

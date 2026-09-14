# ICE3-10 — Fallback de fps no probe (`r_frame_rate` → `avg_frame_rate`)

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

`probe()` usa só `r_frame_rate`; `averageFrameRate` é calculado e ignorado. Em footage VFR de celular (`r_frame_rate` 0/0, ausente ou absurdo tipo 600/1), `source.fps` vira `null` → canvas cai no default 25 fps (`applyCanvasFrom`) ou export OTIO do limpar falha com "fonte sem frame rate". A correção dentro de `probe()` beneficia automaticamente `routes.ts:182` e `server.ts:373` sem tocá-los.

Evidência: `packages/media/src/probe.ts:53-70` (seleção de streams + `frameRate`/`averageFrameRate`), `apps/cli/src/app/assembly/routes.ts:182`, `apps/cli/src/app/server.ts:373-376`.

## Escopo permitido

- PODE tocar: `packages/media/src/probe.ts`, `packages/media/src/probe.test.ts` (append).
- NÃO tocar: qualquer outro arquivo (`routes.ts`, `server.ts`, `types.ts` intocados).

## Mudança

Em `probe()`:

1. `frameRate = parseRate(r_frame_rate) ?? parseRate(avg_frame_rate)` (fallback nessa ordem).
2. Sanidade: se o valor resolvido for absurdo (`<= 0`, `> 120` fps, ou não-finito), tentar a outra fonte; se ambas absurdas/ausentes, `frameRate = null` (comportamento atual preservado).
3. `fps` (número arredondado p/ UI) deriva do `frameRate` resolvido (manter 2 casas); `averageFrameRate` continua reportando o `avg` cru.

```ts
const r = parseRate(video?.r_frame_rate);
const avg = parseRate(video?.avg_frame_rate);
const sane = (rate) => rate && rate.num / rate.den > 0 && rate.num / rate.den <= 120;
const frameRate = sane(r) ? r : sane(avg) ? avg : null;
```

## Testes (TDD, append em `probe.test.ts`)

Os testes atuais usam fixtures reais + ffprobe (lento mas OK; `clip.mp4`/`tone-gap.wav` regeneram via global-setup). Para o fallback sem depender de fixture VFR binário, fatorar a seleção em função pura exportada `selectFrameRate(rFrameRate, avgFrameRate)` e testá-la + 1 teste de integração:

1. `prefere r_frame_rate quando são` — `("30/1", "30000/1001")` → `{30,1}`.
2. `cai para avg quando r é 0/0` — `("0/0", "30000/1001")` → `{30000,1001}`.
3. `ignora r absurdo` — `("600/1", "30/1")` → `{30,1}`; `("600/1", "0/0")` → null.
4. (integração) `clip.mp4` continua `{25,1}` (paridade com teste existente — não duplicar se já coberto).

Opcional se rápido: sintetizar mp4 VFR (`-vsync vfr` com timestamps duplicados) e provar `frameRate` não-nulo — só se couber no tempo; os unitários bastam.

## Verificação

```bash
WT=/tmp/decupa-wt-10
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-10#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-10.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-10.mjs packages/media/src/probe.test.ts packages/media/src/audio.test.ts packages/media/src/hash.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Testes novos falham antes, passam depois. Testes existentes do pacote verdes. Typecheck passa. Só os 2 arquivos no diff.

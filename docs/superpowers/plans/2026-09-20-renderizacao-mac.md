# Renderização acelerada e limitada no Mac Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar a prévia aprovada sem saturar o Mac, usando VideoToolbox quando comprovadamente disponível e composição com recursos limitados.

**Architecture:** Corrigir detecção e passagem de encoder no motor existente; decompor a timeline em trechos curtos que reutilizam o compositor atual. Compartilhar uma fila de trabalhos pesados dentro do servidor, manter publicação atômica e exportação idêntica à prévia aprovada. O motor externo recebe patch reproduzível, sem descartar WIP.

**Tech Stack:** TypeScript, Python stdlib, FFmpeg/ffprobe existentes, VideoToolbox, Vitest e unittest.

**Spec:** `docs/superpowers/specs/2026-09-20-renderizacao-mac.md`

## Global Constraints

- Sem dependências novas, serviços externos ou chamadas pagas.
- Preservar originais, WIP, análises, cortes, revisão e aprovação.
- Exportar exatamente o MP4 assistido e aprovado; OTIO continua referenciando originais.
- Manter resolução e FPS do canvas atual; não prometer exportação 4K se o canvas for 720p.
- Um processo pesado de mídia por vez dentro do servidor Decupa; duas threads por decoder/encoder de software e uma thread de filtros.
- Composição em trechos de no máximo 5 segundos, processados sequencialmente; no máximo duas entradas de vídeo simultâneas no contrato V1/V2 atual.
- VideoToolbox só pode ser declarado ativo após encode real bem-sucedido; fallback software deve ser explícito e limitado.
- Não executar a montagem completa do usuário como primeiro teste.

## Review Focus

- Vídeo silencioso ou codec incompatível: não confundir ausência de áudio com falha do encoder; fallback não pode publicar artefato parcial. Task 1.
- VFR, rotação e FPS fracionário: preservar orientação e bordas em frames, não acumular erro de concatenação. Task 2.
- Fala contínua cruzando intervalos e b-roll sem áudio: não duplicar AAC, cortar sílabas ou misturar áudio do apoio. Task 2.
- Cancelamento durante Python/FFmpeg e fila ocupada: encerrar descendentes, não iniciar trabalho cancelado, preservar referência anterior. Task 3.
- Cache antigo e fonte alterada: invalidar resultados com perfil/formato antigo e recusar original modificado; entrega não pode apontar para proxy. Tasks 1, 3 e 4.

## Mapa de arquivos

- `apps/cli/src/app/assembly/hardware.ts`: prova real e cache versionado do perfil.
- `apps/cli/src/app/assembly/render.ts`: identidade do renderer, integração e publicação.
- `scripts/render-assembly.py`: adaptador e limites enviados ao motor.
- `work/video-agent-kit-plugin/mcp/ve_tools/render.py`: composição existente, único compositor, encoder e segmentação; checkout externo.
- `scripts/engine/assembly-resource-limits.patch` e `.APPLY`: distribuição reproduzível do delta do motor.
- `scripts/test_render_resources.py`: unittest do motor importado via VE_PLUGIN_ROOT, sem infraestrutura nova.
- `apps/cli/src/app/assembly/media.ts`: limites dos proxies e miniaturas.
- `apps/cli/src/app/assembly/media-work.ts`: única instância de createLimitedQueue(1), compartilhada por mídia/render.
- `apps/cli/src/app/pipeline.ts`: encerramento da árvore de processos, se necessário após verificar comportamento atual.
- Testes existentes `hardware.test.ts`, `render.test.ts`, `media.test.ts`, `preparation.test.ts`, `tests/assembly-delivery.test.ts`: regressões do caminho público.

Antes de editar, registrar `git status --short` e diffs dos dois checkouts. Criar worktree na execução pela skill using-git-worktrees; copiar somente o baseline necessário sem perder WIP. Não executar git add de arquivos completos que contenham trabalho alheio: separar hunks ou usar snapshot isolado. O patch do motor deve conter apenas o delta desta tarefa sobre o baseline local registrado.

### Task 1: Fazer a aceleração chegar ao FFmpeg

**Files:** Modify hardware.ts, render.ts, scripts/render-assembly.py e motor render.py; Test hardware.test.ts, render.test.ts e scripts/test_render_resources.py; Create scripts/engine/assembly-resource-limits.patch e .APPLY.

**Interfaces:** Preservar `encoderFor(profile)` e `renderAssembly(a, outDir, exec, opts): Promise<string>`. O motor passa a aceitar `build_project_ffmpeg_command(plan, output_path, work_dir, encoder="libx264", hwaccel="")`; `render_project_timeline` passa os argumentos explicitamente. O perfil permitido é validado, não interpolado em shell.

- [ ] **Step 1: Acrescentar regressões de encoder e posição das opções.** No unittest, extrair helper testável `video_output_args(encoder: str) -> list[str]` no motor:

```python
def test_encoder(self):
    self.assertIn("h264_videotoolbox", video_output_args("h264_videotoolbox"))
    self.assertNotIn("-crf", video_output_args("h264_videotoolbox"))
    self.assertIn("-threads", video_output_args("libx264"))
    with self.assertRaises(ValueError):
        video_output_args("invalid")
```

No teste existente de hardware, capturar args de exec: `expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"))`. Adaptar a fixture silenciosa existente ou gerar `testsrc2` sem áudio; sucesso exige vídeo e duração, não áudio. Simular falha de hardware e verificar fallback software e ausência de publicação parcial.

- [ ] **Step 2: Rodar RED.** `pnpm vitest run apps/cli/src/app/assembly/hardware.test.ts apps/cli/src/app/assembly/render.test.ts`; `python3 -m unittest discover -s scripts -p 'test_render_resources.py'`. Falhar pelos contratos novos, não por plugin ausente; definir VE_PLUGIN_ROOT para o checkout inspecionado.

- [ ] **Step 3: Implementar encoder e corrigir detecção.** Separar opções de entrada de saída em hardware.ts: `-hwaccel videotoolbox` antes de `-i`, decoder `-threads 2`, saída `-threads 2`, filtros `-filter_threads 1`. Prova com 2s e saída 640px, preservando proporção; exigir `hasVideo`, duração >0 e saída íntegra. Não exigir áudio. Invalidar profile.json antigo com `version: 2`; invalidar previewIdentity com `rendererVersion: 2`. Motor:

```python
def video_output_args(encoder: str) -> list[str]:
    if encoder == "h264_videotoolbox":
        return ["-c:v", encoder, "-allow_sw", "0", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    if encoder == "libx264":
        return ["-c:v", encoder, "-preset", "veryfast", "-crf", "20",
                "-threads", "2", "-pix_fmt", "yuv420p"]
    raise ValueError("encoder não suportado neste caminho")
```

Preservar plataformas fora do Mac com software limitado neste caminho; não anunciar nvenc/vaapi ativo se não implementado pelo motor. Substituir exigência fixa de libx264 por encoder selecionado. Reportar encoder efetivo no relatório do motor; falha de hardware pode repetir uma única vez em software, com novo workdir e cache identificado como software, nunca esconder o fallback. Manter validação e rename atuais.

- [ ] **Step 4: Rodar GREEN e smoke curto.** Mesmos comandos; `pnpm typecheck`. Encode sintético de 2s com VideoToolbox e validar via ffprobe. Sem benchmark de originais nesta tarefa. Capturar comando e encoder no resultado do teste.
- [ ] **Step 5: Versionar o delta e commit.** Gerar patch somente contra o snapshot inicial do motor; documentar `git apply --check` e `git apply` em .APPLY, abortando conflito sem reset. Commit isolado: `fix: honor hardware encoder in assembly rendering`.

### Task 2: Limitar entradas simultâneas sem reduzir a entrega

**Files:** Modify motor render.py e patch/.APPLY; Test scripts/test_render_resources.py e render.test.ts.

**Interfaces:** Adicionar `render_intervals(plan: dict) -> list[tuple[int, int]]` em frames; `slice_render_plan(plan: dict, start_frame: int, end_frame: int) -> dict`. Reutilizar `build_project_ffmpeg_command` para cada trecho. O contrato de saída permanece um MP4 no canvas original, com áudio global e relatório.

- [ ] **Step 1: Testar intervalos e memória estrutural.** Construir planos mínimos com keys reais de `build_render_plan`; preservar os nomes já usados pelo motor (`timeline_start`, `render_duration`, `source_duration`, `start`). Casos: dois clipes V1 sequenciais, V2 cruzando fronteira, silêncio e lacuna preta.

```python
def test_intervals(self):
    plan = {"fps": 25, "duration": 12, "video_clips": [], "overlay_clips": []}
    self.assertEqual(render_intervals(plan), [(0, 125), (125, 250), (250, 300)])
```

Para plano com V1 0–12s e V2 4–6s, exigir fronteiras em 100 e 150 frames, no máximo 125 frames por intervalo e no máximo duas entradas de vídeo por comando. Fonte original deve continuar sendo input, nunca `media/*/proxy.mp4`.
- [ ] **Step 2: Rodar RED.** `python3 -m unittest discover -s scripts -p 'test_render_resources.py'`; falhar na ausência das funções ou na quantidade de entradas.
- [ ] **Step 3: Implementar segmentação temporal.** Construir bordas por início/fim dos clipes em frames, mais 0 e duração; subdividir cada intervalo sem sobreposição. Recortar somente clipes que intersectam o intervalo:

```python
local_start = max(clip_start_frame, start_frame)
local_end = min(clip_end_frame, end_frame)
# Deslocar start da fonte pela diferença / fps, respeitando speed existente.
# timeline_start local = (local_start - start_frame) / fps.
# render_duration local = (local_end - local_start) / fps.
```

Usar cópias de dict; não mutar plano original. Rejeitar sobreposição que exceda o contrato V1/V2 em vez de abrir entradas ilimitadas. Filtrar entrada com `-threads 2`, composição `-filter_complex_threads 1`, e renderizar um trecho por vez. Renderizar trechos de vídeo sem áudio (`-an`), todos com mesmo encoder/pix_fmt/FPS/canvas. Concatenar por demuxer concat com `-c:v copy`. Executar a mixagem global uma vez usando `bake_project_audio_beds` existente, com filtros limitados, anexando o áudio ao vídeo concatenado; não concatenar AAC de cada trecho. Escapar caminhos do manifesto concat, usar subprocess com lista de args. Remover intermediários só do workdir exclusivo no finally existente.
- [ ] **Step 4: Verificar AV real.** Estender a fixture vermelha/azul e tons existente de render.test.ts para 12s, V2 atravessando 5s, com cortes em FPS 30000/1001. Verificar frames imediatamente antes/depois das bordas, duração dentro de um frame, frequência do áudio da fala e ausência do tom do apoio. Acrescentar entrada portrait com metadata de rotação e VFR: comparar orientação e duração via ffprobe e frames decodificados, não apenas exit code. Rodar `pnpm vitest run apps/cli/src/app/assembly/render.test.ts` e unittest.
- [ ] **Step 5: Atualizar patch e commit.** `perf: render assembly in bounded sequential intervals`.

### Task 3: Compartilhar orçamento de mídia e cancelar descendentes

**Files:** Create media-work.ts; Modify media.ts, render.ts e pipeline.ts somente onde necessário; Test media.test.ts, render.test.ts, preparation.test.ts.

**Interfaces:** `export const mediaWork = createLimitedQueue(1)` em media-work.ts. Usar interface `.run(task, {key})` já existente; fila não reentrante. Não enfileirar um trabalho externo que aguarda outro trabalho nessa mesma fila.

- [ ] **Step 1: Testar concorrência e cancelamento.** No executor fake existente, bloquear a primeira execução, solicitar proxy e render simultâneos, depois liberar; contar máximo de execuções pesadas:

```ts
let active = 0, peak = 0;
// No exec fake compartilhado, antes/depois da barreira da fixture:
active++; peak = Math.max(peak, active);
// finally da execução fake:
active--;
// Após Promise.all das chamadas públicas:
expect(peak).toBe(1);
```

Adicionar cancelamento antes da liberação da fila: não deve lançar FFmpeg depois de cancelado. Teste de integração com Python que cria subprocesso local adormecido: cancelar encerra pai e filho, sem tocar outros processos. Referência anterior permanece com mesmo hash.
- [ ] **Step 2: Rodar RED.** `pnpm vitest run apps/cli/src/app/assembly/media.test.ts apps/cli/src/app/assembly/render.test.ts apps/cli/src/app/assembly/preparation.test.ts`.
- [ ] **Step 3: Integrar fila e limites.**

```ts
// media-work.ts
import { createLimitedQueue } from "@decupa/queue";
export const mediaWork = createLimitedQueue(1);
```

Manter deduplicação por fonte existente; envolver somente exec pesado com mediaWork.run. Não adquirir fila ao redor de renderAssembly inteiro se a detecção também adquire fila. Miniatura pode enfileirar seu próprio exec; não aguardar miniatura enquanto mantém slot do proxy. Aplicar threads 2/filtros 1 aos proxies e áudio. Reutilizar encoderFor/prova para proxy, sem detectar hardware recursivamente na fila. Verificar cancelamento do Executor antes de lançar um job que saiu da fila. Em POSIX, se o executor ainda não fizer isso, criar grupo próprio para processos que controla e encerrar grupo com SIGTERM seguido por SIGKILL após prazo de 2s; nunca `pkill ffmpeg` global. Preservar comportamento das outras chamadas de Executor e testar o shutdown existente.
- [ ] **Step 4: Rodar GREEN e typecheck.** Repetir os testes e `pnpm typecheck`. Exercitar proxy cache hit sem novo encode, proxy corrompido regenerado e fonte modificada recusada antes de renderizar.
- [ ] **Step 5: Commit.** `fix: bound local media work and cancel render descendants`.

### Task 4: Medir amostra segura e fechar contrato de entrega

**Files:** Modify render.test.ts, tests/assembly-delivery.test.ts; Create scripts/render-resource-proof.py e docs/superpowers/evidence/2026-09-20-renderizacao-mac.md; atualizar patch final.

**Interfaces:** Script stdlib recebe comando após `--`, lança somente esse processo/grupo, amostra PID e descendentes via `ps` a cada 500ms e grava JSON com wall_seconds, peak_rss_bytes, cpu_percent_samples, exit_code e stopped_for_memory. Sem credenciais e sem chamadas externas.

- [ ] **Step 1: Fixar exportação e identidade.** Estender teste existente de entrega: hash de `exports/.../reference.mp4` deve ser igual ao previewArtifact aprovado; paths do OTIO devem corresponder aos originais. Perfil e rendererVersion diferentes geram identidades diferentes; cache antigo não serve. Rodar `pnpm vitest run tests/assembly-delivery.test.ts apps/cli/src/app/assembly/render.test.ts`.
- [ ] **Step 2: Criar medição com interrupção.** Usar `subprocess.Popen(command, start_new_session=True)`; obter RAM por `sysctl -n hw.memsize`, RSS de `ps -axo pid=,ppid=,rss=,pcpu=` e somar árvore descendente, em bytes (`rss * 1024`). Implementar teto do ensaio:

```python
limit = min(4 * 1024**3, physical_memory // 4)
if rss_bytes > limit:
    os.killpg(process.pid, signal.SIGTERM)
    stopped_for_memory = True
```

Reap/kill após 2s se não encerrou; monitorar também Ctrl+C. Registrar `sysctl vm.swapusage` antes/depois, sem interpretar swap global como uso exclusivo do app. Validar script com filho Python sintético de pequeno consumo e teto reduzido por argumento exclusivo do teste.
- [ ] **Step 3: Rodar fixture sintética de 10s.** H.264/AAC, portrait e V2; provar hardware real e fallback limitado separadamente. Registrar comando, versões, perfil, quantidade máxima de inputs, RSS e resultado AV. Não rodar versão antiga sem limites como comparação.
- [ ] **Step 4: Rodar amostra real de 10s em cópia isolada.** Localizar projeto atual, não presumir existência de `/tmp/decupa-teste`; selecionar mídia acessível sem alterar o original. Sem IA ou reanálise. Monitorar com script, abortar pelo teto e validar preview antes de ampliar. Se fonte/projeto não estiver disponível, registrar bloqueio, não fabricar resultado. Pedir avaliação de responsividade ao usuário antes de renderizar tudo.
- [ ] **Step 5: Verificar e entregar.** `pnpm typecheck`; `pnpm vitest run apps/cli/src/app/assembly/hardware.test.ts apps/cli/src/app/assembly/media.test.ts apps/cli/src/app/assembly/render.test.ts apps/cli/src/app/assembly/preparation.test.ts tests/assembly-delivery.test.ts`; unittest; `git diff --check`. Evidência deve separar testes automatizados, encode hardware comprovado, recursos medidos e avaliação humana. Commit: `test: verify bounded Mac render and approved export integrity`.

## Self-review e handoff

Cobertura: aceleração Task 1; quantidade de decoders/memória estrutural Task 2; concorrência/cancelamento Task 3; medição e export Task 4. Sem dependências, schema persistente de projeto, master novo ou UI de edição nova. O perfil derivado e a identidade do cache são versionados intencionalmente. O usuário revisa este plano antes da execução; abordagem nativa mantém o contrato entre adaptador e motor sob um único executor e usa revisão independente final.

# Montagem multiarquivo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Um executor por vez; revisão entre entregas. Não despachar agentes sem escolha explícita do usuário.

**Goal:** Montar falas e imagens de apoio de vários arquivos, com duas aprovações editoriais, entregando timeline editável no DaVinci e referência correspondente.

**Architecture:** Evoluir o app local e reaproveitar transcrição, triagem e renderização de múltiplas pistas do motor existente. Uma montagem versionada alimenta a prévia e o intercâmbio; o modelo propõe cenas, enquanto código valida referências, tempos e aprovações.

**Tech Stack:** Node.js >=22, TypeScript executado com strip-types, node:http, HTML/JS, Vitest, Python e FFmpeg já presentes. Nenhuma dependência nova prevista.

**Spec:** `docs/superpowers/specs/2026-09-11-montagem-multiarquivo-design.md`, aprovada em 2026-09-11.

## Global Constraints

- Os originais não são modificados.
- O fluxo de limpeza existente permanece funcional; não haverá outra implementação da mesma triagem.
- HyperFrames, Remotion, geração de cenas sintéticas e integração com agentes externos não fazem parte deste escopo.
- Timeline e vídeo devem consumir a mesma representação da montagem.
- Proxies servem à análise/prévia; a entrega editável referencia os originais.
- Não introduzir upload remoto ou trocar o provedor/modelo da triagem por dedução.
- Confirmar os custos e o envio de mídia antes de qualquer chamada paga.
- Não adotar dois motores de renderização ou dois formatos de exportação como precaução.
- A aprovação do desenho não autoriza alterações de API, esquema ou dependências ainda não apresentadas. Os contratos abaixo são a proposta concreta para aprovação de execução.
- Preservar trabalho alheio. Criar branch `codex/montagem-multiarquivo` na execução; nunca `git add -A`.

---

## Organização das entregas

O produto envolve três partes. Executar nesta ordem, com entrega verificável ao
fim de cada parte; não iniciar todas ao mesmo tempo:

| Entrega | Tarefas | Resultado independente |
|---|---|---|
| A — montagem e intercâmbio | 1–4 | Plano manual de várias fontes gera referência e timeline importada no DaVinci |
| B — entendimento do material | 5–6 | Projeto retoma análise por arquivo e permite consultar fala e contexto visual |
| C — edição assistida | 7–10 | Roteiro/briefing → cenas revisáveis → prévia → ajustes → entrega |

### Evidências de partida

- Checkout limpo ao iniciar o planejamento; base de especificação `1468f62`.
- DaVinci instalado: `21.0.4`, consultado em `Info.plist` em 2026-09-11.
- A documentação de scripting instalada lista importação de OTIO e FCPXML em
  `MediaPool.ImportTimelineFromFile`. Isso não prova fidelidade da importação.
- `apps/cli/src/app/edl.ts` serve uma fonte/pista com fps inteiro: preservar o
  comando de limpeza, não usar esse EDL como base da entrega multipista.
- `work/video-agent-kit-plugin/mcp/ve_tools/render.py` já expõe
  `render_preview(args, ctx)` e encaminha timelines com `tracks` para
  `render_project_timeline`. Reutilizar essa função por wrapper Python, como
  `scripts/condense.py`; não criar outro compositor FFmpeg.
- `packages/media/src/probe.ts` arredonda fps a duas casas. O novo intercâmbio
  precisa consultar o racional original; não reconstruir 30000/1001 de 29.97.

### Escolhas propostas e limites

**Intercâmbio inicial: OTIO**, formato JSON documentado que representa pistas,
clipes e lacunas. Escrever somente o subconjunto necessário, sem instalar SDK.
É candidato sujeito à prova da tarefa 4. Se falhar, corrigir o exportador ou
revisar a escolha com evidências antes de continuar; não adicionar FCPXML em
paralelo. A lista de formatos do Resolve está no README local, seção MediaPool:
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt`.
Referência do esquema: [OpenTimelineIO, dados serializados](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/docs/tutorials/otio-serialized-schema.md).

**Entrada local:** comando `decupa montar --project <pasta> --input <arquivo>`
repetível, abrindo o mesmo servidor do app. Para acrescentar arquivos, usar um
seletor nativo macOS acionado pelo servidor somente por ação explícita na UI;
retornar cancelamento sem erro. Nada de uploader remoto nem navegador livre
do filesystem. Reusar o projeto ao omitir `--input` na reabertura.

**Análise nova:** propor o mesmo provedor configurado, sem alterar prompts ou
modelo da triagem. A capacidade de descrição visual ampla precisa de uma prova
com mídia autorizada na tarefa 6; falha não autoriza troca automática de modelo.
Testes usam respostas roteirizadas e não fazem chamadas externas.

**Montagem inicial:** cortes secos, velocidade 1, vídeo base + apoio e áudio de
fala separado. O apoio fica sem áudio por padrão. Clipe de áudio sem vídeo pode
ser coberto por apoio; lacuna visual fica explícita e bloqueia aprovação final.
Não acrescentar transições, títulos, música ou correção de cor ao escopo.

**Mídia:** aceitar CFR e testar fps fracionário/misto antes da entrega final.
VFR, HDR e rotação/metadados não representáveis devem aparecer como incompatíveis,
sem conversão silenciosa. Documentar qualquer limite observado; a tarefa 10 não
pode declarar compatibilidade universal. Preservar proporção com ajuste dentro
do quadro, sem recorte automático. O quadro e fps da montagem são confirmados
na tela com padrão derivado do primeiro vídeo de fala.

## Mapa de arquivos

Novos módulos ficam em `apps/cli/src/app/assembly/`, dentro do app existente:

| Arquivo | Responsabilidade |
|---|---|
| `types.ts`, `validate.ts` | Contrato e validação de montagem |
| `otio.ts` | Uma saída de intercâmbio |
| `render.ts` | Converter montagem para contrato do motor e chamar wrapper |
| `store.ts` | Projeto, revisões e escritas atômicas |
| `analysis.ts` | Coordenar análise e cache por fonte |
| `visual.ts` | Validar mapa temporal e consultas |
| `model.ts` | Novos pedidos de descrição/proposta; sem lógica de corte |
| `scenes.ts` | Validar proposta e compilar cenas para montagem |
| `routes.ts`, `page.html` | Operações e interface do novo fluxo |

Criar cada arquivo apenas na tarefa que o utiliza, com teste adjacente. Não
criar pacote workspace ou serviços novos. Outros arquivos necessários:
`scripts/render-assembly.py`, `scripts/assembly-proof.ts`,
`packages/triage/src/zai-client.ts` (extração de transporte na tarefa 6), e
alterações pontuais em `apps/cli/src/index.ts` e `apps/cli/src/app/server.ts`.

## Contratos propostos

Todos os tipos abaixo pertencem a `assembly/types.ts`. Intervalos são
semiabertos, origem inclusiva e fim exclusivo. Tempos da fonte são segundos
desde o início decodificável; posições/durações da montagem são frames inteiros.
Timecode da mídia é metadado separado, nunca somado duas vezes.

```ts
export type Rate = { num: number; den: number };
export type Source = {
  id: string; path: string; sha256: string; durationSeconds: number;
  hasVideo: boolean; hasAudio: boolean; fps: Rate | null;
  width: number | null; height: number | null;
  role: "speech" | "support" | "both";
};
export type Clip = {
  id: string; sceneId: string; sourceId: string;
  sourceStartSeconds: number; startFrame: number; durationFrames: number;
};
export type Track = { kind: "Video" | "Audio"; name: string; clips: Clip[] };
export type Assembly = {
  version: 1; revision: number; name: string;
  fps: Rate; width: number; height: number;
  sources: Source[]; tracks: Track[];
};
export type Span = {
  id: string; sourceId: string; start: number; end: number; text: string;
};
export type VisualSpan = Span & {
  confidence: "observed" | "uncertain" | "unavailable";
  tags: string[];
};
export type Scene = {
  id: string; objective: string; rationale: string;
  speechIds: string[];
  support: { visualId: string; offsetFrames: number; durationFrames: number }[];
  gaps: string[];
};
export type Analysis = {
  sourceId: string; key: string;
  speech: Span[]; visual: VisualSpan[];
  status: "ready" | "partial" | "error"; error?: string;
};
export type Proposal = {
  id: string; baseRevision: number; scenes: Scene[];
  changedSceneIds: string[]; explanation: string;
};
export type Project = {
  version: 1; id: string; revision: number;
  input: { kind: "script" | "brief"; text: string; targetSeconds: number };
  assembly: Assembly; scenes: Scene[]; analyses: Analysis[];
  proposal: Proposal | null;
  structureApprovedRevision: number | null;
  previewRevision: number | null; finalApprovedRevision: number | null;
};
```

Fontes são identificadas por hash de conteúdo, não basename. Duplicar o mesmo
arquivo não duplica sua análise. A seleção de papel pode ser alterada sem
invalidar a compreensão já obtida. Um novo conteúdo no mesmo caminho é outra
fonte e exige revisão dos trechos que dependiam do anterior.

## Tarefa 1 — validar montagem e identidade temporal

**Files:** criar `assembly/types.ts`, `assembly/validate.ts`,
`assembly/validate.test.ts`, `assembly/fixture.ts` (dados sintéticos apenas).

**Interfaces:** `validateAssembly(value: unknown): Assembly` valida sem I/O;
`fixtureAssembly(): Assembly` retorna objeto novo com duas fontes e três pistas.

- [ ] Escrever teste de limites e origem inexistente:

```ts
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { validateAssembly } from "./validate.ts";
it("recusa clipe que ultrapassa a fonte", () => {
  const a = fixtureAssembly();
  a.tracks[0]!.clips[0]!.sourceStartSeconds = 99;
  expect(() => validateAssembly(a)).toThrow(/fonte/);
});
it("aceita uma montagem com fala e apoio sobreposto em outra pista", () => {
  expect(validateAssembly(fixtureAssembly()).tracks).toHaveLength(3);
});
```

- [ ] Executar `pnpm exec vitest run apps/cli/src/app/assembly/validate.test.ts`;
  esperar falha por módulo ausente, não erro de dependência.
- [ ] Implementar tipos e fixture: 25/1 fps, 320×240, duas fontes de 3 s;
  V1 fonte A em `[0,50)`, V2 fonte B em `[25,50)`, A1 fonte A em `[0,50)`.
  IDs de fonte `a`/`b`, cena `s1`, sourceStartSeconds zero, hashes distintos
  de 64 caracteres hexadecimais, paths absolutos sintéticos. Usar cópias novas.
- [ ] Validar objetos/arrays antes de acessá-los; IDs únicos; fps num/den
  inteiros positivos; largura/altura pares positivas; frames seguros e
  positivos, startFrame >=0; números finitos; fonte presente e stream correto.
  Por pista, ordenar cópia dos clipes e rejeitar sobreposição. Verificar:

```ts
const seconds = clip.durationFrames * assembly.fps.den / assembly.fps.num;
if (clip.sourceStartSeconds < 0 ||
    clip.sourceStartSeconds + seconds > source.durationSeconds + 1e-9) {
  throw new Error(`clipe ${clip.id} ultrapassa a fonte ${source.id}`);
}
```

- [ ] Acrescentar casos NaN, fps 30000/1001, fonte ausente e sobreposição na
  mesma pista; executar teste e `pnpm typecheck`.
- [ ] Commit apenas dos quatro arquivos desta tarefa: `feat: validate assembly timelines`.

## Tarefa 2 — exportar um único formato editável

**Files:** criar `assembly/otio.ts`, `assembly/otio.test.ts`.

**Interfaces:** `buildOtio(assembly: Assembly): string`, consome saída validada
da tarefa 1 e retorna JSON. Nenhuma chamada ao DaVinci nesta função.

- [ ] Teste inicial: estrutura contém três Track, V2 começa com Gap de 25
  frames e depois fonte B; A1 referencia A. Usar fixture da tarefa 1:

```ts
const doc = JSON.parse(buildOtio(fixtureAssembly()));
expect(doc.OTIO_SCHEMA).toBe("Timeline.1");
expect(doc.tracks.children).toHaveLength(3);
expect(doc.tracks.children[1].children[0].OTIO_SCHEMA).toBe("Gap.1");
expect(doc.tracks.children[1].children[0].source_range.duration.value).toBe(25);
```

- [ ] Executar `pnpm exec vitest run apps/cli/src/app/assembly/otio.test.ts`;
  confirmar falha e implementar Timeline/Stack/Track/Clip/Gap/ExternalReference
  segundo o esquema oficial. Fixar as versões de objetos realmente importadas
  pela prova; não copiar todos os campos da biblioteca.
- [ ] Converter posição em lacunas por pista, preservando ordem das pistas.
  `pathToFileURL(source.path).href` gera URL sem concatenação manual. Duração
  permanece RationalTime em fps da timeline; source start usa segundos
  (`value: sourceStartSeconds, rate: 1`) e available_range da fonte.

```ts
const time = (value: number, rate: number) =>
  ({ OTIO_SCHEMA: "RationalTime.1", value, rate });
const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: "TimeRange.1", start_time: time(start, rate),
  duration: time(duration, rate),
});
// Gap entre cursor e clip.startFrame; cursor avança para startFrame + durationFrames.
```

- [ ] Testar nome com espaço/acentos/#, dois arquivos com mesmo basename,
  posição fracionária da fonte e fps 30000/1001, sem arredondar para 29.97.
- [ ] Rodar testes de validate/otio e typecheck; commit dos dois arquivos:
  `feat: export assembly tracks as OTIO`.

## Tarefa 3 — prévia usando o compositor existente

**Files:** criar `assembly/render.ts`, `assembly/render.test.ts`,
`scripts/render-assembly.py`.

**Interfaces:** `toEngineTimeline(a: Assembly): object`;
`renderAssembly(a: Assembly, outDir: string, exec: Executor): Promise<string>`.
Executor vem de `app/pipeline.ts`; retorno é path do MP4 concluído.

- [ ] Testar que a conversão preserva as três pistas e não duplica áudio:

```ts
const result = toEngineTimeline(fixtureAssembly()) as { tracks: any[] };
expect(result.tracks.map(t => t.type)).toEqual(["video", "video", "audio"]);
expect(result.tracks[0].clips[0].volume).toBe(0);
expect(result.tracks[2].clips[0].volume).toBe(1);
expect(result.tracks[1].clips[0].timeline_start).toBe(1);
```

- [ ] Executar teste, confirmar falha; converter cada clip para os campos já
  consumidos por `normalize_project_clip`:

```ts
const frameSeconds = a.fps.den / a.fps.num;
// Para cada track e clip, usando a fonte resolvida pelo sourceId:
const engineClip = {
  source: source.path, start: clip.sourceStartSeconds,
  end: clip.sourceStartSeconds + clip.durationFrames * frameSeconds,
  timeline_start: clip.startFrame * frameSeconds,
  volume: track.kind === "Audio" ? 1 : 0, speed: 1,
};
```

- [ ] Usar `output_canvas: {width, height, fps: num/den}` e tracks com order
  crescente. Gravar `timeline.json` em pasta exclusiva da revisão. Wrapper
  segue resolução de `VE_PLUGIN_ROOT` e import direto de `scripts/condense.py`:

```python
from ve_tools.render import render_preview
from ve_tools.run_context import RunContext
result = render_preview({"timeline_path": args.timeline,
                         "output_path": args.out,
                         "work_dir": args.work}, RunContext(session_kind="cli"))
print(result.text)
raise SystemExit(2 if result.text.lstrip().startswith("[ERROR]") else 0)
```

- [ ] Completar argparse `--timeline`, `--out`, `--work` obrigatórios; informar
  motor ausente como erro. Executar via Executor com cwd e CLAUDE_PROJECT_DIR
  exclusivos; validar exit code e arquivo de saída antes de retornar path.
- [ ] Testar falha roteirizada do Executor sem sucesso falso; rodar teste,
  `python3 scripts/render-assembly.py --help` e typecheck. Commit:
  `feat: render assemblies with existing project compositor`.

## Tarefa 4 — prova de importação no DaVinci

**Files:** criar `scripts/assembly-proof.ts`,
`docs/superpowers/evidence/2026-09-11-davinci-assembly.md` somente na execução.
Artefatos gerados ficam em `work/assembly-proof/`, ignorado pelo git.

**Interfaces:** script importa `validateAssembly`, `buildOtio`,
`renderAssembly`, `SpawnExecutor` e gera JSON, OTIO e MP4 da mesma revisão.

- [ ] Gerar duas fontes sintéticas de 3 s usando execFile, sem shell:

```ts
await run("ffmpeg", ["-n", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=3",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourceA]);
await run("ffmpeg", ["-n", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceB]);
```

  `run` é promisify(execFile); sourceA/B são paths em diretório novo criado
  com mkdtemp dentro de work/assembly-proof. Substituir hashes fictícios por
  `hashFile` e paths reais na fixture. O script deve ser reexecutável sem
  sobrescrever saídas anteriores.
- [ ] Executar `node --experimental-strip-types scripts/assembly-proof.ts`.
  Esperar referência de 50 frames: vermelho no frame 24 e azul no 25, áudio
  contínuo de A por 2 s. Conferir frames extraídos e duração com FFmpeg/ffprobe.
- [ ] Criar projeto de teste separado no DaVinci; importar OTIO com suas fontes.
  Não mudar projetos existentes. Verificar V1, V2, A1, fontes online, posições
  0/25/50 e continuidade sonora. Registrar versão, parâmetros, resultado e
  capturas na evidência. Nunca usar apenas “arquivo abriu” como aceitação.
- [ ] Repetir prova com 30000/1001 e fonte 25 fps sobre timeline 30000/1001;
  acrescentar fonte com timecode não zero e orientação/aspecto diferentes.
  Comparar importação com referência, sem deriva acumulada nem recorte extra.
- [ ] Se houver perda de pista, áudio, quadro ou timecode: corrigir conversão
  e rerodar só o cenário afetado. Se exigir outra dependência/formato, apresentar
  mudança concreta antes de seguir. Se o compositor precisar de correção,
  registrar patch reproduzível como já feito em scripts/engine, não editar só
  o clone ignorado e declarar concluído.
- [ ] Commit do script/evidência textual após comprovação. Gate A: três pistas
  corretas, mesmo número de frames, fontes ajustáveis e áudio sincronizado.

## Tarefa 5 — projeto local, fontes e retomada

**Files:** criar `assembly/store.ts`, `assembly/store.test.ts`,
`assembly/analysis.ts`, `assembly/analysis.test.ts`; estender
`packages/media/src/probe.ts`, `types.ts` e `probe.test.ts` com `frameRate: Rate | null`
e `averageFrameRate: Rate | null` sem mudar o campo fps existente.

**Interfaces:** `loadProject(dir: string): Promise<Project>`;
`saveProject(dir: string, expectedRevision: number, next: Project): Promise<void>`;
`createProject(dir: string, initial: Project): Promise<void>` usa criação exclusiva
e nunca sobrescreve um projeto existente;
`analyzeSource(source: Source, dir: string, exec: Executor): Promise<Analysis>`.

- [ ] Escrever teste com pasta temporária: salvar revisão 2 tendo base 1;
  tentar segunda escrita com base 1; esperar conflito e manter revisão 2.

```ts
await saveProject(dir, 1, next);
await expect(saveProject(dir, 1, next)).rejects.toThrow(/revisão/);
expect((await loadProject(dir)).revision).toBe(2);
```

- [ ] Rodar teste; implementar JSON em `project.json`, arquivo temporário no
  mesmo diretório e rename atômico, após validar next e comparar a revisão
  dentro de uma fila de escrita por projeto. Um processo escritor por projeto,
  com lock criado usando `open(path, "wx")`; recusar segunda instância. Lock
  abandonado exige verificar PID antes de liberar, sem apagar o projeto.
- [ ] Usar `hashFile` existente para fontes; diretórios `analysis/<sha>/<key>`
  distinguem conteúdo/configuração. Probe preserva num/den; média diferente da
  taxa nominal é indício para verificar VFR, não prova absoluta de CFR.
- [ ] Para fala, chamar `runIngest` e triagem existentes em workDir exclusivo
  da fonte/configuração. Não chamar transcrição em vídeo sem áudio. Para áudio
  sem vídeo, reutilizar `runCondensePrep` e indexação de fala, sem sidecar visual.
  Associar IDs como `<sourceId>:<unitId>` antes de reunir arquivos.
- [ ] Salvar resultado por etapa concluída. Chave contém hash da fonte,
  parâmetros da transcrição, versão dos prompts e modelo; briefing fica fora.
  Cache inválido aparece como análise pendente, sem chamada paga automática.
- [ ] Testar dois arquivos com nomes iguais, reabertura, troca de briefing sem
  novas chamadas do Executor, arquivo falho sem descarte do outro e mídia
  removida. Mensagem de mídia ausente preserva Project carregável.
- [ ] Rodar testes store/analysis/probe e typecheck; commit com allowlist dos
  arquivos acima: `feat: persist multi-source projects and analysis progress`.

## Tarefa 6 — compreensão visual temporal

**Files:** criar `assembly/visual.ts`, `visual.test.ts`, `model.ts`, `model.test.ts`;
extrair transporte de `packages/triage/src/zai.ts` para `zai-client.ts`, com
teste adjacente e ajuste do import em zai.ts. Não mudar TriageModel.

**Interfaces:** `validateVisual(raw: unknown, source: Source): VisualSpan[]`;
`visualAt(spans: VisualSpan[], second: number): VisualSpan[]`;
`describeSource(source: Source, dir: string, signal: AbortSignal): Promise<VisualSpan[]>`.
`ZaiClient.send(content: unknown[], signal?: AbortSignal): Promise<string>` e
`usage()` preservam comportamento de transporte; ZaiTriageModel delega a ele.

- [ ] Primeiro congelar, via fetch roteirizado, payloads/erros/retries/usage
  atuais de ZaiTriageModel. Rodar zai.test.ts antes e depois da extração.
  Prompts, modelo, endpoint e limites da triagem devem ser idênticos.
- [ ] Testar mapa com `[0,1)`, `[1,2)` e consulta no segundo 1; retornar apenas
  o segundo intervalo. Rejeitar fim > duração e IDs de fonte inventados.

```ts
expect(visualAt([
  { id:"a:0", sourceId:"a", start:0, end:1, text:"mesa", confidence:"observed", tags:[] },
  { id:"a:1", sourceId:"a", start:1, end:2, text:"mão", confidence:"observed", tags:[] },
], 1).map(s => s.id)).toEqual(["a:1"]);
```

- [ ] Fazer proxy por arquivo sem deformar proporção; aproveitar Executor e
  FFmpeg, escalando dentro de 480×480, inicialmente 1 fps. Dividir em janelas
  de 20 s com contexto de 1 s nas bordas. IDs e tempos locais são fornecidos
  pelo app; converter para origem e descartar duplicatas de sobreposição.
- [ ] Prompt novo pede descrição por segundo, ações, objetos, enquadramento e
  incerteza em JSON, somente sobre a mídia recebida. Não identificar pessoas
  nominalmente sem informação fornecida. Agrupar intervalos adjacentes somente
  quando a descrição observada continua válida; conservar observações originais.
- [ ] Usar cliente compartilhado com cancelamento e cache por janela. Parar
  chamadas subsequentes ao cancelar; resultado parcial fica identificado.
  Não chamar structure/inspect com prompt visual disfarçado.
- [ ] Antes do teste live, apresentar arquivo, janelas, modelo e limite de
  chamadas/tokens. Com autorização, verificar amostra conhecida: mudança de
  objeto, ação curta, início/fim de janela, fala fora de quadro. Se 1 fps não
  capturar ações relevantes, propor densidade maior nos trechos problemáticos.
  Não declarar compreensão “de todos os frames”.
- [ ] Testes visual/model/triage verdes; registrar qualidade e limites da prova.
  Sem prova live, marcar capacidade como não validada e avançar só com fixtures.
  Commit: `feat: index visual context by source time`.

## Tarefa 7 — propor cenas a partir de roteiro ou briefing

**Files:** criar `assembly/scenes.ts`, `scenes.test.ts`; estender `model.ts` e teste.

**Interfaces:** `proposeScenes(project: Project, request: string,
signal: AbortSignal): Promise<Proposal>`; `validateProposal(raw: unknown,
project: Project): Proposal`; `compileScenes(project: Project, scenes: Scene[]): Assembly`.

- [ ] Testar proposta com ID inexistente e fala fabricada; seleção é por IDs,
  texto exibido sempre vem da transcrição, nunca da resposta livre do modelo.

```ts
const raw = { id:"p1", baseRevision:p.revision, changedSceneIds:["s1"],
  explanation:"abertura", scenes:[{ id:"s1", objective:"abrir", rationale:"tema",
    speechIds:["inexistente"], support:[], gaps:[] }] };
expect(() => validateProposal(raw, p)).toThrow(/referência/);
```

- [ ] Rodar teste; enviar input.kind/text/targetSeconds, catálogo de falas e
  intervalos visuais ao modelo. Instruir sequência fiel ao roteiro ou narrativa
  baseada no briefing; lacunas explícitas. Retornar apenas contrato Proposal.
  Validar tamanho do catálogo antes de enviar; se exceder orçamento, avisar e
  dividir a seleção por arquivos com resumo rastreável, sem truncar em silêncio.
- [ ] `compileScenes` resolve IDs, soma durações das falas e coloca apoio em
  offsets relativos à cena. Quantizar fronteiras uma vez para frames da saída:

```ts
const fps = p.assembly.fps.num / p.assembly.fps.den;
const inFrame = Math.round(span.start * fps);
const outFrame = Math.round(span.end * fps);
const durationFrames = outFrame - inFrame;
// sourceStartSeconds = inFrame / fps; duração >0 e limites validados.
```

  Compilar vídeo e áudio da mesma fala a partir dos mesmos frames. Não repetir
  nem esticar apoio para ocupar espaço; suporte curto vira lacuna. Preservar
  áudio sem vídeo; exigir cobertura visual ou indicar lacuna.
- [ ] Testar roteiro com trecho ausente, briefing com ordem diferente, duração
  inviável e imagens menores que a cobertura pedida; gaps são visíveis e não
  somem para a montagem parecer completa. Testar múltiplos trechos na mesma cena.
- [ ] Rodar scenes/model/validate e typecheck; commit:
  `feat: propose traceable scenes from scripts and briefs`.

## Tarefa 8 — revisões e aprovações editoriais

**Files:** estender `store.ts` e `store.test.ts`; criar `revisions.ts`, `revisions.test.ts`.

**Interfaces:** `applyProposal(p: Project, proposal: Proposal): Project`;
`approveStructure(p: Project): Project`; `recordPreview(p: Project, revision: number): Project`;
`approveFinal(p: Project): Project`. Todas puras; store executa persistência.

- [ ] Testar proposta obsoleta e resultado de render atrasado:

```ts
expect(() => applyProposal(p, {...proposal, baseRevision:p.revision-1}))
  .toThrow(/revisão/);
expect(recordPreview(p, p.revision-1).previewRevision).toBe(p.previewRevision);
expect(() => approveFinal({...p, previewRevision:null})).toThrow(/prévia/);
```

- [ ] Implementar alteração aceita com revision+1; assembly recebe a mesma
  revisão; invalidar aprovações/prévia. Aprovar ou registrar prévia não muda
  revisão editorial. Store suporta atualização de estado na mesma revisão sob
  lock, rejeitando qualquer modificação editorial sem incremento. A comparação
  do store inclui input, fontes, cenas e conteúdo da montagem; atualizar somente
  análise/progresso/aprovações não inventa revisão editorial nova. Resultados de
  análise são mesclados por chave de fonte em estado recém-lido sob lock, não
  gravando um snapshot antigo do projeto sobre escolhas feitas enquanto rodavam.
- [ ] Comparar cenas propostas com atuais; altered IDs efetivos devem coincidir
  com changedSceneIds. Pedidos locais não podem reescrever cenas fora do escopo
  silenciosamente. Alteração de ordem deve constar no diff mostrado.
- [ ] Mudança local após estrutura aprovada pede nova aprovação da estrutura
  alterada antes de render; não exigir reanálise das fontes. Aprovação final
  exige estrutura e prévia atuais e nenhuma lacuna não resolvida.
- [ ] Testar rejeitar proposta sem mudança, reordenar, trocar tomada, trocar
  apoio e proposta fora do escopo. Commit após testes e typecheck:
  `feat: enforce editorial revision approvals`.

## Tarefa 9 — conectar o fluxo ao app

**Files:** criar `assembly/routes.ts`, `routes.test.ts`, `assembly/page.html`;
alterar `app/server.ts`, `apps/cli/src/index.ts`; criar `assembly/select.ts` e
teste para cancelar/selecionar paths sem interpolação de shell.

**Interfaces:** `startApp` passa a aceitar união `{input:string}` ou
`{projectDir:string, inputs?:string[]}`, preservando os campos comuns atuais.
`handleAssembly(req: IncomingMessage, res: ServerResponse, dir: string): Promise<boolean>`
retorna false para rota não atendida. Reusar `serveMedia` e `originAllowed`.

- [ ] Testar GET do projeto e POST com baseRevision antiga retornando 409,
  sem alterar arquivo. Testar Origin rejeitada, body inválido/maior que 1 MiB,
  sourceId ausente e tentativa de path arbitrário em rota de mídia.
- [ ] Implementar somente estas rotas sob `/project`:

| Método/path | Entrada | Efeito |
|---|---|---|
| GET `/project` | — | Project e operação ativa (etapa, fonte, progresso, erro) |
| POST `/project/select` | baseRevision | Seletor local, fontes adicionadas após escolha |
| POST `/project/input` | baseRevision, kind, text, targetSeconds | Atualizar briefing/roteiro |
| POST `/project/settings` | baseRevision, fps, width, height | Confirmar quadro/fps; invalidar prévia e aprovações |
| POST `/project/source-role` | baseRevision, sourceId, role | Corrigir classificação sem reanalisar mídia |
| POST `/project/relink` | baseRevision, sourceId | Seletor local; aceitar somente arquivo com mesmo hash |
| POST `/project/analyze` | sourceIds | Iniciar/retomar análises autorizadas |
| POST `/project/propose` | baseRevision, request | Salvar proposta sem aplicar |
| POST `/project/apply` | baseRevision, proposalId | Aplicar proposta revisada |
| POST `/project/approve-structure` | baseRevision | Aprovar cenas |
| POST `/project/preview` | baseRevision | Renderizar revisão aprovada |
| POST `/project/approve-final` | baseRevision | Aprovar prévia atual |
| POST `/project/export` | baseRevision | Entrega da revisão final |
| POST `/project/cancel` | — | Cancelar operação ativa |
| GET `/project/media/:sourceId` | — | Somente fonte cadastrada |
| GET `/project/output/:revision/:kind` | kind otio/mp4 | Somente saída registrada |

- [ ] Mostrar quatro etapas na mesma interface: arquivos/briefing, análise,
  cenas e prévia/entrega. Estado por arquivo com retry; editor de roteiro ou
  briefing; consulta temporal e resultados clicáveis; cards de cenas com
  motivo/lacuna; seleção alternativa; controles de ordem e duração; diff de
  proposta; dois botões de aprovação em momentos distintos.
- [ ] Cada execução tem um AbortController e Executor próprios. Cancelar
  sinaliza o modelo e encerra o grupo de processos via killAll existente;
  resultado atrasado não muda estado cancelado nem revisão nova. A fila de
  mutações do projeto serializa somente commits de estado, não mantém lock
  de arquivo aberto durante transcrição ou chamadas de rede.
- [ ] Pedidos naturais passam por `/propose`; ajustes manuais também geram
  Proposal local com diff antes de `/apply`. Nunca inserir texto do modelo
  como HTML. Usar textContent, labels, foco visível e botões por teclado.

```js
const response = await fetch('/project/apply', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({baseRevision:project.revision, proposalId:proposal.id})
});
if (response.status === 409) {
  status.textContent = 'O projeto mudou. Atualize a proposta antes de aplicar.';
}
```

- [ ] Seletor via execFile('osascript', ['-e', SCRIPT_CONSTANTE]), script
  constante que retorna JSON de paths; tratar cancelamento separado de falha.
  Realpath/stat antes de registrar, sem enviar mídia a terceiros nessa ação.
- [ ] Testar fluxo HTTP com modelo e Executor injetados. Conferir interface
  real com fixtures: dois arquivos, busca por segundo, proposta, aprovação,
  mudança e prévia desatualizada. Reabrir e confirmar persistência.
- [ ] Rodar routes/revisions e testes atuais de app/server; typecheck. Commit:
  `feat: add multi-source assembly workflow to local app`.

## Tarefa 10 — fechar exportação e validar o produto

**Files:** estender routes/render/store e respectivos testes; criar
`tests/assembly-flow.test.ts`; atualizar evidência da tarefa 4 e spec com
estado verificado e limites reais somente após os checks.

**Interfaces:** saída imutável em `exports/<revision>/` com `timeline.otio`,
`reference.mp4`, `manifest.json` contendo revisão e hashes das duas saídas/fontes.

- [ ] Testar que exportação com finalApprovedRevision diferente retorna 409;
  fonte ausente retorna erro nomeando a fonte; nenhuma saída parcial fica
  anunciada como concluída. Recuperação de path exige hash igual ao original.
- [ ] Exportar snapshot aprovado em diretório temporário exclusivo; validar
  ambos os artefatos e fazer rename ao diretório final. Export repetido da
  mesma revisão íntegra reutiliza resultado; corrupção pede nova pasta de
  tentativa, preservando a anterior e sem tocar nos originais.

```ts
if (project.finalApprovedRevision !== project.revision) {
  throw new Error("aprovação final desatualizada");
}
// Capturar snapshot antes do render; nunca ler cenas mutáveis durante export.
const snapshot = structuredClone(project.assembly);
```

- [ ] Teste E2E offline: fixtures de análises → roteiro → proposta → estrutura
  aprovada → render → aprovação final → OTIO/referência; repetir pelo caminho
  briefing. Stub somente modelo; render sintético e filesystem reais.
- [ ] Inspecionar chamadas externas dos testes antes de executar suíte completa;
  não permitir chaves live em testes de modelo. Rodar `pnpm test` e
  `pnpm typecheck` uma vez ao fechar; corrigir apenas regressões desta mudança.
- [ ] Com material real autorizado e lote de análise aprovado, assistir à
  prévia: verificar sentido das falas, utilidade do apoio, junções e qualidade
  das descrições. Importar a entrega no DaVinci e comparar com a referência.
- [ ] Registrar: versão Resolve, fontes/hash, revisão, resultado dos testes,
  importação, qualidade editorial, limites e aprovação humana. Teste técnico
  não substitui aprovação visual/editorial. Não publicar nem fazer deploy.
- [ ] Commit final com allowlist dos arquivos realmente alterados, sem mídia
  de cliente. Relatório de fechamento separa local, live, DaVinci e aceite.

## Revisão deste plano

| Requisito da spec | Cobertura |
|---|---|
| Roteiro ou briefing, vários arquivos | 5, 7, 9 |
| Contexto por segundo e trechos úteis | 6, 9 |
| Proveniência e lacunas | 1, 6, 7 |
| Revisão de cenas e ajustes naturais | 7, 8, 9 |
| Reuso de análises e retomada | 5, 6 |
| Prévia e escolhas preservadas | 3, 8, 9 |
| Mesma revisão nas duas entregas | 8, 10 |
| Importação real, áudio e fps | 2, 4, 10 |
| Limpeza existente sem regressão | 6, 9, 10 |

Plano revisado quanto à cobertura e dependências. Os snippets são contratos e
núcleos de implementação para orientar as tarefas, não código já implementado.
Nenhum teste do novo fluxo, render ou chamada de IA foi executado durante o
planejamento. Gate de compatibilidade permanece na tarefa 4; gate de qualidade
visual na tarefa 6. A execução só inicia após aceite dos contratos propostos.

## Encaminhamento ao Cursor Projects — 2026-09-11

- Project criado e visto na navegação: **Decupa — montagem multiarquivo para DaVinci**.
- Link: https://cursor.com/agents/bc-251f8c0d-f339-4e63-88f7-ae8b5ff2589d
- Conta exibida: Jhonatan. Workspace escolhido: decupa, correspondente a
  `https://github.com/jhowtkd/decupa.git`.
- Base local: `main`, commit `8b0799b`; spec em `1468f62`. Os dois commits
  constam à frente da referência local `origin/main`; nenhum push foi feito.
- Working tree estava limpo antes deste registro. Esta seção é a única
  alteração local feita para registrar o encaminhamento.
- Modelo/preset preservado: seletor exibe High. Não inferir um modelo específico.
- A ação Create Project iniciou ambiente Cloud automaticamente. O botão Stop
  generation foi acionado antes de enviar instruções; o ambiente terminou com
  status Environment ready. Não houve mensagem de implementação enviada nem
  evidência de execução das tarefas. Consumo da inicialização não foi informado.
- Não foi encontrada seleção de execução local nos controles de Project
  inspecionados. Não substituir Project por sessão CLI alegando equivalência.
- Autorização recebida em 2026-09-11: enviar spec/plano ao coordenador e executar
  no Cloud usando a cota existente, sem excedentes. Os contratos deste plano
  estão incluídos no encaminhamento autorizado. Nenhuma autorização de push,
  nova assinatura, recorrência, produção ou análise paga de mídia foi concedida.
- Os dois documentos integrais foram anexados pela opção Files e aparecem na
  mensagem enviada. Briefing e confirmação de execução foram enviados ao
  coordenador; a UI passou a Working / Planning next moves.
- Próximo passo: confirmar leitura e início da entrega A, acompanhar o mesmo
  coordenador e revisar suas evidências. Envio não equivale a implementação.
- Leitura integral confirmada nos logs: spec L1–192 e plano L1–711. Coordenador
  confirmou base Cloud `35042e7`, branch `codex/montagem-multiarquivo` e commit
  dos documentos `b131513`. FFmpeg/Node/pnpm/Python disponíveis; motor e DaVinci
  ausentes. Worker same_vm não habilitado; houve despacho Couldn't start, e o
  coordenador informou continuação no próprio VM com um autor por vez.

### Briefing preparado para o coordenador

Objetivo: implementar o fluxo Decupa de vários arquivos de fala e apoio,
orientado por roteiro ou briefing, com aprovação das cenas e da prévia, até
entregar timeline editável para DaVinci e vídeo de referência da mesma revisão.

Alvo: jhowtkd/decupa. Contexto local em `/Users/jhonatan/Repos/Video editor`,
base main em 8b0799b. Spec aprovada:
`docs/superpowers/specs/2026-09-11-montagem-multiarquivo-design.md`.
Plano de dez tarefas:
`docs/superpowers/plans/2026-09-11-montagem-multiarquivo.md`.
Esses documentos serão fornecidos integralmente se não estiverem na base cloud;
não fingir tê-los lido só porque os paths constam aqui.

Cursor investiga, implementa, testa e corrige; Codex revisa marcos e fechamento.
Reutilize o núcleo editorial e o compositor multipista existente. Comece pelas
tarefas 1–4 (montagem e intercâmbio), depois 5–6 (análise) e 7–10 (fluxo completo).
Leia os chamadores e confirme os contratos antes de editar. Um autor por vez;
revisores devolvem achados ao autor. Use branch codex/montagem-multiarquivo,
preserve trabalho existente e não faça merge nem push sem autorização.

Critérios: origem rastreável, ausência de falas inventadas, lacunas visíveis,
retomada por arquivo, escolhas aprovadas preservadas, referência e timeline
equivalentes. Execute os testes pertinentes do plano e pnpm typecheck. O
DaVinci 21.0.4 e o clone local do motor estão no Mac e não devem ser presumidos
na máquina cloud. Declare dependências ausentes; não instale nem substitua
ferramentas silenciosamente. Importação real e aceite editorial continuam sendo
marcos obrigatórios, sem confundir testes de JSON com integração validada.

Restrições: nenhum acesso a produção, publicação, merge/deploy, recorrência,
nova assinatura ou excedente pago. Chamadas de análise de mídia à Z.ai exigem
lote e custo autorizados separadamente; desenvolver e testar offline primeiro.
Não enviar mídia de cliente nem credenciais. Não adicionar dependências ou
outro formato/motor como fallback automático. Pare em limite de consumo ou
decisão necessária, completando o restante independente autorizado.

Retorne marcos concluídos/restantes, diff e commits, comandos/resultados de
testes, evidências de QA e bloqueios. Mantenha este contexto conciso e atual.

### Revisão local da entrega A — 2026-09-11

- Patch Cloud `6322032214a74d898701c2fa98add7fa7a314e8e` copiado para
  `/private/tmp/decupa-entrega-a.patch`; SHA256 local
  `5bd210597ad8d330a0903621da4d8af266b80b33950fa87ade383ce336d525a4`.
  Manifesto Cloud confirma 11 arquivos/937 inserções; não contém checksum.
- `git apply --check` passou. Aplicado somente no clone isolado
  `/private/tmp/decupa-assembly-review-20260911`, branch `codex/assembly-review`.
  Dependências existentes restauradas com `pnpm install --frozen-lockfile`.
- Prova REAL com `VE_PLUGIN_ROOT` no motor local d9fe300: exit 2.
  Relatório: `work/assembly-proof/run-mM71Hc/report.json` no clone isolado.
  Validador do motor exige `project` não vazio, `assets[]` não vazio e
  `reason` nos três clipes. Adaptador não fornece esses campos.
  Wrapper imprime só result.text e oculta os diagnósticos em result.data.
- Achados enviados e reconhecidos pelo mesmo coordenador. Também solicitada
  prova fracionária renderizada, dimensões reais, timecode não zero, caminhos
  absolutos e proteção de render concorrente por revisão. Entrega A recusada.
- DaVinci 21.0.4: projeto isolado `New Project 2Decupa prova 2026-09-11`.
  Importação do OTIO realizada pela UI; mídias online, V1/V2/A1 visíveis e 2s.
  Com Automatically set project settings, resultado manteve 24fps/1920x1080,
  diferente de 25fps/320x240 da montagem. Gate A continua aberto.
  API externa `scriptapp("Resolve")` retornou None; nenhuma configuração global
  alterada. Não há MP4 correspondente para comparação, pois render falhou.
- Próximo passo: receber patch cumulativo corrigido e logs do Cursor, repetir
  render real, provar frames/canvas no DaVinci e revisar entregas B/C.
  Nenhum push, merge, publicação ou chamada de análise paga realizado no Mac.
- Roundtrip exportado pela UI para `/private/tmp/decupa-davinci-roundtrip.otio`:
  global_start_time 86400@24, V1/A1 48@24 e V2 gap 24@24 + clipe 24@24.
  Confirma conversão de frames na importação automática da primeira entrega.
  API externa também retornou None fora do sandbox (consulta somente leitura).

### Patch cumulativo disponível; transferência bloqueada

- Último HEAD informado: `0d05535`; patch Cloud em
  `/opt/cursor/artifacts/entrega_cumulativa_implementation.bin.patch`, SHA256
  `6e781cf8d5babf6d13f756368fc18d6dcb7ead1b8708d1be689507cc4a9b44ff`.
- Log aberto na UI e conferido visualmente: 12 arquivos de teste, 69 testes
  aprovados, typecheck sem erros; data 2026-09-11T09:30:38Z, HEAD 0d05535.
  Não equivale a render real nem teste no DaVinci.
- Coordenador relata correções: project/assets/reason no contrato do motor;
  muted:true nos clipes de vídeo; wrapper rejeita data.status=fail;
  OTIO global_start_time no fps correto e instruções de importação explícitas.
  Essas correções ainda não foram revisadas localmente.
- A transferência da revisão cumulativa falhou: TextEdit apresentou
  ScreenCaptureKit -3811 e timeouts de colagem; reset da sessão de UI e
  reabertura do arquivo não resolveram. Alternativa pelo navegador foi
  recusada pela política de URL; não houve tentativa de contornar a recusa.
- `/private/tmp/decupa-cumulative-review.patch` foi criado vazio, não é patch
  válido. O patch inicial e os relatórios permanecem intactos.
- Solicitado ao usuário salvar o patch cumulativo no Mac e informar o caminho.
  Solicitada ao coordenador reconciliação das dez tarefas e conclusão do
  trabalho offline independente de B/C, antes de parar por gates reais.
- Último estado vivo do coordenador: reconheceu reconciliação pendente e
  informou continuação de UI, revisão de propostas, exportação e regressão da
  limpeza; UI mostra Working / Planning next moves. Não há evidência de
  conclusão das dez tarefas. Retomar este mesmo Project após transferência.

### Patch 7056a25 recebido e revisão local

- Usuário salvou `/Users/jhonatan/Downloads/entrega_cumulativa_implementation.bin.patch`.
  SHA256 conferido: `390780ad250f154a6979030cd93af61f952945175a180af772d0484894013757`.
  Aplicado limpo no clone `/private/tmp/decupa-assembly-review-20260911`,
  após reverter somente o patch anterior aplicado por esta revisão.
- Motor existente preservado. Prova real exit 0: `run-ifXoN5`, 320x240,
  25fps, 50 frames, vídeo/áudio 2s; frame24 vermelho, frame25 azul.
- Prova `run-frac-AqJnLC`, 30000/1001: 50 frames, áudio/vídeo 1.668333s;
  BUG: apoio entra no frame26 em vez do frame25. Devolvido ao autor.
- DaVinci, novo projeto isolado `New Project 2`: reconheceu automaticamente
  25fps; canvas ajustado manualmente a 320x240 no import. Roundtrip em
  `/private/tmp/decupa-davinci-roundtrip-7056a25.otio` confirma V1/A1 50@25,
  V2 gap25@25 + clip25@25. Não comprova canvas automático nem aceite editorial.
- Revisão rejeitou conclusão das tarefas9/10: falta player/download, conexão
  real configurável dos providers, edição e consulta visual completas,
  persistência incremental de análise e verificação do hash na exportação.
  Autor reconheceu e está corrigindo no mesmo Project, sem chamadas pagas.
- Concorrência reproduzida com saveProject: snapshot antigo da mesma revisão
  apaga aprovação recém-gravada. Encaminhado com risco de duas prévias
  escreverem no mesmo arquivo. Também enviado: describeClient ignora
  body.visual=false, podendo chamar provider ao pedir só transcrição.
- Próximo passo: receber patch consolidado, repetir provas e revisar UI e
  concorrência. Sem push, deploy ou análise paga; produto ainda não concluído.

### Validação real Feira e correção de proposta

- Patch e4e68443 aplicado em /private/tmp/decupa-review-e4e68443. 63 testes
  focados e typecheck passaram. Prova NTSC ainda entra azul no frame26.
- Projeto real /private/tmp/decupa-feira-e4e68443, duas fontes Videos Feira,
  http://127.0.0.1:7801. Ambas análises prontas; WhisperX teve crash nativo
  intermitente recursive_mutex. Retomar concluiu e preservou a outra fonte.
- Usuário autorizou uso contínuo de LLM para seu app. Servidor reiniciado
  com --allow-paid-model. Revisão automática recusou ativação conjunta visual;
  apenas texto foi habilitado via alternativa restrita aprovada.
- Resposta real Z.ai rejeitada pelo app: proposta com revisão desatualizada,
  projeto revisão3 estável. scenes.ts não define schema Proposal no prompt.
- Mesmo Cursor Project recebeu correção delimitada: schema explícito,
  metadados vinculados ao snapshot pelo servidor, manter CAS e validação,
  testes de metadados omitidos/inventados e stale real, UI de andamento.
  Solicitado patch incremental sobre 081c4f5 inline para aplicação no Mac.

- Correção de proposta concluída no Mac: transferência do patch Cursor 8f4c1f8
  falhou na UI (ScreenCaptureKit3812); autoria pontual assumida explicitamente
  por Codex na cópia /private/tmp/decupa-review-e4e68443. Alterados scenes.ts,
  scenes.test.ts e page.html: schema explícito, snapshot clonado, UUID/revisão
  do servidor, proteção de referências e feedback/duplicação na UI. Não é
  aplicação do patch remoto; reconciliar com Cursor antes de integrar.
- 67 testes assembly/flow passaram, typecheck e diffcheck limpos. Chamada real
  Z.ai validada: proposta registrada e visível, cinco cenas, cerca de48s,
  revisão3 do projeto Feira. Não aplicada nem aprovada editorialmente.

### Redesign e fluxo automático — direção escolhida

- Usuário confirmou preparação automática até proposta e prévia reproduzível,
  além de correção da transcrição e edição de cortes por palavras.
- Após comparar três protótipos, escolheu A — Texto + vídeo, pelo chat (“a”).
- Desenho consolidado para revisão em
  `docs/superpowers/specs/2026-09-11-fluxo-automatico-edicao-textual-design.md`.
  Não representa aprovação da implementação nem aplicação no app.
- Referências reais pesquisadas no catálogo Builder do 21st.dev; nenhum
  componente instalado, migração de framework ou geração paga de UI realizada.
- Protótipo ilustrativo preservado em
  `.superpowers/brainstorm/24976-1789133742/content/layouts-feira-v3.html`.
- Usuário aprovou o desenho completo (“aprovo”). Plano de implementação
  detalhado em `docs/superpowers/plans/2026-09-11-fluxo-automatico-edicao-textual.md`:
  dez tarefas, contratos internos, migração, testes e QA real. Preparado para
  o mesmo executor Cursor; não foi despachada implementação nesta etapa.
- Inspeção para o plano confirmou perda de granularidade em analysis.ts
  (lê speech_index sem preservar transcript.words) e envio do proxy inteiro
  por janela em model.ts, seguido de deslocamento temporal. Correções
  incluídas no plano; não aplicadas ao runtime durante o planejamento.
- Usuário escolheu executar com outro agente. Handoff completo preparado em
  `docs/superpowers/plans/2026-09-11-decupa-handoff-executor.md`, com dez passos,
  gates G0–G7, requisitos R-001–R-014 e prompt para review independente.
- Pacote local `work/handoffs/decupa-execucao-2026-09-11.zip`, SHA256
  `200d1bf20c36708f299af4b8048500173e1e678064e70484e892d0e29c6ab4a3`.
  Inclui docs, referência A portátil e patch de40arquivos extraído da cópia
  atual, baseado em8b0799b. Patch novo SHA256
  `860a99f7f080f2c3c1a847454f9f903ddcb7ec435878f4b4db1b368cce0d051b`.
  Apply-check no principal e reverse-check na cópia passaram; SHA256SUMS e
  integridade ZIP conferidos. Nenhum patch aplicado, teste funcional rerodado
  ou agente de implementação iniciado para preparar este handoff.

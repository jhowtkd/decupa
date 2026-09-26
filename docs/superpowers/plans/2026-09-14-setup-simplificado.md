# Decupa Setup Simplificado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar o Decupa com `node scripts/setup.mjs` e abrir com `node scripts/start.mjs` em macOS e Windows, mantendo a interface e o servidor existentes.

**Architecture:** Scripts Node sem dependências de aplicação preparam runtimes locais e iniciam o CLI. O executor existente concentra a resolução do Python e o encerramento por plataforma; não haverá servidor paralelo, shell desktop ou daemon novo. Setup é repetível por inspeção do estado existente, sem reset forçado e sem manifesto de instalação.

**Tech Stack:** Node stdlib, TypeScript, pnpm 10.32.1, uv, Python 3.11/3.12, FFmpeg e Vitest já instalado.

**Spec:** `docs/superpowers/specs/2026-09-14-setup-simplificado.md`

## Global Constraints

- Plataformas de aceite: macOS arm64 e Windows x64 nativo; outras arquiteturas não são declaradas homologadas.
- Node >=22.6; pnpm 10.32.1; fala Python 3.11; visão Python 3.12; motor Python 3.11.
- Nenhuma dependência nova de aplicação; Node stdlib, uv, FFmpeg e testes Vitest existentes.
- Git, Node, uv e FFmpeg/ffprobe são pré-requisitos do sistema; o setup não instala ferramentas globais nem exige administrador.
- Setup instala pnpm 10.32.1 localmente com npm, sem substituir o pnpm global.
- Mensagens ao usuário em PT-BR; caminhos absolutos e com espaços devem funcionar.
- Sem chamadas pagas, credenciais em logs, serviço no boot, atualização automática, push ou publicação.
- Preservar projetos, mídias, credenciais, configurações globais e alterações locais do motor.
- Não alterar API HTTP, formato dos projetos, protocolo MCP nem política de retenção.

---

## Contexto verificado e fronteira

Base inspecionada: `133331a`. Há três planos de inspiração não rastreados e dois guias em `docs/setup/`: preservá-los; somente os dois guias pertencem à atualização documental deste plano. Este documento autoriza planejamento, não execução. Ao executar, usar worktree pela skill using-git-worktrees e conferir novamente o HEAD.

Pontos reais: `index.ts` abre com `open` sem handler de erro; `SpawnExecutor` usa grupos POSIX; `runIngest` cria subprocesso pnpm; quatro comandos Python passam por SpawnExecutor. `setup-engine.sh` usa checkout forçado; doctor só confere uv/arquivo, não imports. Os locks dos sidecars já existem. O MCP usa Content-Length e permanece fora do escopo.

**Limite deliberado:** quem prepara a máquina ainda instala Git/Node/uv/FFmpeg. O comando único substitui a configuração manual dos ambientes, motor, pacote JS e PATH. Um instalador que distribua também esses pré-requisitos será outro projeto.

## Mapa dos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `scripts/setup.mjs` (novo) | Preflight, execução sequencial de instalação, proteção do motor e diagnóstico final |
| `scripts/start.mjs` (novo) | Tradução project/input para CLI, ambiente local e lifecycle do filho |
| `scripts/setup.test.ts`, `scripts/start.test.ts` (novos) | Contratos dos scripts sem downloads |
| `apps/cli/src/runtime.ts` e `runtime.test.ts` (novos) | Python do motor, abertura segura do navegador e encerramento de árvores |
| `apps/cli/src/app/pipeline.ts` + testes existentes | Consumir runtime e retirar subprocesso pnpm |
| `apps/cli/src/index.ts` | Browser helper e flag doctor --local |
| `apps/cli/src/doctor.ts` + `doctor.test.ts` | Diagnóstico local efetivo |
| `package.json` | Corrigir mínimo Node para 22.6 |
| `tests/fixtures/global-setup.ts` | Remover geração não consumida de fala via say |
| `.github/workflows/ci.yml` | Windows/macOS na suíte existente |
| `scripts/setup-engine.sh` | Delegar instalação do motor ao mesmo código seguro do setup |
| `docs/setup/GUIA.md`, `docs/setup/PROMPT-AGENTE.md` | Fluxo simplificado e limites explícitos |
| `docs/superpowers/evidence/2026-09-14-setup-simplificado.md` (novo) | Evidência de duas máquinas, sem segredos |

Ordem: 1 → 2 → 3 → 4 → 5 → 6. Uma pessoa/agente escrevendo por vez. Nenhum pacote novo na workspace.

### Task 1: Runtime portátil e cancelamento

**Files:** Create `apps/cli/src/runtime.ts`, `apps/cli/src/runtime.test.ts`; Modify `apps/cli/src/app/pipeline.ts`, `apps/cli/src/app/pipeline.test.ts`, `apps/cli/src/app/assembly/preparation.test.ts`, `apps/cli/src/index.ts`, `package.json`.

**Interfaces:**
- Consumes: `ExecCall`, `ExecResult` e `SpawnExecutor` existentes.
- Produces: `enginePython(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string`; `browserCommand(url: string, platform?: NodeJS.Platform): {command:string;args:string[]} | null`; `openBrowser(url:string): void`; `terminateTree(pid:number, platform?:NodeJS.Platform): void`.
- `DECUPA_ENGINE_PYTHON` é override de ambiente do processo; não altera formato persistido.

- [ ] **Step 1: Escrever teste que falha** em runtime.test.ts:

```ts
import { expect, it } from 'vitest';
import { browserCommand, enginePython } from './runtime.ts';
it('usa Python explícito e preserva caminhos com espaços', () => {
  expect(enginePython({ DECUPA_ENGINE_PYTHON: 'C:\\Decupa App\\python.exe' }, 'win32'))
    .toBe('C:\\Decupa App\\python.exe');
});
it('Windows abre URL loopback sem interpolação em shell', () => {
  expect(browserCommand('http://127.0.0.1:7788', 'win32')).toEqual({
    command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:7788'],
  });
  expect(browserCommand('https://example.com', 'win32')).toBeNull();
});
```

- [ ] **Step 2:** `pnpm exec vitest run apps/cli/src/runtime.test.ts`; esperar falha por módulo ausente.

- [ ] **Step 3: Implementar runtime.ts**, importando `spawn` de child_process:

```ts
export function enginePython(env = process.env, platform = process.platform): string {
  return env.DECUPA_ENGINE_PYTHON || (platform === 'win32' ? 'python' : 'python3');
}
export function browserCommand(url: string, platform = process.platform) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(url)) return null;
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}
export function openBrowser(url: string): void {
  const call = browserCommand(url);
  if (!call) return;
  const child = spawn(call.command, call.args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`Abra manualmente: ${url}`));
  child.unref();
}
export function terminateTree(pid: number, platform = process.platform): void {
  if (platform === 'win32') {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    child.on('error', () => { try { process.kill(pid); } catch {} });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
```

Não usar `shell:true`, `taskkill /IM` ou comando de usuário concatenado. O taskkill atua somente no PID criado e ainda vivo deste executor.

- [ ] **Step 4: Ligar todos os chamadores reais.** No executor, antes de spawn:

```ts
const command = call.command === 'python3' ? enginePython() : call.command;
// spawn(command, call.args, ...), com detached: process.platform !== 'win32'
```

No killAll, trocar kill de grupo + child.kill por `if (child.pid) terminateTree(child.pid)`, preservando running.clear(). No runIngest trocar a chamada pnpm por:

```ts
command: process.execPath,
args: ['--experimental-strip-types', join(REPO_ROOT, 'apps/cli/src/index.ts'),
  'condense-prep', '--input', job.videoPath, '--out', transcriptPath(job)],
```

Nos dois branches limpar/montar de index.ts, usar `openBrowser(url)` em vez de spawn(open); retirar import spawn quando ficar sem consumidor. Atualizar o mínimo engines.node para `>=22.6`. Ajustar somente asserts dos testes que esperavam pnpm; `preparation.test.ts` já detecta condense-prep em args.

- [ ] **Step 5: Testar lifecycle de verdade.** Adicionar ao teste do executor um filho Node com `setInterval`, chamar killAll e esperar que `run` resolva com code !=0 em até 5 segundos. Usar o mesmo teste nas duas plataformas; mocks de plataforma não bastam para comprovar cancelamento. Acrescentar mock de spawn emitindo `error` para openBrowser e comprovar que não lança erro não tratado.

```ts
it('encerra processo iniciado pelo executor', async () => {
  const exec = new SpawnExecutor();
  const pending = exec.run({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  exec.killAll();
  expect((await pending).code).not.toBe(0);
}, 5000);
```

Importar `SpawnExecutor` de `./app/pipeline.ts` em runtime.test.ts. A criação de spawn é síncrona, portanto killAll vê o processo antes da primeira espera.

- [ ] **Step 6:** rodar `pnpm exec vitest run apps/cli/src/runtime.test.ts apps/cli/src/app/pipeline.test.ts apps/cli/src/app/assembly/preparation.test.ts` e `pnpm typecheck`; corrigir apenas regressões. Commit com allowlist desses arquivos e mensagem `fix: make Decupa subprocesses portable`.

### Task 2: Doctor local comprova dependências sem exigir IA

**Files:** Modify `apps/cli/src/doctor.ts`, `apps/cli/src/doctor.test.ts`, `apps/cli/src/index.ts`.

**Interfaces:**
- Consumes: `enginePython()` da Task 1; DoctorDeps.run existente.
- Produces: `DoctorDeps.localOnly?: boolean`; `pnpm decupa doctor --local` (exit 0 quando apenas provedor faltar).
- `runDoctor()` sem opção mantém relatório completo; o MCP não muda.

- [ ] **Step 1: Teste vermelho** usando fakeRun já definido em doctor.test.ts:

```ts
it('doctor local dispensa provedor, mas executa imports', async () => {
  const calls: string[][] = [];
  const lines = await runDoctor({ localOnly: true, env: {}, run: async (command, args) => {
    calls.push([command, ...args]); return { code: 0 };
  }});
  expect(lines.some(line => line.name === 'chave de análise')).toBe(false);
  expect(calls.some(args => args.includes('import whisperx'))).toBe(true);
  expect(calls.some(args => args.includes('import mediapipe'))).toBe(true);
});
```

- [ ] **Step 2:** `pnpm exec vitest run apps/cli/src/doctor.test.ts`; esperar falha nas novas condições.

- [ ] **Step 3: Acrescentar imports verificados**, com caminhos absolutos calculados a partir de SPEECH_SCRIPT, sem cwd global:

```ts
const speechDir = dirname(SPEECH_SCRIPT);
for (const [name, dir, code] of [
  ['pacote de fala', speechDir, 'import whisperx'],
  ['pacote de visão', resolve(speechDir, '../vision'), 'import mediapipe'],
]) {
  const result = await run('uv', ['run', '--no-sync', '--offline', '--project', dir!, 'python', '-c', code!]);
  lines.push({ name: name!, ok: result.code === 0,
    detail: result.code === 0 ? 'import OK' : 'ambiente incompleto',
    ...(result.code === 0 ? {} : { fix: 'execute node scripts/setup.mjs' }) });
}
const python = await run(enginePython(env), ['-c', 'import sys; assert sys.version_info >= (3, 11)']);
lines.push({ name: 'Python do motor', ok: python.code === 0, detail: python.code === 0 ? 'disponível' : 'indisponível' });
```

Importar dirname/resolve; executar checagens após as já existentes. `--no-sync --offline` impede que doctor se transforme em instalador. Manter a checagem do motor/patch existente. Encapsular bloco de provedor e nota ZAI em `if (!deps.localOnly)`. Atualizar teste de versão Node para major >22 ou major==22 e minor>=6. Os fixes de pré-requisito devem apontar ao guia, não recomendar brew no Windows.

- [ ] **Step 4: Parse da flag** no branch doctor de index.ts:

```ts
const { values } = parseArgs({ args: rest, options: { local: { type: 'boolean' } } });
const lines = await runDoctor({ localOnly: values.local === true });
```

Atualizar USAGE e adicionar teste de import que retorna code 1; assert da linha correspondente ok:false. Doctor não valida saldo, modelos baixados nem render.

- [ ] **Step 5:** `pnpm exec vitest run apps/cli/src/doctor.test.ts apps/cli/src/mcp/tools.test.ts` e `pnpm typecheck`. Commit allowlist: `feat: add local readiness diagnostics`.

### Task 3: Setup único e motor preservado

**Files:** Create `scripts/setup.mjs`, `scripts/setup.test.ts`; Modify `scripts/setup-engine.sh`.

**Interfaces:**
- Produces exports `run(command,args,cwd): Promise<void>`, `installEngine(root:string, options?: {pin?:string;remote?:string}): Promise<void>`, `setup(root:string): Promise<void>`.
- `run` usa spawn sem shell e stdout/stderr herdados, rejeita exit não zero/ENOENT com etapa/comando, sem imprimir ambiente.
- `node scripts/setup.mjs --engine-only` permite o wrapper Bash antigo usar a mesma implementação segura.
- Diretórios: `work/setup-tools/node_modules/pnpm/bin/pnpm.cjs`; `work/engine-venv/{bin/python|Scripts/python.exe}`; sidecars em locais existentes.

- [ ] **Step 1: Testes vermelhos** criar um repositório Git temporário local simulando motor existente em commit errado. Não executar downloads:

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('não altera motor existente incompatível', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup space '));
  const engine = join(root, 'work/video-agent-kit-plugin');
  await mkdir(engine, { recursive: true });
  execFileSync('git', ['init', engine]);
  await writeFile(join(engine, 'user.txt'), 'preservar');
  const { installEngine } = await import('./setup.mjs');
  await expect(installEngine(root)).rejects.toThrow(/motor existente/);
  expect(await readFile(join(engine, 'user.txt'), 'utf8')).toBe('preservar');
});
```

- [ ] **Step 2:** `pnpm exec vitest run scripts/setup.test.ts`; falha por módulo ausente. O módulo não pode executar setup ao ser importado.

- [ ] **Step 3: Implementar runner e guard de entrada**, com imports explícitos de Node:

```js
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function run(command, args, cwd) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? ok() : fail(new Error(`${command}: código ${code}`)));
  });
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN = 'd9fe30076c00ce2968d570622dd22ba068337568';
const exists = path => access(path).then(() => true, () => false);
```

- [ ] **Step 4: Implementar installEngine**, sem force/reset/stash:

```js
export async function installEngine(root, { pin = PIN, remote = 'https://github.com/jhowtkd/video-agent-kit-plugin.git' } = {}) {
  const engine = join(root, 'work/video-agent-kit-plugin');
  const patch = join(root, 'scripts/engine/pt-br-lexicon.patch');
  if (await exists(engine)) {
    let head;
    try { head = execFileSync('git', ['-C', engine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch { throw new Error('motor existente não é clone válido; nenhuma alteração feita'); }
    if (head !== pin) throw new Error('motor existente em outra revisão; nenhuma alteração feita');
    const staged = execFileSync('git', ['-C', engine, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    const untracked = execFileSync('git', ['-C', engine, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    if (staged.trim() || untracked.trim()) throw new Error('motor existente modificado; nenhuma alteração feita');
    const actual = execFileSync('git', ['-C', engine, 'diff', '--binary', 'HEAD']);
    if (actual.length) {
      const temp = await mkdtemp(join(tmpdir(), 'decupa-engine-check-'));
      try {
        await run('git', ['clone', '--shared', '--no-checkout', engine, temp], root);
        await run('git', ['-C', temp, 'checkout', '--detach', pin], root);
        await run('git', ['-C', temp, 'apply', patch], root);
        const expected = execFileSync('git', ['-C', temp, 'diff', '--binary', 'HEAD']);
        if (!actual.equals(expected)) throw new Error('motor existente modificado; nenhuma alteração feita');
        return;
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
  } else {
    await mkdir(dirname(engine), { recursive: true });
    // Clone incompleto não ocupa o destino final nem impede uma retomada.
    const temp = await mkdtemp(join(dirname(engine), '.engine-install-'));
    try {
      await run('git', ['clone', remote, temp], root);
      await run('git', ['-C', temp, 'checkout', '--detach', pin], root);
      await run('git', ['-C', temp, 'apply', patch], root);
      await rename(temp, engine);
      return;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  await run('git', ['-C', engine, 'apply', '--check', patch], root);
  await run('git', ['-C', engine, 'apply', patch], root);
}
```

Adicionar `mkdtemp`, `rm`, `rename` aos imports de fs/promises e `tmpdir` de os. Não executar duas instalações simultâneas no mesmo clone. Se rename falhar por destino já criado, preservar o destino e informar a disputa; remover somente o temporário desta execução.

- [ ] **Step 5: Testar instalação/repetição offline** com Git local, acrescentando ao teste:

```ts
it('instala uma vez, repete e preserva alteração posterior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-repeat-'));
  const remote = join(root, 'remote');
  await mkdir(remote);
  const git = (args: string[]) => execFileSync('git', ['-C', remote, ...args], { encoding: 'utf8' });
  git(['init']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
  await writeFile(join(remote, 'lexicon.txt'), 'before\n');
  git(['add', 'lexicon.txt']); git(['commit', '-m', 'fixture']);
  const pin = git(['rev-parse', 'HEAD']).trim();
  await writeFile(join(remote, 'lexicon.txt'), 'after\n');
  const patch = git(['diff']);
  git(['restore', 'lexicon.txt']);
  await mkdir(join(root, 'scripts/engine'), { recursive: true });
  await writeFile(join(root, 'scripts/engine/pt-br-lexicon.patch'), patch);
  const { installEngine } = await import('./setup.mjs');
  await installEngine(root, { pin, remote });
  await installEngine(root, { pin, remote });
  const file = join(root, 'work/video-agent-kit-plugin/lexicon.txt');
  expect(await readFile(file, 'utf8')).toBe('after\n');
  await writeFile(file, 'my edit\n');
  await expect(installEngine(root, { pin, remote })).rejects.toThrow(/modificado/);
  expect(await readFile(file, 'utf8')).toBe('my edit\n');
});
```

- [ ] **Step 6: Implementar `export async function setup(root)` com preflight e instalação sequencial.** Capturar `--version` de git/uv/ffmpeg/ffprobe, acumular faltas e falhar antes de criar ambientes. Validar major/minor de Node; testar `ffmpeg -encoders` contendo libx264 e AAC. Links de resolução no erro: nodejs.org, git-scm.com, docs.astral.sh/uv, ffmpeg.org.

Implementar o preflight antes da sequência de downloads:

```js
const missing = [];
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) missing.push('Node >=22.6: https://nodejs.org/');
for (const [bin, link] of [
  ['git', 'https://git-scm.com/'], ['uv', 'https://docs.astral.sh/uv/'],
  ['ffmpeg', 'https://ffmpeg.org/'], ['ffprobe', 'https://ffmpeg.org/'],
]) {
  try { execFileSync(bin, [bin.startsWith('ff') ? '-version' : '--version'], { stdio: 'pipe' }); }
  catch { missing.push(`${bin}: ${link}`); }
}
try {
  const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) missing.push('FFmpeg com libx264 e AAC');
} catch { /* ffmpeg ausente já é reportado acima */ }
if (missing.length) throw new Error(`Pré-requisitos ausentes:\n${missing.join('\n')}`);
```

Localizar npm CLI sem shell: testar `join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')` no Windows e `resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')` em Unix; usar `realpath(process.execPath)` para resolver instalação vinculada. Se nenhum existir, informar “instale Node com npm” e parar, não baixar script remoto. Resolver `npmCli` dentro de `setup(root)` usando realpath importado de fs/promises:

```js
const nodeDir = dirname(await realpath(process.execPath));
const candidates = [join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
let npmCli;
for (const candidate of candidates) if (await exists(candidate)) { npmCli = candidate; break; }
if (!npmCli) throw new Error('Node sem npm localizável: instale Node com npm; nenhuma ferramenta global foi alterada');
```

Com `npmCli` confirmado, executar:

```js
await run(process.execPath, [npmCli, 'install', '--prefix', join(root, 'work/setup-tools'),
  '--no-audit', '--no-fund', '--no-package-lock', 'pnpm@10.32.1'], root);
const pnpm = join(root, 'work/setup-tools/node_modules/pnpm/bin/pnpm.cjs');
await run(process.execPath, [pnpm, 'install', '--frozen-lockfile'], root);
await installEngine(root);
await run('uv', ['python', 'install', '3.11', '3.12'], root);
await run('uv', ['sync', '--locked', '--python', '3.11'], join(root, 'services/speech'));
await run('uv', ['sync', '--locked', '--python', '3.12'], join(root, 'services/vision'));
const venv = join(root, 'work/engine-venv');
if (!(await exists(venv))) await run('uv', ['venv', '--python', '3.11', venv], root);
const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await run('uv', ['pip', 'install', '--python', python, '-r', join(root, 'work/video-agent-kit-plugin/requirements.txt')], root);
await run('uv', ['pip', 'install', '--python', python, '--no-deps', 'scenedetect>=0.6'], root);
process.env.DECUPA_ENGINE_PYTHON = python;
await run(python, [join(root, 'scripts/condense.py'), '--help'], root);
await run(process.execPath, ['--experimental-strip-types', join(root, 'apps/cli/src/index.ts'), 'doctor', '--local'], root);
console.log('Setup local concluído. Modelos serão baixados no primeiro processamento.');
```

Cada chamada imprime antes o nome curto da etapa, não toda linha de comando/ambiente. Não capturar saída inteira de pip/uv; herdar streams para progresso real. Se venv existente não contém Python válido, falhar explicando o caminho; não apagar automaticamente. A retomada repete sync/install com estado existente.

- [ ] **Step 7: Entrada protegida e wrapper antigo**:

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv.includes('--engine-only') ? installEngine : setup;
  action(ROOT).catch(error => { console.error(error.message); process.exitCode = 1; });
}
```

Substituir setup-engine.sh por resolução REPO_ROOT existente e `exec node "$REPO_ROOT/scripts/setup.mjs" --engine-only`. Remover toda lógica Git duplicada do Bash. Adicionar checagem de argumento desconhecido antes de action.

- [ ] **Step 8:** adicionar teste de falha do runner sem rede:

```ts
it('propaga falha do subprocesso', async () => {
  const { run } = await import('./setup.mjs');
  await expect(run(process.execPath, ['-e', 'process.exit(7)'], process.cwd())).rejects.toThrow(/7/);
});
```

Rodar `pnpm exec vitest run scripts/setup.test.ts` e `pnpm typecheck`. Commit allowlist: `feat: add repeatable local setup`.

### Task 4: Um comando para abrir sem configurar PATH

**Files:** Create `scripts/start.mjs`, `scripts/start.test.ts`.

**Interfaces:** Consumes `DECUPA_ENGINE_PYTHON`/CLI Task 1 e layout Task 3. Produces `startArgs(argv:string[]): string[]`; CLI `node scripts/start.mjs --project PATH` ou `--input PATH`, `--port N` opcional. Não aceitar ambos ou flags pagas.

- [ ] **Step 1: Teste vermelho**:

```ts
import { expect, it } from 'vitest';
import { startArgs } from './start.mjs';
import { resolve } from 'node:path';
it('preserva argumento com espaços sem shell', () => {
  expect(startArgs(['--project', '/tmp/Meu Projeto'])).toEqual(['montar', '--project', resolve('/tmp/Meu Projeto')]);
  expect(() => startArgs(['--project', '/tmp/a', '--input', '/tmp/b'])).toThrow();
  expect(() => startArgs(['--project', '/tmp/a', '--port', '0'])).toThrow();
});
```

- [ ] **Step 2:** `pnpm exec vitest run scripts/start.test.ts`; esperar módulo ausente.

- [ ] **Step 3: Implementar parser com node:util parseArgs**:

```js
export function startArgs(argv) {
  const { values } = parseArgs({ args: argv, options: {
    project: { type: 'string' }, input: { type: 'string' }, port: { type: 'string' },
  }});
  if (Boolean(values.project) === Boolean(values.input)) throw new Error('informe project ou input, exclusivamente');
  const args = values.project ? ['montar', '--project', resolve(values.project)] : ['limpar', '--input', resolve(values.input)];
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('porta inválida');
    args.push('--port', String(port));
  }
  return args;
}
```

- [ ] **Step 4: Entrada** calcular root por import.meta.url e Python em work/engine-venv como Task 3. `access` de Python e node_modules antes de iniciar; falha orienta `node scripts/setup.mjs`. Lançar o CLI pelo próprio Node:

```js
const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'apps/cli/src/index.ts'), ...startArgs(process.argv.slice(2))], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DECUPA_ENGINE_PYTHON: python },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
```

Importar parseArgs/resolve/join/dirname/fileURLToPath/access/spawn. Encapsular inicialização em `async function main()` e proteger import:

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
```

 Não detached aqui: Ctrl+C do console chega ao CLI no grupo foreground; executor é responsável pelos subprocessos. Verificar esse comportamento num console Windows real e ajustar forwarding se o teste mostrar órfão; não declarar encerramento comprovado com teste só de parser.

- [ ] **Step 5:** testes de parser/ausência de runtime; início via subprocesso com projeto temporário, polling de GET /project, término por sinal e porta fechada. Usar porta livre obtida com net.Server em teste, e fetch com AbortSignal.timeout(1000), prazo total de 10s. Não clicar preparação nem chamar provedor. Reutilizar pattern de startApp nos testes existentes para cleanup em finally.

- [ ] **Step 6:** `pnpm exec vitest run scripts/start.test.ts`; commit dos dois arquivos `feat: add one-command Decupa launcher`.

### Task 5: Suíte portátil e matriz Windows

**Files:** Modify `tests/fixtures/global-setup.ts`, `.github/workflows/ci.yml`.

**Interfaces:** Consumes FIXTURES/TRUTH existentes, preserva exports. Produces a mesma suíte básica executável nas duas plataformas, sem fala sintetizada obrigatória.

- [ ] **Step 1:** `rg -n 'speech.wav|speechText|speech.aiff' tests packages apps` e confirmar consumidores. Na base, speech.wav é gerado mas não consumido pelos testes. Remover somente bloco `say`/conversão de speech e `TRUTH.speechText` se continuar sem consumidores. Não substituir fala por tom num teste de alinhamento.

- [ ] **Step 2:** rodar suíte existente em clone limpo de fixtures no Windows; falha anterior deve apontar say, nova execução deve ultrapassar setup. Não apagar fixtures do usuário: usar checkout/worktree de teste.

- [ ] **Step 3: Matriz CI**, preservar checkout/pnpm/setup-node/locks e inserir:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [macos-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

FFmpeg por condição: macOS `brew install ffmpeg`; Windows PowerShell `choco install ffmpeg --no-progress -y`, depois `Add-Content $env:GITHUB_PATH 'C:\ProgramData\chocolatey\bin'`. Não copiar comandos administrativos do CI para o setup do usuário. Node 22.x, pnpm 10.32.1 e mesmas verificações existentes. Configurar variáveis de chaves reais vazias para ambos os jobs. Não baixar WhisperX/modelos no CI básico; testes import do doctor usam deps fake.

- [ ] **Step 4:** `pnpm typecheck` e `pnpm test` nos dois ambientes. Falhas preexistentes específicas de plataforma devem ser diagnosticadas; não desabilitar suítes inteiras para obter verde. Ajustes dentro dos arquivos de runtime/lifecycle/test-fixture deste plano são permitidos; bug de produto além deles exige escopo separado.

- [ ] **Step 5:** commit allowlist `test: run Decupa checks on Windows and macOS`. CI remoto só depois de autorização de push; resultado local não é CI aprovado.

### Task 6: Aceite real, guia e entrega

**Files:** Modify `docs/setup/GUIA.md`, `docs/setup/PROMPT-AGENTE.md`; Create `docs/superpowers/evidence/2026-09-14-setup-simplificado.md`.

**Interfaces:** Consumes os dois comandos finais; produces documentação de instalação e matriz de evidências sem alegar suporte além do que passou.

- [ ] **Step 1:** em cada máquina de aceite, clone separado e caminho com espaços; executar `node scripts/setup.mjs`, repetir e verificar ausência de alterações inesperadas via git status. Simular motor com arquivo untracked no clone de teste: setup deve recusar sem modificar; restaurar somente a fixture criada pelo teste. Registrar log de etapas sem credenciais.

- [ ] **Step 2:** abrir `node scripts/start.mjs --project <pasta-absoluta-nova>`; testar navegador/GET, Ctrl+C, porta ocupada, reabrir. Em seguida usar vídeo PT-BR autorizado para limpeza/ingestão local. Conferir transcrição não vazia e timestamps dentro da duração medida; sem chamada remota. Executar `node --experimental-strip-types scripts/assembly-proof.ts` com DECUPA_ENGINE_PYTHON do ambiente instalado para render/OTIO sintéticos; conferir MP4 com ffprobe e reprodução. Não executar davinci-proof.

- [ ] **Step 3:** atualizar o início do guia com estes comandos:

```bash
node scripts/setup.mjs
node scripts/start.mjs --project "/caminho/absoluto/Meu Projeto"
```

Documentar pré-requisitos restantes, modelos de primeiro uso, duração medida, onde ficam projetos/ambientes, parada, retomada de instalação falha e política de retenção existente. Remover receita manual duplicada do caminho principal, conservando troubleshooting. Atualizar prompt para o agente executar setup/start e relatar etapas, mantendo o aviso MCP e autorização separada para operações pagas.

- [ ] **Step 4:** escrever evidência com colunas `sistema/arquitetura`, `commit`, `Node/uv/FFmpeg/Python`, `setup novo`, `setup repetido`, `motor WIP`, `caminho com espaços`, `fala local`, `MP4`, `Ctrl+C`, `CI`, `limitações`. Preencher somente resultados observados; usar “não executado” com motivo se faltar acesso. Falta de Windows real impede declarar Windows homologado, mas não impede entregar alterações e resultados macOS com pendência explícita.

- [ ] **Step 5:** `git diff --check`, revisão do diff e comparação com o mapa de arquivos. Commit somente dos guias/evidência: `docs: document simplified setup and platform evidence`. Não push/publicação sem autorização.

## Autorrevisão do plano

- Fluxo único e ambientes: Tasks 2–4; pré-requisitos explícitos, sem promessa de máquina zerada.
- Compatibilidade e lifecycle: Task 1 + teste de console Task 6.
- Preservação/reexecução: Task 3; nenhum checkout forçado em motor existente.
- Diagnóstico sem cobrança: Task 2; modelos reais medidos Task 6.
- Portabilidade de testes e CI: Task 5; aprovação remota separada.
- Guias, agente opcional e limites MCP/DaVinci: Task 6.
- Interfaces: enginePython usado por executor/doctor; launcher injeta DECUPA_ENGINE_PYTHON; setup usa doctor --local; não há novo contrato persistido.

## Allowlist dos commits

Executar cada comando somente ao concluir os checks de sua task. Revisar `git diff --cached --stat` antes de cada commit.

```bash
# Task 1
 git add apps/cli/src/runtime.ts apps/cli/src/runtime.test.ts apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts apps/cli/src/app/assembly/preparation.test.ts apps/cli/src/index.ts package.json
 git commit -m "fix: make Decupa subprocesses portable"
# Task 2
 git add apps/cli/src/doctor.ts apps/cli/src/doctor.test.ts apps/cli/src/index.ts
 git commit -m "feat: add local readiness diagnostics"
# Task 3
 git add scripts/setup.mjs scripts/setup.test.ts scripts/setup-engine.sh
 git commit -m "feat: add repeatable local setup"
# Task 4
 git add scripts/start.mjs scripts/start.test.ts
 git commit -m "feat: add one-command Decupa launcher"
# Task 5
 git add tests/fixtures/global-setup.ts .github/workflows/ci.yml
 git commit -m "test: run Decupa checks on Windows and macOS"
# Task 6
 git add docs/setup/GUIA.md docs/setup/PROMPT-AGENTE.md docs/superpowers/evidence/2026-09-14-setup-simplificado.md
 git commit -m "docs: document simplified setup and platform evidence"
```

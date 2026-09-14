// Setup local repetível do Decupa: pré-requisitos, pacote JS, motor de
// condense pinado e ambientes Python. Sem dependências de aplicação e sem
// alterar ferramentas globais. Este módulo não executa nada ao ser importado.
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function run(command, args, cwd) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', error => fail(new Error(`falha ao executar ${command}: ${error.message}`)));
    child.once('exit', code => code === 0 ? ok() : fail(new Error(`${command}: código ${code}`)));
  });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN = 'd9fe30076c00ce2968d570622dd22ba068337568';
const REMOTE = 'https://github.com/jhowtkd/video-agent-kit-plugin.git';
const exists = path => access(path).then(() => true, () => false);

/**
 * Garante o motor em work/video-agent-kit-plugin no commit pinado com o patch
 * PT-BR aplicado. Nunca usa force/reset/stash/checkout forçado: um motor
 * existente incompatível é reportado e preservado intacto.
 */
export async function installEngine(root, { pin = PIN, remote = REMOTE } = {}) {
  const engine = join(root, 'work/video-agent-kit-plugin');
  const patch = join(root, 'scripts/engine/pt-br-lexicon.patch');
  if (await exists(engine)) {
    let head;
    try {
      head = execFileSync('git', ['-C', engine, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      throw new Error('motor existente não é clone válido; nenhuma alteração feita');
    }
    if (head !== pin) throw new Error('motor existente em outra revisão; nenhuma alteração feita');
    const staged = execFileSync('git', ['-C', engine, 'diff', '--cached', '--name-only'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const untracked = execFileSync('git', ['-C', engine, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (staged.trim() || untracked.trim()) throw new Error('motor existente modificado; nenhuma alteração feita');
    const actual = execFileSync('git', ['-C', engine, 'diff', '--binary', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (actual.length) {
      const temp = await mkdtemp(join(tmpdir(), 'decupa-engine-check-'));
      try {
        await run('git', ['clone', '--quiet', '--shared', '--no-checkout', engine, temp], root);
        await run('git', ['-C', temp, 'checkout', '--quiet', '--detach', pin], root);
        await run('git', ['-C', temp, 'apply', patch], root);
        const expected = execFileSync('git', ['-C', temp, 'diff', '--binary', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
        if (!actual.equals(expected)) throw new Error('motor existente modificado; nenhuma alteração feita');
        return;
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  } else {
    await mkdir(dirname(engine), { recursive: true });
    // Clone incompleto não ocupa o destino final nem impede uma retomada.
    const temp = await mkdtemp(join(dirname(engine), '.engine-install-'));
    try {
      await run('git', ['clone', remote, temp], root);
      await run('git', ['-C', temp, 'checkout', '--detach', pin], root);
      await run('git', ['-C', temp, 'apply', patch], root);
      try {
        await rename(temp, engine);
      } catch (error) {
        if (await exists(engine)) {
          throw new Error(`o destino ${engine} já foi criado por outra instalação simultânea; o destino existente foi preservado e somente o temporário desta execução foi removido (${error.message})`);
        }
        throw error;
      }
      return;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  await run('git', ['-C', engine, 'apply', '--check', patch], root);
  await run('git', ['-C', engine, 'apply', patch], root);
}

const step = name => console.log(`\n== ${name} ==`);

/**
 * Localiza o npm-cli.js do Node ativo sem shell e sem baixar nada.
 *
 * Deriva dois diretórios a partir do executável do Node — o realpath (resolve
 * instalações vinculadas, ex.: Homebrew Cellar) e o caminho como dado (ex.:
 * /opt/homebrew/bin) — e procura, nesta ordem, os layouts conhecidos:
 *   1. node_modules/npm/bin/npm-cli.js               (Windows)
 *   2. ../lib/node_modules/npm/bin/npm-cli.js        (Unix nodejs.org / Homebrew global)
 *   3. ../libexec/lib/node_modules/npm/bin/npm-cli.js (Homebrew Cellar)
 * Por fim, tenta o `npm` irmão do binário: se for arquivo/symlink cujo realpath
 * é um `npm-cli.js`, usa esse alvo (nunca um shell script/.cmd).
 *
 * @param {string} [nodeExe] Caminho do executável do Node.
 * @returns {Promise<string|null>} Caminho do npm-cli.js, ou null se não localizado. Não lança.
 */
export async function findNpmCli(nodeExe = process.execPath) {
  const realDir = dirname(await realpath(nodeExe).catch(() => resolve(nodeExe)));
  const givenDir = dirname(resolve(nodeExe));
  const dirs = realDir === givenDir ? [realDir] : [realDir, givenDir];
  for (const dir of dirs) {
    for (const candidate of [
      join(dir, 'node_modules/npm/bin/npm-cli.js'),
      resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'),
      resolve(dir, '../libexec/lib/node_modules/npm/bin/npm-cli.js'),
    ]) if (await exists(candidate)) return candidate;
  }
  for (const dir of dirs) {
    const sibling = join(dir, 'npm');
    if (!(await exists(sibling))) continue;
    const target = await realpath(sibling).catch(() => null);
    if (target && basename(target) === 'npm-cli.js') return target;
  }
  return null;
}

export async function prepareModels(root, execute = run) {
  step('Baixando e verificando modelos locais de fala (Whisper small, VAD e alinhamento PT-BR)');
  await execute('uv', ['run', '--no-sync', 'python', 'transcribe.py', '--prepare-models'], join(root, 'services/speech'));
  step('Baixando e verificando modelos locais de visão (MediaPipe)');
  await execute('uv', ['run', '--no-sync', 'python', 'visual_index.py', '--prepare-models'], join(root, 'services/vision'));
}

export async function setup(root) {
  step('Verificando pré-requisitos');
  const missing = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 6)) missing.push('Node >=22.6: https://nodejs.org/');
  for (const [bin, link] of [
    ['git', 'https://git-scm.com/'], ['uv', 'https://docs.astral.sh/uv/'],
    ['ffmpeg', 'https://ffmpeg.org/'], ['ffprobe', 'https://ffmpeg.org/'],
  ]) {
    try { execFileSync(bin, [bin.startsWith('ff') ? '-version' : '--version'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { missing.push(`${bin}: ${link}`); }
  }
  try {
    const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) missing.push('FFmpeg com libx264 e AAC: https://ffmpeg.org/');
  } catch { /* ffmpeg ausente já é reportado acima */ }
  if (missing.length) throw new Error(`Pré-requisitos ausentes:\n${missing.join('\n')}`);

  step('Localizando o npm local (nenhuma ferramenta global é alterada)');
  const npmCli = await findNpmCli();
  if (!npmCli) throw new Error('Node sem npm localizável: instale Node com npm; nenhuma ferramenta global foi alterada');

  step('Instalando pnpm 10.32.1 local em work/setup-tools');
  await run(process.execPath, [npmCli, 'install', '--prefix', join(root, 'work/setup-tools'),
    '--no-audit', '--no-fund', '--no-package-lock', 'pnpm@10.32.1'], root);
  const pnpm = join(root, 'work/setup-tools/node_modules/pnpm/bin/pnpm.cjs');

  step('Instalando as dependências do pacote JS');
  await run(process.execPath, [pnpm, 'install', '--frozen-lockfile'], root);

  step('Instalando o motor de condense pinado');
  await installEngine(root);

  step('Instalando Python 3.11 e 3.12 via uv');
  await run('uv', ['python', 'install', '3.11', '3.12'], root);

  step('Sincronizando o ambiente de fala (services/speech, Python 3.11)');
  await run('uv', ['sync', '--locked', '--python', '3.11'], join(root, 'services/speech'));

  step('Sincronizando o ambiente de visão (services/vision, Python 3.12)');
  await run('uv', ['sync', '--locked', '--python', '3.12'], join(root, 'services/vision'));

  const venv = join(root, 'work/engine-venv');
  if (!(await exists(venv))) {
    step('Criando o venv do motor (work/engine-venv, Python 3.11)');
    await run('uv', ['venv', '--python', '3.11', venv], root);
  }
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let pythonOk = await exists(python);
  if (pythonOk) {
    try { execFileSync(python, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { pythonOk = false; }
  }
  if (!pythonOk) {
    throw new Error(`venv existente sem Python válido em ${venv}; nenhuma alteração feita — remova a pasta manualmente para recriá-la`);
  }

  step('Instalando as dependências Python do motor');
  await run('uv', ['pip', 'install', '--python', python, '-r', join(root, 'work/video-agent-kit-plugin/requirements.txt')], root);

  step('Instalando scenedetect');
  await run('uv', ['pip', 'install', '--python', python, '--no-deps', 'scenedetect>=0.6'], root);

  process.env.DECUPA_ENGINE_PYTHON = python;

  step('Testando o motor (condense --help)');
  await run(python, [join(root, 'scripts/condense.py'), '--help'], root);

  step('Executando o diagnóstico local (doctor --local)');
  await run(process.execPath, ['--experimental-strip-types', join(root, 'apps/cli/src/index.ts'), 'doctor', '--local'], root);

  await prepareModels(root);
  console.log('Setup local concluído. Modelos padrão de fala PT-BR e visão instalados e carregados.');
}

// Node resolve o módulo principal via realpath; comparar sem realpath faria o
// guard falhar silenciosamente quando o script é invocado por um symlink.
const invokedAs = process.argv[1]
  ? await realpath(resolve(process.argv[1])).catch(() => resolve(process.argv[1]))
  : undefined;
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(arg => arg !== '--engine-only');
  if (unknown.length) {
    console.error(`argumento desconhecido: ${unknown.join(', ')} (use apenas --engine-only ou nenhum argumento)`);
    process.exitCode = 1;
  } else {
    const action = argv.includes('--engine-only') ? installEngine : setup;
    action(ROOT).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

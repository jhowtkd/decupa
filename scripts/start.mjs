// Um comando para abrir o Decupa sem configurar PATH: traduz --project/--input
// para os comandos montar/limpar do CLI, confere o runtime local preparado pelo
// setup e lança o servidor com o Python do motor injetado no ambiente.
// Este módulo não executa nada ao ser importado.
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = path => access(path).then(() => true, () => false);

/**
 * Traduz os argumentos do launcher para o CLI: exatamente uma fonte
 * (--project abre a montagem, --input abre a limpeza) e porta opcional
 * válida. Caminhos são resolvidos para absolutos e seguem como argumentos
 * de spawn — sem shell, portanto espaços e caracteres especiais são
 * preservados. Flags pagas (--allow-paid-*) não existem aqui de propósito.
 */
export function startArgs(argv) {
  const { values } = parseArgs({ args: argv, options: {
    project: { type: 'string' }, input: { type: 'string' }, port: { type: 'string' },
  }});
  if (Boolean(values.project) === Boolean(values.input)) throw new Error('informe project ou input, exclusivamente');
  const args = values.project ? ['montar', '--project', resolve(values.project)] : ['limpar', '--input', resolve(values.input)];
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('porta inválida: use um inteiro entre 1 e 65535');
    args.push('--port', String(port));
  }
  return args;
}

/**
 * Verifica o runtime local e lança o CLI pelo próprio Node. `root` e `argv`
 * são parâmetros para os testes provarem a ausência de runtime num diretório
 * temporário; a entrada protegida usa os padrões do repositório.
 */
export async function main(root = ROOT, argv = process.argv.slice(2)) {
  const python = join(root, 'work/engine-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!(await exists(python))) {
    throw new Error(`Python do motor não encontrado em ${python}\nExecute primeiro: node scripts/setup.mjs`);
  }
  if (!(await exists(join(root, 'node_modules')))) {
    throw new Error(`Dependências do pacote JS não encontradas em ${join(root, 'node_modules')}\nExecute primeiro: node scripts/setup.mjs`);
  }
  // Não detached: o Ctrl+C do console chega ao CLI no grupo foreground, e o
  // forwarding abaixo cobre quem sinaliza só o launcher; o executor do CLI é
  // o responsável pelos subprocessos dele.
  const child = spawn(process.execPath, [
    '--experimental-strip-types', join(root, 'apps/cli/src/index.ts'), ...startArgs(argv),
  ], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DECUPA_ENGINE_PYTHON: python },
  });
  child.once('error', error => { console.error(`falha ao iniciar o Decupa: ${error.message}`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  return child;
}

// Node resolve o módulo principal via realpath; comparar sem realpath faria o
// guard falhar silenciosamente quando o script é invocado por um symlink
// (mesmo padrão de scripts/setup.mjs).
const invokedAs = process.argv[1]
  ? await realpath(resolve(process.argv[1])).catch(() => resolve(process.argv[1]))
  : undefined;
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

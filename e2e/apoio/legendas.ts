// Imprime o `subtitleRecord` do Projeto como ele está no disco: a fonte única
// das legendas da prévia e da exportação. Roda fora do runner (strip-types):
//   node --experimental-strip-types e2e/apoio/legendas.ts <pasta-do-projeto>
import { loadProject } from "../../apps/cli/src/app/assembly/store.ts";
import { subtitleRecord } from "../../apps/cli/src/app/assembly/subtitles.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("uso: legendas.ts <pasta-do-projeto>");
  process.exit(2);
}
const project = await loadProject(dir);
const { legendas, subtitles } = subtitleRecord(project);
process.stdout.write(`${JSON.stringify({ revision: project.revision, legendas, vtt: subtitles?.vtt ?? null, srt: subtitles?.srt ?? null })}\n`);

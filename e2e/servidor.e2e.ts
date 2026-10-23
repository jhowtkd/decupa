// O servidor de teste não deixa processo para trás: parar() encerra o grupo
// do servidor, também quando ele trava e não atende o SIGTERM (POSIX).
import { test, expect } from "./apoio/fixtures.ts";

/** O processo (ou o grupo, com PID negativo) ainda existe? */
function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    return (erro as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("parar encerra o grupo do servidor, inclusive travado", async ({ semear, servidor }) => {
  test.skip(process.platform === "win32", "grupo de processos é coisa do POSIX");
  const semeado = await semear("fila", 1);
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });

  const pid = srv.pid!;
  expect(vivo(-pid)).toBe(true);
  await srv.parar();
  expect(vivo(pid)).toBe(false);
  expect(vivo(-pid)).toBe(false);

  // Travado (SIGSTOP não deixa tratar o SIGTERM): depois do prazo, SIGKILL no grupo.
  await srv.subir();
  const travado = srv.pid!;
  expect(travado).not.toBe(pid);
  process.kill(travado, "SIGSTOP");
  await srv.parar(1000);
  expect(vivo(travado)).toBe(false);
  expect(vivo(-travado)).toBe(false);
});

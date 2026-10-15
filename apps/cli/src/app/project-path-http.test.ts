import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "./server.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

// As duas páginas importam os módulos como módulos: sem a rota, o import dá 404
// e o script inteiro da página não roda.
it("Limpeza e Montagem servem os módulos que as páginas importam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-path-http-"));
  const cleanup = await startApp({ input: join(dir, "v.mp4"), port: 0, autoStart: false, executor });
  const assembly = await startApp({ projectDir: join(dir, "montagem"), port: 0, executor });
  stops.push(async () => { await cleanup.close(); await assembly.close(); await rm(dir, { recursive: true, force: true }); });

  for (const app of [cleanup, assembly]) {
    const res = await fetch(`http://127.0.0.1:${app.port}/project-path.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toContain("export function projectPath");
    const reservationUi = await fetch(`http://127.0.0.1:${app.port}/edit-reservation-ui.js`);
    expect(reservationUi.status).toBe(200);
    expect(reservationUi.headers.get("content-type")).toMatch(/javascript/);
    const reservationUiText = await reservationUi.text();
    expect(reservationUiText).toContain("mountEditReservationUI");
    expect(reservationUiText).toContain("assumiu a edição às");
  }
});

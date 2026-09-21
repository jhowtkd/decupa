import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
it("entrada inválida não conecta ao Resolve",()=>{
 const r=spawnSync("python3",["scripts/davinci-delivery.py","--request","/inexistente/request.json"],{encoding:"utf8"});
 expect(r.status).not.toBe(0);expect(r.stdout).toContain('"ok": false');
});
it("ponte valida importação, offsets, mídia e preserva projetos",()=>{
 const r=spawnSync("python3",["scripts/davinci-delivery-check.py"],{encoding:"utf8"});
 expect(r.stderr+r.stdout).toContain("OK");expect(r.status).toBe(0);
});

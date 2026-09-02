import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { hashFile } from "./hash.ts";

describe("hashFile", () => {
  it("devolve sha256 hex de 64 caracteres", async () => {
    const hash = await hashFile(join(FIXTURES, "tone-gap.wav"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("é estável entre chamadas", async () => {
    const path = join(FIXTURES, "tone-gap.wav");
    expect(await hashFile(path)).toBe(await hashFile(path));
  });

  it("difere entre arquivos diferentes", async () => {
    const a = await hashFile(join(FIXTURES, "tone-gap.wav"));
    const b = await hashFile(join(FIXTURES, "raw.wav"));
    expect(a).not.toBe(b);
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Flag do teste: com ela ligada, o handle devolve no máximo 64 KiB por leitura.
const controle = vi.hoisted(() => ({ leituraCurta: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: (async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      return new Proxy(handle, {
        get(alvo, prop) {
          if (prop === "read") {
            return (buffer: Buffer, offset: number, length: number, position: number) =>
              read(buffer, offset, controle.leituraCurta ? Math.min(length, 64 * 1024) : length, position);
          }
          const valor = Reflect.get(alvo, prop, alvo) as unknown;
          return typeof valor === "function" ? valor.bind(alvo) : valor;
        },
      });
    }) as typeof original.open,
  };
});

const { sourceSample } = await import("./session.ts");

const MIB = 1024 * 1024;

afterEach(() => {
  controle.leituraCurta = false;
});

/** Bytes pseudoaleatórios determinísticos (xorshift32). */
function bytesDeterministicos(n: number): Buffer {
  const out = Buffer.alloc(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function arquivo() {
  const conteudo = bytesDeterministicos(3 * MIB);
  const dir = await mkdtemp(join(tmpdir(), "decupa-amostra-"));
  const path = join(dir, "v.mp4");
  await writeFile(path, conteudo);
  const esperada = createHash("sha256")
    .update(String(conteudo.length))
    .update(conteudo.subarray(0, MIB))
    .update(conteudo.subarray(conteudo.length - MIB))
    .digest("hex");
  return { path, size: conteudo.length, esperada };
}

describe("sourceSample", () => {
  it("controle: sem leitura curta, bate com sha256(tamanho + primeiro MiB + último MiB)", async () => {
    const { path, size, esperada } = await arquivo();
    expect(await sourceSample(path, size)).toBe(esperada);
  });

  it("leitura curta (64 KiB por chamada) dá a mesma amostra", async () => {
    // Em disco de rede ou sob demanda o read devolve menos que o pedido; fazer
    // o hash só do que veio daria uma amostra diferente a cada vez e
    // invalidaria a sessão por nada.
    const { path, size, esperada } = await arquivo();
    controle.leituraCurta = true;
    expect(await sourceSample(path, size)).toBe(esperada);
  });
});

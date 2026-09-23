import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

let capturedArgs: string[] | null = null;
let fakeStderr = "";

function fakeExecFile(..._args: unknown[]): void {
  throw new Error("fakeExecFile deve ser chamado apenas via promisify");
}
(fakeExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (
  _file: string,
  args: string[],
) => {
  capturedArgs = args;
  return { stdout: "", stderr: fakeStderr };
};

vi.mock("node:child_process", () => ({
  execFile: fakeExecFile,
}));

const { detectSilence } = await import("./silence.ts");

describe("detectSilence - argumentos do ffmpeg", () => {
  afterEach(() => {
    capturedArgs = null;
    fakeStderr = "";
  });

  it("desliga o vídeo passando -vn depois de -i", async () => {
    fakeStderr = "";

    await detectSilence({ input: "/tmp/entrada.mp4", thresholdDb: -40, minDurationMs: 200 });

    expect(capturedArgs).not.toBeNull();
    const args = capturedArgs!;
    expect(args).toContain("-vn");

    const iIndex = args.indexOf("-i");
    const vnIndex = args.indexOf("-vn");
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(vnIndex).toBeGreaterThan(iIndex);
  });

  it("monta o filtro silencedetect com threshold e duração mínima corretos", async () => {
    fakeStderr = "";

    await detectSilence({ input: "/tmp/entrada.mp4", thresholdDb: -40, minDurationMs: 200 });

    const args = capturedArgs!;
    const afIndex = args.indexOf("-af");
    expect(afIndex).toBeGreaterThanOrEqual(0);
    expect(args[afIndex + 1]).toBe("silencedetect=noise=-40dB:d=0.2");
  });

  it("continua fazendo o parsing dos intervalos a partir do stderr mesmo com -vn no comando", async () => {
    fakeStderr = [
      "[silencedetect @ 0x1] silence_start: 1",
      "[silencedetect @ 0x1] silence_end: 1.6 | silence_duration: 0.6",
    ].join("\n");

    const silences = await detectSilence({
      input: "/tmp/entrada.mp4",
      thresholdDb: -40,
      minDurationMs: 200,
    });

    expect(silences).toEqual([{ startMs: 1000, endMs: 1600 }]);
  });
});

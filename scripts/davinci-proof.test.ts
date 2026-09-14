import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./davinci-proof.py", import.meta.url));

let HAS_PYTHON3 = true;
try {
  execFileSync("python3", ["--version"], { stdio: "ignore" });
} catch {
  HAS_PYTHON3 = false;
}

type ProofReport = {
  ok: boolean;
  error?: string;
  expectedClips?: { video: number[]; audio: number[] };
  actualClips?: { video: number[]; audio: number[] };
  offline?: string[];
};

async function runProof(args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; report: ProofReport }> {
  try {
    const { stdout } = await execFileAsync("python3", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, report: JSON.parse(stdout) as ProofReport };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, report: JSON.parse(e.stdout ?? "{}") as ProofReport };
  }
}

const STUB_MODULE = `
import os

MODE = os.environ.get("DECUPA_STUB_MODE", "online")

class _FakePoolItem:
    def __init__(self, path):
        self._path = path
    def GetClipProperty(self, prop):
        return self._path if prop == "File Path" else ""

class _FakeItem:
    def __init__(self, name, online, path):
        self._name = name
        self._online = online
        self._path = path
    def GetName(self):
        return self._name
    def GetMediaPoolItem(self):
        return _FakePoolItem(self._path) if self._online else None

class _FakeTimeline:
    def GetTrackCount(self, track_type):
        return 1
    def GetName(self):
        return "LinhaDoTempoDeTeste"
    def GetStartFrame(self):
        return 0
    def GetEndFrame(self):
        return 100
    def GetItemListInTrack(self, track_type, index):
        media_dir = os.environ.get("DECUPA_STUB_MEDIA_DIR", "")
        online_path = os.path.join(media_dir, "ausente.mp4" if MODE == "missing-file" else "midia.mp4")
        if track_type == "video" and index == 1:
            if MODE == "mismatch":
                return [_FakeItem("clipe-a", True, online_path)]
            if MODE == "offline":
                return [_FakeItem("clipe-a", True, online_path), _FakeItem("clipe-b", False, "")]
            return [_FakeItem("clipe-a", True, online_path), _FakeItem("clipe-b", True, online_path)]
        if track_type == "audio" and index == 1:
            return [_FakeItem("audio-a", True, online_path)]
        return []

class _FakeMediaPool:
    def ImportTimelineFromFile(self, path):
        return _FakeTimeline()

class _FakeProject:
    def GetMediaPool(self):
        return _FakeMediaPool()

class _FakeProjectManager:
    def CreateProject(self, name):
        return _FakeProject()
    def LoadProject(self, name):
        return _FakeProject()
    def CloseProject(self, project):
        return True
    def DeleteProject(self, name):
        return True

class _FakeResolve:
    def GetProjectManager(self):
        return _FakeProjectManager()

def scriptapp(name):
    return _FakeResolve()
`;

function track(kind: string, name: string, clips: string[]) {
  return {
    OTIO_SCHEMA: "Track.1",
    name,
    kind,
    children: clips.map((clip) => ({ OTIO_SCHEMA: "Clip.1", name: clip })),
  };
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "davinci-proof-"));
  const otioPath = join(dir, "timeline.otio");
  writeFileSync(
    otioPath,
    JSON.stringify({
      OTIO_SCHEMA: "Timeline.1",
      name: "Teste",
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [track("Video", "V1", ["clipe-a", "clipe-b"]), track("Audio", "A1", ["audio-a"])],
      },
    }),
  );
  const stubDir = join(dir, "stub");
  const stubFile = join(stubDir, "DaVinciResolveScript.py");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubFile, STUB_MODULE);
  const mediaDir = join(dir, "midia");
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, "midia.mp4"), "fake");
  return { dir, otioPath, stubDir, stubFile, mediaDir };
}

function stubEnv(fixture: ReturnType<typeof makeFixture>, mode: string): NodeJS.ProcessEnv {
  const sep = process.platform === "win32" ? ";" : ":";
  const pythonPath = process.env.PYTHONPATH
    ? `${fixture.stubDir}${sep}${process.env.PYTHONPATH}`
    : fixture.stubDir;
  return {
    PYTHONPATH: pythonPath,
    DECUPA_RESOLVE_STUB: fixture.stubFile,
    DECUPA_STUB_MODE: mode,
    DECUPA_STUB_MEDIA_DIR: fixture.mediaDir,
  };
}

describe.runIf(HAS_PYTHON3)("davinci-proof", () => {
  it("otio inexistente retorna ok:false com exit 2", async () => {
    const { code, report } = await runProof([join(tmpdir(), "nao-existe-ice3-06.otio")]);
    expect(code).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.error ?? "").toMatch(/não encontrado/i);
  });

  it("validação reprova clipe offline via stub", async () => {
    const fixture = makeFixture();
    const { report } = await runProof([fixture.otioPath], stubEnv(fixture, "offline"));
    expect(report.ok).toBe(false);
    expect(report.offline?.join("\n") ?? "").toContain("clipe-b");
  });

  it("validação aprova timeline tudo-online via stub, com contagens", async () => {
    const fixture = makeFixture();
    const { code, report } = await runProof([fixture.otioPath], stubEnv(fixture, "online"));
    expect(report.ok).toBe(true);
    expect(code).toBe(0);
    expect(report.expectedClips).toEqual({ video: [2], audio: [1] });
    expect(report.actualClips).toEqual({ video: [2], audio: [1] });
    expect(report.offline).toEqual([]);
  });

  it("reprova arquivo ausente mesmo com MediaPoolItem", async () => {
    const fixture = makeFixture();
    const { code, report } = await runProof([fixture.otioPath], stubEnv(fixture, "missing-file"));
    expect(code).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.offline?.join("\n")).toContain("arquivo ausente");
  });

  it("validação reprova contagem divergente via stub", async () => {
    const fixture = makeFixture();
    const { code, report } = await runProof([fixture.otioPath], stubEnv(fixture, "mismatch"));
    expect(code).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.actualClips).toEqual({ video: [1], audio: [1] });
    expect(report.error ?? "").toMatch(/diverg/i);
  });
});

import { expect, it, vi } from "vitest";
import * as contexto from "./contexto.js";
import * as rail from "./rail.js";
import { singleFlight } from "./sequencia.js";
import * as texto from "./texto.js";

function projectState(project: unknown) {
  return { get: (key: string) => (key === "project" ? project : undefined) };
}

function button(label: string) {
  const attrs = new Map<string, string>();
  return {
    textContent: label,
    disabled: false,
    setAttribute(name: string, value: string) { attrs.set(name, value); },
    getAttribute(name: string) { return attrs.get(name) ?? null; },
  };
}

type SpeechResponse = { res: { ok: boolean, status?: number }, body?: { error?: string } };

function speechHarness(project: unknown) {
  const calls: { path: string, method: string, label: string, body: unknown }[] = [];
  const proposals: number[] = [];
  let release!: (value: SpeechResponse) => void;
  let rejectCall!: (error: Error) => void;
  const btn = button("Propor ajuste");
  const run = texto.speechProposalAction({
    state: projectState(project),
    api: {
      call: (path: string, init: { method: string, body: string, label: string }) => {
        calls.push({ path, method: init.method, label: init.label, body: JSON.parse(init.body) });
        return new Promise<SpeechResponse>((resolve, reject) => {
          release = resolve;
          rejectCall = reject;
        });
      },
    },
    button: btn,
    readTarget: () => ({ sourceId: "src", speechId: "sp1", request: "encurte o gancho" }),
    onProposal: () => { proposals.push(proposals.length + 1); },
  });
  return { calls, proposals, btn, run, release: () => release, reject: () => rejectCall };
}

it("propor ajuste: dois cliques com a primeira chamada pendente disparam um POST e travam o botão", async () => {
  const { calls, proposals, btn, run, release } = speechHarness({ revision: 4 });
  const first = run();
  expect(run()).toBeUndefined();
  expect(calls).toEqual([{
    path: "/project/speech-proposal",
    method: "POST",
    label: "Propondo ajuste…",
    body: { baseRevision: 4, sourceId: "src", speechId: "sp1", request: "encurte o gancho" },
  }]);
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toBe("Propondo ajuste…");
  expect(btn.getAttribute("aria-busy")).toBe("true");
  release()({ res: { ok: true, status: 200 }, body: {} });
  await first;
  expect(proposals).toEqual([1]);
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("Propor ajuste");
  expect(btn.getAttribute("aria-busy")).toBe("false");
});

it("propor ajuste com 409 não aplica a proposta, destrava e o clique seguinte chama de novo", async () => {
  const { calls, proposals, btn, run, release } = speechHarness({ revision: 4 });
  const first = run();
  expect(run()).toBeUndefined();
  release()({ res: { ok: false, status: 409 }, body: { error: "já existe uma proposta em voo" } });
  await first;
  expect(proposals).toEqual([]);
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("Propor ajuste");
  expect(btn.getAttribute("aria-busy")).toBe("false");
  const second = run();
  expect(calls).toHaveLength(2);
  release()({ res: { ok: true, status: 200 }, body: {} });
  await second;
  expect(proposals).toEqual([1]);
});

it("propor ajuste engole a rejeição, destrava o botão e aceita outro clique", async () => {
  const { calls, proposals, btn, run, reject, release } = speechHarness({ revision: 4 });
  const first = run();
  expect(run()).toBeUndefined();
  reject()(new Error("rede"));
  await expect(first).resolves.toBeUndefined();
  expect(proposals).toEqual([]);
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("Propor ajuste");
  expect(btn.getAttribute("aria-busy")).toBe("false");
  const second = run();
  expect(calls).toHaveLength(2);
  release()({ res: { ok: true, status: 200 }, body: {} });
  await second;
});

it("propor ajuste sem projeto não chama a API", () => {
  const { calls, proposals, btn, run } = speechHarness(null);
  expect(run()).toBeUndefined();
  expect(calls).toEqual([]);
  expect(proposals).toEqual([]);
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("Propor ajuste");
});

function adjustHarness(request: string, project: unknown = { revision: 2, scenes: [{ id: "s1" }] }) {
  const calls: { path: string, method: string, label: string, body: unknown }[] = [];
  const errors: string[] = [];
  const busy: boolean[] = [];
  let release!: (value: { res: { ok: boolean } }) => void;
  const run = contexto.adjustAction({
    state: projectState(project),
    api: {
      call: (path: string, init: { method: string, body: string, label: string }) => {
        calls.push({ path, method: init.method, label: init.label, body: JSON.parse(init.body) });
        return new Promise((resolve) => { release = resolve; });
      },
      notifyError: (message: string) => { errors.push(message); },
    },
    readRequest: () => request,
    onChange: (value: boolean) => { busy.push(value); },
  });
  return { calls, errors, busy, run, release: () => release };
}

it("pedir ajuste vazio ou só com espaços avisa e não chama a API", () => {
  const empty = adjustHarness("");
  expect(empty.run()).toBeUndefined();
  const spaces = adjustHarness("   \n ");
  expect(spaces.run()).toBeUndefined();
  expect(empty.calls).toEqual([]);
  expect(spaces.calls).toEqual([]);
  expect(empty.errors).toEqual([contexto.EMPTY_ADJUST_MESSAGE]);
  expect(spaces.errors).toEqual([contexto.EMPTY_ADJUST_MESSAGE]);
  expect(empty.busy).toEqual([]);
  expect(spaces.busy).toEqual([]);
  expect(contexto.EMPTY_ADJUST_MESSAGE).toBe("Escreva o ajuste que você quer antes de enviar.");
});

it("pedir ajuste: dois cliques com a primeira chamada pendente disparam um POST", async () => {
  const { calls, busy, run, release } = adjustHarness("tire o silêncio do gancho");
  const first = run();
  expect(run()).toBeUndefined();
  expect(calls).toEqual([{
    path: "/project/adjust",
    method: "POST",
    label: "Ajustando montagem…",
    body: { baseRevision: 2, request: "tire o silêncio do gancho", modelOptIn: true, visualOptIn: true },
  }]);
  expect(busy).toEqual([true]);
  release()({ res: { ok: true } });
  await first;
  expect(busy).toEqual([true, false]);
});

it("pedir ajuste sem projeto não chama a API", () => {
  const { calls, errors, busy, run } = adjustHarness("encurte", null);
  expect(run()).toBeUndefined();
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
  expect(busy).toEqual([]);
});

it("botão de ajuste trava em voo e, fora dele, trava sem cena ou com trabalho de fundo", () => {
  expect(contexto.adjustButtonView(true, false, true)).toEqual({
    disabled: true, label: "Ajustando montagem…", busy: true,
  });
  expect(contexto.adjustButtonView(false, false, true)).toEqual({
    disabled: false, label: "Aplicar ajuste com IA", busy: false,
  });
  expect(contexto.adjustButtonView(false, true, true)).toEqual({
    disabled: true, label: "Aplicar ajuste com IA", busy: false,
  });
  expect(contexto.adjustButtonView(false, false, false)).toEqual({
    disabled: true, label: "Aplicar ajuste com IA", busy: false,
  });
});

it("preparar em voo trava os dois botões; servidor ocupado trava o retomar", () => {
  const action = { label: "Preparar montagem", disabled: false };
  expect(rail.PREPARE_BUSY_LABEL).toBe("Preparando montagem…");
  expect(rail.prepareControls(action, false, true)).toEqual({
    label: "Preparando montagem…", disabled: true,
    resumeLabel: "Preparando montagem…", resumeDisabled: true, busy: true,
  });
  expect(rail.prepareControls(action, false, false)).toEqual({
    label: "Preparar montagem", disabled: false,
    resumeLabel: "Retomar preparação", resumeDisabled: false, busy: false,
  });
  expect(rail.prepareControls({ label: "Montar vídeo", disabled: true }, false, false)).toMatchObject({
    label: "Montar vídeo", disabled: true, resumeDisabled: false, busy: false,
  });
  expect(rail.prepareControls(action, true, false)).toEqual({
    label: "Preparar montagem", disabled: true,
    resumeLabel: "Preparando montagem…", resumeDisabled: true, busy: true,
  });
});

it("com a ação em andamento, retomar repete o rótulo da ação", () => {
  const action = { kind: "busy", label: "Analisando mídia…", disabled: true };
  expect(rail.prepareControls(action, true, false)).toEqual({
    label: "Analisando mídia…", disabled: true,
    resumeLabel: "Analisando mídia…", resumeDisabled: true, busy: true,
  });
});

it("preparação ocupada quando está running ou a operação segue em curso", () => {
  const interrupted = { preparation: { status: "interrupted" } };
  expect(rail.preparationBusy({ preparation: { status: "running" } }, null)).toBe(true);
  for (const stage of ["analyzing", "preparing", "rendering", "proposing"]) {
    expect(rail.preparationBusy(interrupted, { stage })).toBe(true);
  }
  expect(rail.preparationBusy(interrupted, null)).toBe(false);
  expect(rail.preparationBusy(interrupted, { stage: "ready" })).toBe(false);
  expect(rail.preparationBusy(interrupted, { stage: "error" })).toBe(false);
});

it("preparar duas vezes com a primeira chamada pendente dispara um prepare", async () => {
  let release!: () => void;
  const prepares: number[] = [];
  const draft = rail.createBriefingDraft({
    read: () => ({ text: "roteiro X" }),
    write: () => {},
    save: async () => true,
  });
  draft.edit();
  const run = singleFlight(() => rail.prepareAfterBriefing(draft, () => new Promise<void>((resolve) => {
    prepares.push(prepares.length + 1);
    release = resolve;
  })));
  const first = run();
  expect(run()).toBeUndefined();
  await vi.waitFor(() => expect(prepares).toEqual([1]));
  expect(run()).toBeUndefined();
  expect(prepares).toEqual([1]);
  release();
  await first;
});

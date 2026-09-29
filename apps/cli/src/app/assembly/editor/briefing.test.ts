import { afterEach, expect, it, vi } from "vitest";
import * as rail from "./rail.js";
import { createState } from "./state.js";

afterEach(() => { vi.unstubAllGlobals(); });

type BriefInput = { kind: string, text: string, targetSeconds: number };

function draftOf(input: BriefInput, save: (values: BriefInput) => Promise<boolean>) {
  let fields = { ...input };
  const written: BriefInput[] = [];
  const draft = rail.createBriefingDraft({
    read: () => fields,
    write: (next: BriefInput) => { written.push({ ...next }); fields = { ...next }; },
    save,
  });
  return {
    draft,
    written,
    fields: () => fields,
    type: (text: string) => { fields = { ...fields, text }; draft.edit(); },
  };
}

// Cada save abre o portão seguinte; `release` solta um save já em voo, na ordem.
function gatedSave() {
  const order: string[] = [];
  const pending: Array<(ok: boolean) => void> = [];
  let open!: () => void;
  const nextGate = () => new Promise<void>((resolve) => { open = resolve; });
  let gate = nextGate();
  const save = (values: BriefInput) => {
    order.push("save:" + values.text);
    open();
    return new Promise<boolean>((resolve) => { pending.push(resolve); });
  };
  return {
    order,
    save,
    entered: () => gate,
    arm() { gate = nextGate(); },
    release(index: number, ok: boolean) {
      const done = pending[index];
      if (!done) throw new Error("save " + index + " ainda não começou");
      done(ok);
    },
  };
}

it("sync com alteração pendente não escreve; sem alteração, repopula", () => {
  const { draft, written, fields, type } = draftOf(
    { kind: "brief", text: "", targetSeconds: 60 },
    async () => true,
  );
  draft.sync({ kind: "script", text: "do servidor", targetSeconds: 30 });
  expect(fields()).toEqual({ kind: "script", text: "do servidor", targetSeconds: 30 });
  expect(written).toHaveLength(1);
  type("roteiro X");
  draft.sync({ kind: "brief", text: "", targetSeconds: 60 });
  expect(fields().text).toBe("roteiro X");
  expect(written).toHaveLength(1);
});

it("roteiro digitado sobrevive ao projeto que chega e é salvo antes do prepare", async () => {
  const order: string[] = [];
  let saved: BriefInput | null = null;
  const { draft, fields, type } = draftOf(
    { kind: "brief", text: "", targetSeconds: 60 },
    async (values) => { saved = values; order.push("save"); return true; },
  );
  type("roteiro X");
  draft.sync({ kind: "brief", text: "", targetSeconds: 60 });
  expect(fields().text).toBe("roteiro X");
  expect(draft.dirty()).toBe(true);
  const ok = await rail.prepareAfterBriefing(draft, async () => { order.push("prepare"); });
  expect(ok).toBe(true);
  expect(order).toEqual(["save", "prepare"]);
  expect(saved).toEqual({ kind: "brief", text: "roteiro X", targetSeconds: 60 });
  expect(draft.dirty()).toBe(false);
});

it("salvamento que devolve false não prepara e mantém a alteração", async () => {
  const { draft, type } = draftOf({ kind: "brief", text: "", targetSeconds: 60 }, async () => false);
  type("roteiro X");
  let prepared = false;
  await expect(rail.prepareAfterBriefing(draft, async () => { prepared = true; })).resolves.toBe(false);
  expect(prepared).toBe(false);
  expect(draft.dirty()).toBe(true);
});

it("salvamento que rejeita não prepara e mantém a alteração", async () => {
  const { draft, type } = draftOf(
    { kind: "brief", text: "", targetSeconds: 60 },
    async () => { throw new Error("rede"); },
  );
  type("roteiro X");
  let prepared = false;
  await expect(rail.prepareAfterBriefing(draft, async () => { prepared = true; })).resolves.toBe(false);
  expect(prepared).toBe(false);
  expect(draft.dirty()).toBe(true);
});

it("fechar descarta o digitado e o sync seguinte volta a repopular", () => {
  const { draft, fields, type } = draftOf(
    { kind: "brief", text: "roteiro X", targetSeconds: 60 },
    async () => true,
  );
  type("roteiro X");
  const server = { kind: "brief", text: "", targetSeconds: 60 };
  draft.discard(server);
  expect(draft.dirty()).toBe(false);
  expect(fields()).toEqual(server);
  const later = { kind: "script", text: "vindo do servidor", targetSeconds: 45 };
  draft.sync(later);
  expect(fields()).toEqual(later);
  expect(draft.dirty()).toBe(false);
});

it("salvamento aceito limpa a marca", async () => {
  const { draft, type } = draftOf({ kind: "brief", text: "", targetSeconds: 60 }, async () => true);
  type("roteiro X");
  expect(draft.dirty()).toBe(true);
  await expect(draft.flush()).resolves.toBe(true);
  expect(draft.dirty()).toBe(false);
});

it("editar durante o salvamento salva de novo antes do prepare", async () => {
  const gate = gatedSave();
  const { draft, type } = draftOf({ kind: "brief", text: "", targetSeconds: 60 }, gate.save);
  type("roteiro X");
  const result = rail.prepareAfterBriefing(draft, async () => { gate.order.push("prepare"); });
  await gate.entered();
  expect(gate.order).toEqual(["save:roteiro X"]);
  gate.arm();
  type("roteiro Y");
  gate.release(0, true);
  await gate.entered();
  expect(gate.order).toEqual(["save:roteiro X", "save:roteiro Y"]);
  gate.release(1, true);
  await expect(result).resolves.toBe(true);
  expect(gate.order).toEqual(["save:roteiro X", "save:roteiro Y", "prepare"]);
  expect(draft.dirty()).toBe(false);
});

it("se o segundo salvamento falha, o prepare não é chamado e a marca continua", async () => {
  const gate = gatedSave();
  const { draft, type } = draftOf({ kind: "brief", text: "", targetSeconds: 60 }, gate.save);
  type("roteiro X");
  const result = rail.prepareAfterBriefing(draft, async () => { gate.order.push("prepare"); });
  await gate.entered();
  gate.arm();
  type("roteiro Y");
  gate.release(0, true);
  await gate.entered();
  gate.release(1, false);
  await expect(result).resolves.toBe(false);
  expect(gate.order).toEqual(["save:roteiro X", "save:roteiro Y"]);
  expect(draft.dirty()).toBe(true);
});

it("dois flush simultâneos salvam uma vez quando o primeiro limpa a marca", async () => {
  let release!: (ok: boolean) => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { started = resolve; });
  const saved: string[] = [];
  const { draft, type } = draftOf({ kind: "brief", text: "", targetSeconds: 60 }, (values) => {
    saved.push(values.text);
    started();
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  type("roteiro X");
  const first = draft.flush();
  const second = draft.flush();
  await gate;
  expect(saved).toEqual(["roteiro X"]);
  release(true);
  await first;
  await second;
  expect(saved).toEqual(["roteiro X"]);
  expect(draft.dirty()).toBe(false);
});

// DOM mínimo do que mountRail percorre: innerHTML cria os ids; seletores de classe, atributo, :checked e descendente.
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
type Listener = (event: { type: string, preventDefault(): void }) => void;

class El {
  readonly tag: string;
  className = "";
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  textContent = "";
  parentElement: El | null = null;
  children: El[] = [];
  onclick: Listener | null = null;
  readonly style = { width: "" };
  readonly dataset: Record<string, string | undefined>;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tag = tag;
    const name = (key: string) => "data-" + key.replace(/[A-Z]/g, (char) => "-" + char.toLowerCase());
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_target, key) => typeof key === "string" ? this.attrs.get(name(key)) : undefined,
      set: (_target, key, value) => {
        if (typeof key !== "string") return false;
        this.attrs.set(name(key), String(value));
        return true;
      },
    });
  }

  get id() { return this.attrs.get("id") ?? ""; }
  set id(value: string) { this.attrs.set("id", value); }
  get type() { return this.attrs.get("type") ?? ""; }
  set type(value: string) { this.attrs.set("type", value); }
  readonly classList = {
    contains: (token: string) => this.className.split(/\s+/).includes(token),
    add: (token: string) => { if (!this.classList.contains(token)) this.className = `${this.className} ${token}`.trim(); },
    remove: (token: string) => { this.className = this.className.split(/\s+/).filter((item) => item && item !== token).join(" "); },
    toggle: (token: string, force?: boolean) => {
      const on = force ?? !this.classList.contains(token);
      if (on) this.classList.add(token); else this.classList.remove(token);
      return on;
    },
  };

  set innerHTML(html: string) { this.replaceChildren(); parseHtml(this, html); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  dispatchEvent(event: { type: string }) {
    const full = { preventDefault() {}, ...event };
    for (const fn of this.listeners.get(event.type) ?? []) fn(full);
    if (event.type === "click" && this.onclick) this.onclick(full);
  }

  append(...nodes: El[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: El) { node.detach(); node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node: El, ref: El | null) {
    node.detach();
    node.parentElement = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }

  replaceChildren(...nodes: El[]) {
    while (this.children.length) this.children[0].detach();
    for (const node of nodes) this.appendChild(node);
  }

  detach() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  contains(node: El | null) { for (let cur = node; cur; cur = cur.parentElement) if (cur === this) return true; return false; }
  querySelector(selector: string) { return queryAll(this, selector)[0] ?? null; }
  querySelectorAll(selector: string) { return queryAll(this, selector); }
}

function applyAttrs(el: El, raw: string) {
  for (const match of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1];
    if (!name || name === "/") continue;
    const quoted = match[2] ?? match[3] ?? match[4];
    if (name === "class") el.className = quoted ?? "";
    else if (name === "id") el.id = quoted ?? "";
    else el.setAttribute(name, quoted ?? "");
    if (name === "value") el.value = quoted ?? "";
    if (name === "type") el.type = quoted ?? "";
    if (quoted !== undefined) continue;
    if (name === "hidden") el.hidden = true;
    if (name === "disabled") el.disabled = true;
    if (name === "checked") el.checked = true;
  }
}

function parseHtml(root: El, html: string) {
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const stack = [root];
  for (const match of html.matchAll(re)) {
    if (match[0].startsWith("<!--") || match[5]) continue;
    if (match[1]) {
      const tag = match[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) if (stack[index].tag === tag) { stack.length = index; break; }
      continue;
    }
    const el = new El((match[2] ?? "").toLowerCase());
    applyAttrs(el, match[3] ?? "");
    stack[stack.length - 1].appendChild(el);
    if (match[4] !== "/" && !VOID.has(el.tag)) stack.push(el);
  }
}

function descendants(root: El): El[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function matches(el: El, part: string) {
  let src = part;
  if (src.endsWith(":checked")) { if (!el.checked) return false; src = src.slice(0, -":checked".length); }
  for (const attr of src.matchAll(/\[([^\]=\s]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
    const actual = el.getAttribute(attr[1]);
    const expected = attr[2] ?? attr[3];
    if (expected === undefined ? actual === null : actual !== expected) return false;
  }
  src = src.replace(/\[[^\]]*\]/g, "");
  const id = src.match(/#([A-Za-z0-9_-]+)/)?.[1];
  if (id && el.id !== id) return false;
  src = src.replace(/#[A-Za-z0-9_-]+/g, "");
  if ([...src.matchAll(/\.([A-Za-z0-9_-]+)/g)].some((item) => !el.classList.contains(item[1]))) return false;
  const tag = src.replace(/\.[A-Za-z0-9_-]+/g, "");
  return !tag || el.tag === tag;
}

function queryAll(root: El, selector: string) {
  let scope = [root];
  for (const part of selector.trim().split(/\s+/)) {
    scope = scope.flatMap((base) => descendants(base).filter((el) => matches(el, part)));
  }
  return scope;
}

function findId(node: El, id: string): El | null {
  if (node.id === id) return node;
  for (const child of node.children) { const found = findId(child, id); if (found) return found; }
  return null;
}

function installDom() {
  const body = new El("body");
  const document = {
    body,
    activeElement: null as El | null,
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => findId(body, id),
    querySelector: (selector: string) => queryAll(body, selector)[0] ?? null,
    querySelectorAll: (selector: string) => queryAll(body, selector),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { location: { assign() {} }, dispatchEvent() {} });
  vi.stubGlobal("CustomEvent", class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; }
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  body.innerHTML = '<button type="button" id="newProject">Novo projeto</button><span id="primaryAction"></span><aside id="rail"></aside><section id="activity" hidden></section><section id="monitorBriefing" hidden></section>';
  return document;
}

type Source = { id: string, name: string, included: boolean, hasVideo: boolean, role: string, durationSeconds: number };

function project(sources: Source[], revision: number) {
  return {
    revision,
    assembly: { sources },
    scenes: [] as unknown[],
    analyses: [] as unknown[],
    corrections: [] as unknown[],
    input: { kind: "brief", text: "", targetSeconds: 60 },
    preparation: sources.length ? { status: "pending", sources: {} as Record<string, unknown> } : null,
    finalApprovedRevision: null,
    previewRevision: null,
  };
}

function interruptedProject() {
  const base = project([{
    id: "a", name: "entrevista.mov", included: true, hasVideo: false, role: "speech", durationSeconds: 12,
  }], 4);
  return {
    ...base,
    preparation: {
      status: "interrupted",
      stage: "visual",
      sources: { a: { media: "ready", audio: "ready", visual: "pending" } },
    },
  };
}

function mountInterruptedResume() {
  const calls: { path: string, body: string }[] = [];
  const current = interruptedProject();
  const document = installDom();
  const state = createState({ project: current, operation: null });
  const api = {
    call(path: string, init: { body?: string }) {
      calls.push({ path, body: init.body ?? "" });
      if (path === "/project/prepare") {
        state.set("project", current);
        state.set("operation", { stage: "preparing" });
        return Promise.resolve({ res: { ok: true, status: 202 }, body: {} });
      }
      return Promise.resolve({ res: { ok: true }, body: {} });
    },
  };
  rail.mountRail({ state, api, player: { playOriginal() {}, seek() {} } });
  return { document, calls, state };
}

function mountTypedBriefing() {
  const calls: { path: string, body: string }[] = [];
  const api = {
    call(path: string, init: { body?: string }) {
      calls.push({ path, body: init.body ?? "" });
      if (path === "/project/prepare") return new Promise(() => {});
      return Promise.resolve({ res: { ok: true }, body: {} });
    },
  };
  const document = installDom();
  const state = createState({ project: project([], 3) });
  rail.mountRail({ state, api, player: { playOriginal() {}, seek() {} } });
  const field = document.getElementById("inputText");
  if (!field) throw new Error("campo de briefing ausente");
  field.value = "roteiro X";
  field.dispatchEvent({ type: "input" });
  state.set("project", project([{
    id: "a", name: "entrevista.mov", included: true, hasVideo: false, role: "speech", durationSeconds: 12,
  }], 4));
  return { document, calls, field };
}

it("digitar o briefing inline e importar uma fonte mantém o texto no campo", () => {
  const { field } = mountTypedBriefing();
  expect(field.value).toBe("roteiro X");
});

it("202 com preparação interrompida trava retomar e um segundo clique não prepara de novo", async () => {
  const { document, calls, state } = mountInterruptedResume();
  const resume = document.getElementById("resume");
  const prepare = document.getElementById("prepare");
  const resumeClick = resume?.onclick;
  const prepareClick = prepare?.onclick;
  if (!resume || !prepare || !resumeClick || !prepareClick) throw new Error("botões de preparar ausentes");
  const press = { type: "click", preventDefault() {} };
  const prepares = () => calls.filter((call) => call.path === "/project/prepare").length;
  expect(resume.hidden).toBe(false);
  expect(resume.disabled).toBe(false);
  resumeClick(press);
  // O 202 resolve na mesma volta; esperar a chamada deixa o singleFlight soltar antes do 2º clique.
  await vi.waitFor(() => expect(prepares()).toBe(1));
  const after = { hidden: resume.hidden, disabled: resume.disabled, label: resume.textContent };
  resumeClick(press);
  prepareClick(press);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect({ ...after, prepares: prepares() }).toEqual({
    hidden: false, disabled: true, label: "Preparando montagem…", prepares: 1,
  });
  state.set("operation", null);
  expect(resume.disabled).toBe(false);
  expect(resume.textContent).toBe("Retomar preparação");
  expect(resume.hidden).toBe(false);
  expect(prepares()).toBe(1);
});

it("clicar em preparar envia o briefing digitado e um segundo clique não prepara de novo", async () => {
  const { document, calls, field } = mountTypedBriefing();
  const prepare = document.getElementById("prepare");
  if (!prepare?.onclick) throw new Error("botão preparar ausente");
  prepare.onclick({ type: "click", preventDefault() {} });
  prepare.onclick({ type: "click", preventDefault() {} });
  await vi.waitFor(() => expect(calls.map((call) => call.path)).toEqual(["/project/input", "/project/prepare"]));
  expect(JSON.parse(calls[0].body).text).toBe("roteiro X");
  expect(field.value).toBe("roteiro X");
  expect(calls.filter((call) => call.path === "/project/prepare")).toHaveLength(1);
});

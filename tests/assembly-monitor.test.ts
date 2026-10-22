import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

type MonitorHarness = ReturnType<typeof createHarness>;

function createHarness(width: number) {
  let activeElement: ElementLike | null = null;
  const documentListeners = new Map<string, Array<(event: any) => void>>();
  const mediaListeners: Array<() => void> = [];
  function focusElement(element: ElementLike, notify = true) {
    activeElement = element;
    if (notify) {
      for (const listener of documentListeners.get("focusin") ?? []) listener({ target: element });
    }
  }

  class ElementLike {
    readonly id: string;
    readonly parent: ElementLike | null;
    readonly children: ElementLike[] = [];
    readonly attributes = new Map<string, string>();
    readonly dataset: Record<string, string> = {};
    readonly classList = {
      values: new Set<string>(),
      contains: (name: string) => this.classList.values.has(name),
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !this.classList.values.has(name);
        if (enabled) this.classList.values.add(name);
        else this.classList.values.delete(name);
        return enabled;
      },
    };
    inert = false;
    disabled = false;
    isConnected = true;
    hidden = false;
    open = false;
    scrollTop = 25;
    tabIndex = -1;
    focusCalls = 0;
    onclick: (() => void) | null = null;
    constructor(id: string, parent: ElementLike | null = null) {
      this.id = id;
      this.parent = parent;
      parent?.children.push(this);
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    getClientRects() { return this.hidden || !this.isConnected ? [] : [{}]; }
    contains(element: ElementLike | null) {
      for (let current = element; current; current = current.parent) if (current === this) return true;
      return false;
    }
    closest(selector: string) { return selector === "[hidden]" && this.hidden ? this : null; }
    querySelectorAll(): ElementLike[] { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
    focus() { focusElement(this); this.focusCalls += 1; }
    click() { this.onclick?.(); }
    scrollIntoView() {}
  }

  const body = new ElementLike("body");
  const monitor = new ElementLike("monitor", body);
  const toggle = new ElementLike("monitorToggle", body);
  const close = new ElementLike("closeMonitor", monitor);
  const player = new ElementLike("previewPlayer", monitor);
  const briefing = new ElementLike("briefingControl", monitor);
  player.tabIndex = 0;
  briefing.tabIndex = 0;
  const stageButtons = ["materiais", "edicao", "revisao", "entrega"].map(stage => {
    const button = new ElementLike(`stage-${stage}`, body);
    button.dataset.stage = stage;
    return button;
  });
  const elements = new Map<string, ElementLike>([
    ["monitor", monitor], ["monitorToggle", toggle], ["closeMonitor", close],
    ["previewPlayer", player], ["briefingControl", briefing], ["stages", new ElementLike("stages", body)],
    ["texto", new ElementLike("texto", body)], ["textoHead", new ElementLike("textoHead", body)],
    ["stage", new ElementLike("stage", monitor)], ["rail", new ElementLike("rail", body)],
    ["delivery", new ElementLike("delivery", body)],
  ]);
  const media = {
    matches: width <= 1100,
    query: "",
    addEventListener: (_type: string, listener: () => void) => mediaListeners.push(listener),
  };
  const document = {
    body,
    get activeElement() { return activeElement; },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === "#stages [data-stage]" ? stageButtons : [],
    querySelector: (selector: string) => selector === "dialog[open]" && dialog.open ? dialog : null,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
  };
  const dialog = new ElementLike("dialog", body);
  const state = { get: (key: string) => key === "stage" ? "materiais" : null };
  const jsPromise = readFile(new URL("../apps/cli/src/app/assembly/page.js", import.meta.url), "utf8");

  async function controller() {
    const js = await jsPromise;
    // O trecho do controlador inclui mountLegacyMonitor (focusin, Monitor, Esc e showMonitor(false)).
    const from = js.indexOf("const STAGE_TARGET");
    const throughController = js.indexOf("function applyTranscriptNotice", from);
    const fromStage = js.indexOf("function applyStageDom(stage)", throughController);
    const throughStage = js.indexOf("function setStage(stage)", fromStage);
    const offsets = [from, throughController, fromStage, throughStage];
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    return runInNewContext(
      js.slice(from, throughController)
        + js.slice(fromStage, throughStage)
        + "\nmountLegacyMonitor();\n;({ showMonitor, applyStageDom })",
      {
        document,
        matchMedia: (query: string) => { media.query = query; return media; },
        state,
        paintStages: () => undefined,
      },
    ) as { showMonitor: (show?: boolean) => void; applyStageDom: (stage: string) => void };
  }

  return {
    body, briefing, close, controller, dialog, document, media, mediaListeners, monitor, player, stageButtons,
    toggle, documentListeners,
    blurToBody() { focusElement(body, false); },
    keydown(key: string) {
      const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
      for (const listener of documentListeners.get("keydown") ?? []) listener(event);
      return event;
    },
  };
}

async function mount(width = 1024): Promise<MonitorHarness & Awaited<ReturnType<MonitorHarness["controller"]>>> {
  const harness = createHarness(width);
  return { ...harness, ...await harness.controller() };
}

it("monitor recolhido é inert e abrir move o foco para Fechar", async () => {
  const ui = await mount();

  expect(ui.monitor.inert).toBe(true);
  expect(ui.toggle.getAttribute("aria-expanded")).toBe("false");
  ui.toggle.click();
  expect({ inert: ui.monitor.inert, expanded: ui.toggle.getAttribute("aria-expanded"), active: ui.document.activeElement })
    .toEqual({ inert: false, expanded: "true", active: ui.close });
  expect(ui.close.focusCalls).toBe(1);
  expect(ui.monitor.scrollTop).toBe(0);
});

it("fechar pela ação e Escape devolve foco ao acionador; diálogo aberto consome Escape", async () => {
  const ui = await mount();

  ui.toggle.click();
  ui.close.click();
  expect({ inert: ui.monitor.inert, focus: ui.toggle.focusCalls }).toEqual({ inert: true, focus: 1 });

  ui.toggle.click();
  ui.dialog.open = true;
  const dialogEscape = ui.keydown("Escape");
  expect({ open: ui.body.classList.contains("monitor-open"), prevented: dialogEscape.prevented }).toEqual({ open: true, prevented: false });
  ui.dialog.open = false;
  const escape = ui.keydown("Escape");
  expect({ open: ui.body.classList.contains("monitor-open"), inert: ui.monitor.inert, prevented: escape.prevented, focus: ui.toggle.focusCalls })
    .toEqual({ open: false, inert: true, prevented: true, focus: 2 });
});

it("revisão abre o monitor e fechar devolve foco ao botão da etapa", async () => {
  const ui = await mount();
  const review = ui.stageButtons.find(button => button.dataset.stage === "revisao")!;
  review.focus();
  ui.applyStageDom("revisao");

  expect(ui.document.activeElement).toBe(ui.close);
  ui.keydown("Escape");
  expect({ inert: ui.monitor.inert, active: ui.document.activeElement }).toEqual({ inert: true, active: review });
});

it.each(["removido", "oculto", "desabilitado"])("fechar usa o toggle se o acionador Revisão foi %s", async condition => {
  const ui = await mount();
  const review = ui.stageButtons.find(button => button.dataset.stage === "revisao")!;
  review.focus();
  ui.applyStageDom("revisao");
  if (condition === "removido") review.isConnected = false;
  if (condition === "oculto") review.hidden = true;
  if (condition === "desabilitado") review.disabled = true;

  ui.keydown("Escape");
  expect(ui.document.activeElement).toBe(ui.toggle);
});

it("redimensionar alterna inert e mantém o foco fora do monitor", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.media.matches = false;
  for (const listener of ui.mediaListeners) listener();
  expect({ inert: ui.monitor.inert, open: ui.body.classList.contains("monitor-open"), active: ui.document.activeElement })
    .toEqual({ inert: false, open: false, active: ui.player });

  ui.media.matches = true;
  for (const listener of ui.mediaListeners) listener();
  expect({ inert: ui.monitor.inert, open: ui.body.classList.contains("monitor-open"), active: ui.document.activeElement })
    .toEqual({ inert: true, open: false, active: ui.toggle });
});

it("desktop desativa inert sem tirar foco do controle visível que já estava ativo", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.player.focus();
  ui.media.matches = false;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, open: ui.body.classList.contains("monitor-open"), active: ui.document.activeElement })
    .toEqual({ inert: false, open: false, active: ui.player });
});

it("resize mobile para desktop usa o último foco do monitor após o browser focar body", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.blurToBody();
  ui.media.matches = false;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, active: ui.document.activeElement }).toEqual({ inert: false, active: ui.player });
});

it("resize desktop para mobile devolve o foco ao toggle após o browser focar body", async () => {
  const ui = await mount(1200);
  ui.player.focus();
  ui.blurToBody();
  ui.media.matches = true;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, active: ui.document.activeElement }).toEqual({ inert: true, active: ui.toggle });
});

it("foco legítimo externo limpa a memória do monitor antes do resize", async () => {
  const ui = await mount(1200);
  const review = ui.stageButtons.find(button => button.dataset.stage === "revisao")!;
  ui.player.focus();
  review.focus();
  ui.blurToBody();
  ui.media.matches = true;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, active: ui.document.activeElement }).toEqual({ inert: true, active: ui.body });
});

it("desktop pula player oculto e foca o próximo controle visível habilitado", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.close.hidden = true;
  ui.player.hidden = true;
  ui.media.matches = false;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, active: ui.document.activeElement }).toEqual({ inert: false, active: ui.briefing });
});

it("desktop foca o painel quando todos os controles estão indisponíveis", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.close.hidden = true;
  ui.player.disabled = true;
  ui.briefing.disabled = true;
  ui.media.matches = false;
  for (const listener of ui.mediaListeners) listener();

  expect({ inert: ui.monitor.inert, tabIndex: ui.monitor.tabIndex, active: ui.document.activeElement })
    .toEqual({ inert: false, tabIndex: -1, active: ui.monitor });
});

it("abrir novamente durante rerender não rouba foco", async () => {
  const ui = await mount();
  ui.toggle.click();
  ui.player.focus();
  ui.showMonitor(true);
  expect(ui.document.activeElement).toBe(ui.player);
});

it.each([1024, 390])("breakpoint estreito inclui largura %i px no estado inerte inicial", async width => {
  const ui = await mount(width);
  expect(ui.media.query).toBe("(max-width: 1100px)");
  expect(ui.monitor.inert).toBe(true);
  expect(ui.toggle.getAttribute("aria-expanded")).toBe("false");
});

it("desktop começa sem inert", async () => {
  const ui = await mount(1101);
  expect(ui.media.query).toBe("(max-width: 1100px)");
  expect(ui.monitor.inert).toBe(false);
});

// DOM mínimo compartilhado pelos testes de fiação do editor.
// Não é suíte: o nome não casa com o include do vitest.
import { vi } from "vitest";

type Listener = (event: FakeEvent) => void;

export type FakeEvent = {
  type: string;
  target: El | null;
  currentTarget: El | null;
  clientX: number;
  clientY: number;
  button: number;
  pointerType: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  bubbles: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};

export type FakeDocument = {
  body: El;
  activeElement: El | null;
  createElement: (tag: string) => El;
  getElementById: (id: string) => El | null;
  querySelector: (selector: string) => El | null;
  querySelectorAll: (selector: string) => El[];
  addEventListener: (type: string, fn: Listener) => void;
  removeEventListener: (type: string, fn: Listener) => void;
  dispatchEvent: (event: Partial<FakeEvent> & { type: string }) => void;
};

const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));

let current: FakeDocument | null = null;

export type FakeWindow = {
  innerWidth: number;
  innerHeight: number;
  location: { assign: ReturnType<typeof vi.fn>; hash: string; pathname: string; search: string };
  confirm: ReturnType<typeof vi.fn>;
  dispatchEvent: () => void;
  addEventListener: () => void;
  devicePixelRatio: number;
};

let currentWindow: FakeWindow | null = null;

export function domWindow(): FakeWindow {
  if (!currentWindow) throw new Error("installDom ainda não rodou");
  return currentWindow;
}

export class El {
  readonly tag: string;
  className = "";
  value: string | number = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  textContent = "";
  scrollTop = 0;
  title = "";
  parentElement: El | null = null;
  children: El[] = [];
  onclick: Listener | null = null;
  onsubmit: Listener | null = null;
  onchange: Listener | null = null;
  oninput: Listener | null = null;
  onerror: Listener | null = null;
  showCount = 0;
  clientWidth = 0;
  clientHeight = 0;
  currentTime = 0;
  duration = Number.NaN;
  seeking = false;
  playbackRate = 1;
  readyState = 0;
  controls = false;
  preload = "";
  readonly played = { length: 0, start: () => 0, end: () => 0 };
  readonly dataset: Record<string, string | undefined>;
  readonly style: Record<string, string> & { setProperty: (name: string, value: string) => void };
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  private rect = { left: 0, top: 0, right: 80, bottom: 20, width: 80, height: 20 };

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
    const bag: Record<string, string> = {};
    this.style = new Proxy(bag, {
      get: (target, key) => {
        if (key === "setProperty") return (prop: string, val: string) => { target[prop] = val; };
        return target[String(key)] ?? "";
      },
      set: (target, key, val) => {
        if (key === "cssText") {
          target.cssText = String(val);
          return true;
        }
        target[String(key)] = String(val);
        return true;
      },
    }) as El["style"];
  }

  get id() { return this.attrs.get("id") ?? ""; }
  set id(value: string) { this.attrs.set("id", value); }
  get type() { return this.attrs.get("type") ?? ""; }
  set type(value: string) { this.attrs.set("type", value); }
  get src() { return this.attrs.get("src") ?? ""; }
  set src(value: string) { this.attrs.set("src", value); }
  get tagName() { return this.tag.toUpperCase(); }
  get childElementCount() { return this.children.length; }
  get isConnected() {
    return chainFrom(this).some((node) => node === current?.body);
  }

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
  setAttribute(key: string, value: string) { this.attrs.set(key, String(value)); }
  hasAttribute(key: string) { return this.attrs.has(key); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== fn));
  }

  dispatchEvent(event: Partial<FakeEvent> & { type: string }) {
    let stopped = false;
    const full = {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
      key: "",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      currentTarget: null,
      ...event,
      target: event.target ?? this,
      preventDefault() { full.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
    } as FakeEvent;
    const chain: Array<El | null> = chainFrom(this);
    if (full.bubbles !== false) chain.push(null);
    for (const node of chain) {
      full.currentTarget = node;
      if (node) {
        for (const fn of node.listeners.get(full.type) ?? []) fn(full);
        const direct = directHandler(node, full.type);
        if (direct) direct(full);
      } else if (current) {
        for (const fn of currentListeners.get(full.type) ?? []) fn(full);
      }
      if (stopped) break;
    }
  }

  focus() { if (current) current.activeElement = this; }
  blur() { if (current?.activeElement === this) current.activeElement = null; }
  remove() { this.detach(); }
  click() { this.dispatchEvent({ type: "click" }); }
  getBoundingClientRect() { return { ...this.rect }; }
  setPointerCapture() {}
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  showModal() { this.open = true; this.showCount += 1; }
  close() {
    const was = this.open;
    this.open = false;
    if (was) this.dispatchEvent({ type: "close", bubbles: false });
  }

  append(...nodes: Array<El | string>) { for (const node of nodes) this.appendChild(asEl(node)); }
  prepend(...nodes: Array<El | string>) {
    for (const node of [...nodes].reverse()) this.insertBefore(asEl(node), this.children[0] ?? null);
  }
  appendChild(node: El) { node.detach(); node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node: El, ref: El | null) {
    node.detach();
    node.parentElement = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  replaceChildren(...nodes: Array<El | string>) {
    while (this.children.length) this.children[0]!.detach();
    for (const node of nodes) this.appendChild(asEl(node));
    if (this.tag === "select") {
      const options = this.children.filter((child) => child.tag === "option");
      if (options.length && !options.some((child) => String(child.value) === String(this.value))) {
        this.value = options[0]!.value;
      }
    }
  }
  detach() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node: El | null) { for (let cur: El | null = node; cur; cur = cur.parentElement) if (cur === this) return true; return false; }
  closest(selector: string) {
    return chainFrom(this).find((node) => matches(node, selector)) ?? null;
  }
  querySelector(selector: string) { return queryAll(this, selector)[0] ?? null; }
  querySelectorAll(selector: string) { return queryAll(this, selector); }
}

export class Option extends El {
  constructor(text = "", value = "") {
    super("option");
    this.textContent = text;
    this.value = value;
    this.setAttribute("value", value);
  }
}

/** Do nó até a raiz, inclusive. */
function chainFrom(start: El): El[] {
  const chain: El[] = [];
  let node: El | null = start;
  while (node) {
    chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

function asEl(node: El | string): El {
  if (typeof node !== "string") return node;
  const text = new El("span");
  text.textContent = node;
  return text;
}

function directHandler(node: El, type: string): Listener | null {
  if (type === "click") return node.onclick;
  if (type === "submit") return node.onsubmit;
  if (type === "change") return node.onchange;
  if (type === "input") return node.oninput;
  return null;
}

const currentListeners = new Map<string, Listener[]>();

function applyAttrs(el: El, raw: string) {
  for (const match of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1];
    if (!name || name === "/") continue;
    const quoted = match[2] ?? match[3] ?? match[4];
    if (name === "class") el.className = quoted ?? "";
    else if (name === "id") el.id = quoted ?? "";
    else el.setAttribute(name, quoted ?? "");
    if (name === "value" && quoted !== undefined) el.value = quoted;
    if (name === "type" && quoted !== undefined) el.type = quoted;
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
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.tag === tag) { stack.length = index; break; }
      }
      continue;
    }
    const el = new El((match[2] ?? "").toLowerCase());
    applyAttrs(el, match[3] ?? "");
    stack[stack.length - 1]!.appendChild(el);
    if (match[4] !== "/" && !VOID.has(el.tag)) stack.push(el);
  }
}

function descendants(root: El): El[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function matches(el: El, part: string) {
  let src = part;
  const not = src.match(/:not\(([^)]*)\)/);
  if (not) {
    src = src.replace(not[0], "");
    const inner = not[1] ?? "";
    const hit = inner === ":disabled" ? el.disabled : matches(el, inner);
    if (hit) return false;
  }
  if (src.endsWith(":disabled")) {
    if (!el.disabled) return false;
    src = src.slice(0, -":disabled".length);
  }
  if (src.endsWith(":checked")) {
    if (!el.checked) return false;
    src = src.slice(0, -":checked".length);
  }
  for (const attr of src.matchAll(/\[([^\]=\s]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
    const actual = el.getAttribute(attr[1] ?? "");
    const expected = attr[2] ?? attr[3];
    if (expected === undefined ? actual === null : actual !== expected) return false;
  }
  src = src.replace(/\[[^\]]*\]/g, "");
  const id = src.match(/#([A-Za-z0-9_-]+)/)?.[1];
  if (id && el.id !== id) return false;
  src = src.replace(/#[A-Za-z0-9_-]+/g, "");
  if ([...src.matchAll(/\.([A-Za-z0-9_-]+)/g)].some((item) => !el.classList.contains(item[1] ?? ""))) return false;
  const tag = src.replace(/\.[A-Za-z0-9_-]+/g, "");
  return !tag || el.tag === tag;
}

/** Partes de um seletor, sem cortar espaços dentro de aspas ou colchetes. */
function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let bracket = 0;
  for (const ch of selector.trim()) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") bracket += 1;
    if (ch === "]") bracket = Math.max(0, bracket - 1);
    if (/\s/.test(ch) && bracket === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function queryAll(root: El, selector: string) {
  let scope = [root];
  for (const part of selectorParts(selector)) {
    scope = scope.flatMap((base) => descendants(base).filter((el) => matches(el, part)));
  }
  return scope;
}

function findId(node: El, id: string): El | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findId(child, id);
    if (found) return found;
  }
  return null;
}

export function installDom(html = "", opts: { autoIds?: boolean } = {}): FakeDocument {
  currentListeners.clear();
  const body = new El("body");
  const document: FakeDocument = {
    body,
    activeElement: null,
    createElement: (tag: string) => tag === "option" ? new Option() : new El(tag),
    getElementById: (id: string) => {
      const found = findId(body, id);
      if (found || !opts.autoIds) return found;
      const el = new El("div");
      el.id = id;
      body.appendChild(el);
      return el;
    },
    querySelector: (selector: string) => queryAll(body, selector)[0] ?? null,
    querySelectorAll: (selector: string) => queryAll(body, selector),
    addEventListener: (type, fn) => { currentListeners.set(type, [...currentListeners.get(type) ?? [], fn]); },
    removeEventListener: (type, fn) => {
      currentListeners.set(type, (currentListeners.get(type) ?? []).filter((item) => item !== fn));
    },
    dispatchEvent: (event) => { body.dispatchEvent({ ...event, target: event.target ?? body }); },
  };
  current = document;
  const window: FakeWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    location: { assign: vi.fn(), hash: "", pathname: "/", search: "" },
    confirm: vi.fn(() => true),
    dispatchEvent: () => {},
    addEventListener: () => {},
    devicePixelRatio: 1,
  };
  currentWindow = window;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("CustomEvent", class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; }
  });
  vi.stubGlobal("HTMLElement", class HTMLElement {});
  vi.stubGlobal("Element", class Element {});
  vi.stubGlobal("Option", Option);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })));
  vi.stubGlobal("getComputedStyle", () => ({ color: "#888" }));
  if (html) body.innerHTML = html;
  return document;
}

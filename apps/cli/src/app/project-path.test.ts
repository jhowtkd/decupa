import { expect, it } from "vitest";
import { createTabIdentity } from "./project-path.js";

class SharedChannel {
  static peers: SharedChannel[] = [];
  private listener: ((event: { data: unknown }) => void) | null = null;
  constructor() { SharedChannel.peers.push(this); }
  addEventListener(_type: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
  postMessage(data: unknown) {
    for (const peer of SharedChannel.peers) if (peer !== this) peer.listener?.({ data });
  }
}

class DelayedChannel {
  static peers: DelayedChannel[] = [];
  private listener: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly delayMs: number) { DelayedChannel.peers.push(this); }
  addEventListener(_type: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
  postMessage(data: unknown) {
    for (const peer of DelayedChannel.peers) {
      if (peer === this) continue;
      setTimeout(() => peer.listener?.({ data }), this.delayMs);
    }
  }
}

function storage(initial: string) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

it("regenera o id quando duas páginas começam com o mesmo sessionStorage", async () => {
  SharedChannel.peers = [];
  let sequence = 0;
  const idFactory = () => `id-${++sequence}`;
  const first = createTabIdentity({ storage: storage("copiado"), channel: new SharedChannel(), idFactory });
  const second = createTabIdentity({ storage: storage("copiado"), channel: new SharedChannel(), idFactory });
  await Promise.all([first.ready, second.ready]);

  expect(first.get()).toBe("copiado");
  expect(second.get()).not.toBe(first.get());
});

it("aguarda a resposta assíncrona de conflito antes de liberar a página", async () => {
  DelayedChannel.peers = [];
  let sequence = 0;
  const idFactory = () => `id-${++sequence}`;
  const first = createTabIdentity({ storage: storage("copiado"), channel: new DelayedChannel(10), idFactory });
  const second = createTabIdentity({ storage: storage("copiado"), channel: new DelayedChannel(10), idFactory });

  await Promise.all([first.ready, second.ready]);

  expect(second.get()).not.toBe(first.get());
});

it("notifica quando a resposta de conflito muda o id depois da prontidão", async () => {
  DelayedChannel.peers = [];
  let sequence = 0;
  const idFactory = () => `id-${++sequence}`;
  const first = createTabIdentity({ storage: storage("copiado"), channel: new DelayedChannel(30), idFactory });
  const second = createTabIdentity({ storage: storage("copiado"), channel: new DelayedChannel(30), idFactory });
  const changes: Array<{ next: string; previous: string }> = [];
  const onChange = (second as unknown as {
    onChange: (listener: (next: string, previous: string) => void) => () => void;
  }).onChange;
  onChange((next, previous) => changes.push({ next, previous }));

  await Promise.all([first.ready, second.ready]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(changes).toHaveLength(1);
  expect(changes[0].previous).toBe("copiado");
  expect(changes[0].next).toBe(second.get());
});

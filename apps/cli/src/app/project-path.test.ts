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

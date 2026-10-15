import { describe, expect, it } from "vitest";
import { hostAllowed, originAllowed } from "./origin.ts";

describe("originAllowed", () => {
  it("aceita a própria página, nas duas formas de escrever o host", () => {
    expect(originAllowed("http://127.0.0.1:7788", 7788)).toBe(true);
    expect(originAllowed("http://localhost:7788", 7788)).toBe(true);
  });

  it("aceita quem não manda Origin — curl, fetch de script, o SKILL", () => {
    expect(originAllowed(undefined, 7788)).toBe(true);
  });

  it("recusa outra página aberta na mesma máquina", () => {
    // É a única superfície de ataque real de um servidor em 127.0.0.1: o
    // navegador da própria pessoa, com um site qualquer aberto noutra aba.
    expect(originAllowed("https://exemplo.invalido", 7788)).toBe(false);
    expect(originAllowed("http://127.0.0.1:9999", 7788)).toBe(false);
  });

  it("recusa origem opaca", () => {
    // "null" chega de iframe sandbox e de file://; é origem sem dono.
    expect(originAllowed("null", 7788)).toBe(false);
  });
});

describe("hostAllowed", () => {
  it("só aceita 127.0.0.1 e localhost nesta porta", async () => {
    // Import dinâmico: no código anterior o export não existe e o arquivo
    // de teste ainda carrega os casos de Origin.
    const { hostAllowed } = await import("./origin.ts");
    expect(hostAllowed).toEqual(expect.any(Function));
    expect(hostAllowed("127.0.0.1:7788", 7788)).toBe(true);
    expect(hostAllowed("localhost:7788", 7788)).toBe(true);
    expect(hostAllowed("LocalHost:7788", 7788)).toBe(true);
    expect(hostAllowed("127.0.0.1:9", 7788)).toBe(false);
    expect(hostAllowed("attacker.example:7788", 7788)).toBe(false);
    expect(hostAllowed(undefined, 7788)).toBe(false);
  });

  it("aceita host configurado sem porta na forma omitida, padrão e da porta do servidor", () => {
    const config = { allowedHosts: "decupa.studio" };
    expect(hostAllowed("decupa.studio", 7788, config)).toBe(true);
    expect(hostAllowed("decupa.studio:80", 7788, config)).toBe(true);
    expect(hostAllowed("decupa.studio:443", 7788, config)).toBe(true);
    expect(hostAllowed("decupa.studio:7788", 7788, config)).toBe(true);
    expect(hostAllowed("decupa.studio:7789", 7788, config)).toBe(false);
  });

  it("exige a porta exata quando ela foi declarada e trata IPv6", () => {
    expect(hostAllowed("decupa.studio:8443", 7788, { allowedHosts: "decupa.studio:8443" })).toBe(true);
    expect(hostAllowed("decupa.studio", 7788, { allowedHosts: "decupa.studio:8443" })).toBe(false);
    expect(hostAllowed("[::1]", 7788, { allowedHosts: "[::1]" })).toBe(true);
    expect(hostAllowed("[::1]:80", 7788, { allowedHosts: "[::1]" })).toBe(true);
    expect(hostAllowed("[::1]:7788", 7788, { allowedHosts: "[::1]" })).toBe(true);
    expect(hostAllowed("[::1]:7789", 7788, { allowedHosts: "[::1]" })).toBe(false);
  });

  it("deriva origens HTTP e HTTPS dos hosts e respeita o proxy", () => {
    const config = { allowedHosts: "decupa.studio", trustProxy: true };
    expect(originAllowed("https://decupa.studio", 7788, config, { headers: { "x-forwarded-proto": "https" } })).toBe(true);
    expect(originAllowed("http://decupa.studio", 7788, config, { headers: { "x-forwarded-proto": "https" } })).toBe(false);
    expect(originAllowed("http://decupa.studio", 7788, { allowedHosts: "decupa.studio" }, { headers: { "x-forwarded-proto": "https" } })).toBe(true);
  });

  it("mantém as origens locais permitidas mesmo com lista explícita", () => {
    const config = { allowedOrigins: "https://decupa.studio" };
    expect(originAllowed("http://localhost:7788", 7788, config)).toBe(true);
    expect(originAllowed("http://127.0.0.1:7788", 7788, config)).toBe(true);
    expect(originAllowed("http://localhost:7788", 7788, { ...config, trustProxy: true }, { headers: { "x-forwarded-proto": "https" } })).toBe(false);
  });

  it("não consulta process.env quando a configuração é injetada", () => {
    const before = process.env.DECUPA_ALLOWED_HOSTS;
    process.env.DECUPA_ALLOWED_HOSTS = "vazamento.example";
    try {
      expect(hostAllowed("outro.example", 7788, { allowedHosts: undefined })).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DECUPA_ALLOWED_HOSTS;
      else process.env.DECUPA_ALLOWED_HOSTS = before;
    }
  });
});

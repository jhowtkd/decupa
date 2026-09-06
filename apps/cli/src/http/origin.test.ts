import { describe, expect, it } from "vitest";
import { originAllowed } from "./origin.ts";

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

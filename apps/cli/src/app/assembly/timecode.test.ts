import { describe, expect, it } from "vitest";
import { nominalRate, parseSourceTimecode, sourceMediaStartSeconds } from "./timecode.ts";

const fps25 = { num: 25, den: 1 };
const fps2997 = { num: 30000, den: 1001 };
const fps5994 = { num: 60000, den: 1001 };

describe("nominalRate", () => {
  it("mapeia taxas NTSC para o nominal", () => {
    expect(nominalRate({ num: 30000, den: 1001 })).toBe(30);
    expect(nominalRate({ num: 60000, den: 1001 })).toBe(60);
    expect(nominalRate({ num: 24000, den: 1001 })).toBe(24);
    expect(nominalRate({ num: 25, den: 1 })).toBe(25);
    expect(nominalRate(null)).toBeNull();
  });
});

describe("parseSourceTimecode NDF", () => {
  it("hora cheia a 25 fps vira 90000 quadros de etiqueta", () => {
    expect(parseSourceTimecode("01:00:00:00", fps25))
      .toEqual({ raw: "01:00:00:00", frames: 90000, dropFrame: false });
  });

  it("preserva hora/minuto/segundo/quadro como índice nominal", () => {
    expect(parseSourceTimecode("02:03:04:05", fps25)?.frames)
      .toBe((2 * 3600 + 3 * 60 + 4) * 25 + 5);
  });

  it("a 29.97 NDF o quadro conta na base nominal 30", () => {
    // NDF não pula etiqueta: 1h = 108000 quadros (o tempo real anda 3603.6s).
    expect(parseSourceTimecode("01:00:00:00", fps2997))
      .toEqual({ raw: "01:00:00:00", frames: 108000, dropFrame: false });
  });

  it("zero é um timecode válido (origem explícita)", () => {
    expect(parseSourceTimecode("00:00:00:00", fps25)?.frames).toBe(0);
  });
});

describe("parseSourceTimecode drop-frame", () => {
  it("';' a 29.97 pula 2 etiquetas por minuto não múltiplo de 10", () => {
    // 1h DF = 3600s reais = 107892 quadros (60 min, 54 não múltiplos de 10).
    expect(parseSourceTimecode("01:00:00;00", fps2997))
      .toEqual({ raw: "01:00:00;00", frames: 107892, dropFrame: true });
  });

  it("primeiro minuto DF não tem etiquetas 00 e 01", () => {
    expect(parseSourceTimecode("00:01:00;02", fps2997)?.frames).toBe(1800);
    expect(parseSourceTimecode("00:01:00;00", fps2997)?.frames).toBeNull();
    expect(parseSourceTimecode("00:01:00;01", fps2997)?.frames).toBeNull();
  });

  it("minuto múltiplo de 10 aceita quadros 00 e 01", () => {
    expect(parseSourceTimecode("00:10:00;00", fps2997)?.frames)
      .toBe((10 * 60 * 30) - 2 * (10 - 1));
  });

  it("a 59.94 pula 4 etiquetas por minuto não múltiplo de 10", () => {
    expect(parseSourceTimecode("00:01:00;04", fps5994)?.frames).toBe(3600);
    expect(parseSourceTimecode("00:01:00;00", fps5994)?.frames).toBeNull();
  });

  it("';' fora de taxa NTSC não é drop-frame", () => {
    expect(parseSourceTimecode("01:00:00;00", fps25)?.frames).toBeNull();
  });
});

describe("parseSourceTimecode inválido", () => {
  it.each([
    "lixo", "1:2:3:4:5", "01:00", "ab:00:00:00",
    "24:00:00:00", "01:60:00:00", "01:00:60:00",
    "01:00:00:25", // quadro >= nominal a 25 fps
    "01:00:00:30", // quadro >= nominal a 29.97
  ])("%s → frames null", (raw) => {
    expect(parseSourceTimecode(raw, fps25)?.frames).toBeNull();
  });

  it("01:00:00:25 é válido a 30 fps", () => {
    expect(parseSourceTimecode("01:00:00:25", fps2997)?.frames)
      .toBe(108000 + 25);
  });

  it("sem taxa de quadros não dá para converter", () => {
    expect(parseSourceTimecode("01:00:00:00", null)?.frames).toBeNull();
  });

  it("raw inválido preserva o texto para diagnóstico", () => {
    const parsed = parseSourceTimecode("xyz", fps25);
    expect(parsed?.raw).toBe("xyz");
    expect(parsed?.frames).toBeNull();
  });
});

describe("sourceMediaStartSeconds", () => {
  it("converte quadros de etiqueta para segundos na taxa real", () => {
    // 90000 quadros a 25 fps = 3600 s.
    expect(sourceMediaStartSeconds({
      fps: fps25,
      timecode: { raw: "01:00:00:00", frames: 90000, dropFrame: false },
    })).toBeCloseTo(3600);
    // DF: 107892 quadros a 30000/1001 ≈ 3600 s — a etiqueta aproxima a
    // hora real com erro de ~3,6 ms por hora (conhecido do drop-frame).
    expect(sourceMediaStartSeconds({
      fps: fps2997,
      timecode: { raw: "01:00:00;00", frames: 107892, dropFrame: true },
    })).toBeCloseTo(3600, 2);
  });

  it("sem timecode ou sem fps volta null (origem zero)", () => {
    expect(sourceMediaStartSeconds({ fps: fps25 })).toBeNull();
    expect(sourceMediaStartSeconds({
      fps: fps25,
      timecode: { raw: "lixo", frames: null, dropFrame: false },
    })).toBeNull();
    expect(sourceMediaStartSeconds({
      fps: null,
      timecode: { raw: "01:00:00:00", frames: 90000, dropFrame: false },
    })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { buildEdl, timecode } from "./edl.ts";

describe("timecode", () => {
  it("zero é 00:00:00:00", () => {
    expect(timecode(0, 30)).toBe("00:00:00:00");
  });

  it("um segundo a 30fps", () => {
    expect(timecode(1, 30)).toBe("00:00:01:00");
  });

  it("converte fração de segundo em quadro", () => {
    // 25,318s × 30 = 759,54 → quadro 760 → 25s + quadro 10
    expect(timecode(25.318, 30)).toBe("00:00:25:10");
  });

  it("passa de minuto e de hora", () => {
    expect(timecode(61, 25)).toBe("00:01:01:00");
    expect(timecode(3661, 25)).toBe("01:01:01:00");
  });

  it("não deixa o quadro chegar ao valor do fps", () => {
    // 0,999s a 30fps arredonda para 30 quadros, que é 1s exato, não ":30"
    expect(timecode(0.999, 30)).toBe("00:00:01:00");
  });
});

describe("buildEdl", () => {
  const clips = [
    { start: 25.318, end: 28.436 },
    { start: 31.956, end: 35.141 },
  ];

  it("abre com título e FCM não-drop-frame", () => {
    const edl = buildEdl({ clips, fps: 30, title: "corte" });
    expect(edl).toContain("TITLE: corte");
    expect(edl).toContain("FCM: NON-DROP FRAME");
  });

  it("numera os eventos a partir de 001", () => {
    const edl = buildEdl({ clips, fps: 30, title: "c" });
    expect(edl).toMatch(/^001\s+AX\s+V\s+C\s+/m);
    expect(edl).toMatch(/^002\s+AX\s+V\s+C\s+/m);
  });

  it("usa o tempo de fonte de cada clipe como source in/out", () => {
    const edl = buildEdl({ clips, fps: 30, title: "c" });
    expect(edl).toContain("00:00:25:10 00:00:28:13");
  });

  it("encadeia o record timecode sem buraco entre eventos", () => {
    // Números conferidos rodando a conta, não estimados:
    //   clipe 1: round(28.436×30) − round(25.318×30) = 853 − 760 = 93 quadros
    //   clipe 2: round(35.141×30) − round(31.956×30) = 1054 − 959 = 95 quadros
    // O record do evento 2 começa exatamente onde o do evento 1 terminou.
    const linhas = buildEdl({ clips, fps: 30, title: "c" })
      .split("\n").filter((l) => /^\d{3}\s/.test(l));
    expect(linhas[0]).toContain("00:00:00:00 00:00:03:03");
    expect(linhas[1]!).toContain("00:00:03:03 00:00:06:08");
  });

  it("a duração no record bate com a duração na fonte, quadro a quadro", () => {
    // Se estes dois divergirem, o Resolve importa com buraco ou sobreposição.
    const linhas = buildEdl({ clips, fps: 30, title: "c" })
      .split("\n").filter((l) => /^\d{3}\s/.test(l));
    const frames = (tc: string) => {
      const [h, m, s, f] = tc.split(":").map(Number);
      return ((h! * 60 + m!) * 60 + s!) * 30 + f!;
    };
    for (const linha of linhas) {
      const [srcIn, srcOut, recIn, recOut] = linha.trim().split(/\s+/).slice(4);
      expect(frames(srcOut!) - frames(srcIn!)).toBe(frames(recOut!) - frames(recIn!));
    }
  });

  it("recusa frame rate fracionário em vez de gerar timecode errado", () => {
    expect(() => buildEdl({ clips, fps: 29.97, title: "c" })).toThrow(/29\.97|inteiro/);
  });

  it("nomeia o arquivo de origem em cada evento", () => {
    // `AX` no campo de reel significa "sem reel atribuído": o EDL não diz de
    // que arquivo os cortes vieram, e o relink na NLE vira apontar na mão.
    // `* FROM CLIP NAME:` é como o formato carrega isso — o campo de reel tem
    // 8 caracteres e não cabe nome de arquivo.
    const edl = buildEdl({ clips, fps: 30, title: "c", sourceName: "proxy.mp4" });
    expect(edl.match(/^\* FROM CLIP NAME: proxy\.mp4$/gm)).toHaveLength(2);
  });

  it("põe o nome logo depois do evento a que pertence", () => {
    const linhas = buildEdl({ clips, fps: 30, title: "c", sourceName: "a.mp4" })
      .split("\n").filter((l) => /^(\d{3}|\* FROM)/.test(l));
    expect(linhas.map((l) => l.slice(0, 6)))
      .toEqual(["001  A", "* FROM", "002  A", "* FROM"]);
  });

  it("cai no título quando não recebe nome de origem", () => {
    expect(buildEdl({ clips, fps: 30, title: "aula.mp4" }))
      .toContain("* FROM CLIP NAME: aula.mp4");
  });

  it("recusa lista de clipes vazia", () => {
    expect(() => buildEdl({ clips: [], fps: 30, title: "c" })).toThrow(/nenhum clipe/);
  });
});

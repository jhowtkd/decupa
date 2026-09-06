import { describe, expect, it } from "vitest";
import { JobStore } from "./jobs.ts";

const review = { units: [], joins: [], outputSeconds: 0, sourceSeconds: 0 };

describe("JobStore", () => {
  it("cria o job em `queued` com id próprio", () => {
    const store = new JobStore();
    const job = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    expect(job.stage).toBe("queued");
    expect(job.id).toMatch(/\S/);
  });

  it("dá ids diferentes a jobs diferentes", () => {
    const store = new JobStore();
    const a = store.create({ videoPath: "/a.mp4", workDir: "/w" });
    const b = store.create({ videoPath: "/b.mp4", workDir: "/w" });
    expect(a.id).not.toBe(b.id);
  });

  it("devolve undefined para id que não existe", () => {
    expect(new JobStore().get("nada")).toBeUndefined();
  });

  it("avança de estágio", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setStage(id, "transcribing");
    expect(store.get(id)!.stage).toBe("transcribing");
    store.setStage(id, "visual");
    expect(store.get(id)!.stage).toBe("visual");
  });

  it("guarda aviso sem mudar o estágio", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setWarning(id, "sidecar de visão não instalado, segue sem visual");
    expect(store.get(id)!.warning).toMatch(/visão/);
    expect(store.get(id)!.stage).toBe("queued");
  });

  it("guarda o review e vai para `ready`", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setReview(id, review, "u001-u003");
    expect(store.get(id)!.stage).toBe("ready");
    expect(store.get(id)!.keepList).toBe("u001-u003");
  });

  it("falhar guarda a mensagem e vai para `error`", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.fail(id, "ffmpeg não encontrado");
    expect(store.get(id)!.stage).toBe("error");
    expect(store.get(id)!.error).toBe("ffmpeg não encontrado");
  });

  it("não deixa um job que falhou voltar a avançar", () => {
    // Uma etapa que termina depois do erro não pode apagar o erro da tela.
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.fail(id, "morreu");
    store.setStage(id, "planning");
    expect(store.get(id)!.stage).toBe("error");
  });

  it("cancelar é terminal do mesmo jeito", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.cancel(id);
    store.setStage(id, "indexing");
    expect(store.get(id)!.stage).toBe("cancelled");
  });

  it("erro depois de cancelar não vira `error` na tela", () => {
    // Matar o processo faz a etapa em andamento falhar. Se esse erro
    // sobrescrevesse o cancelamento, a pessoa cancelaria, esperaria, e a tela
    // acabaria dizendo "erro: ..." como se algo tivesse dado errado.
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.cancel(id);
    store.fail(id, "SIGTERM");
    expect(store.get(id)!.stage).toBe("cancelled");
    expect(store.get(id)!.error).toBeUndefined();
  });

  it("ignora operação em id inexistente sem estourar", () => {
    expect(() => new JobStore().setStage("nada", "indexing")).not.toThrow();
  });

  it("mudar de estágio limpa o progresso do estágio anterior", () => {
    // A última linha do WhisperX não descreve o que o índice está fazendo. Deixar
    // ali é pior que não mostrar nada: parece informação atual.
    const store = new JobStore();
    const job = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setProgress(job.id, "97%|=====> | 58/60");
    expect(store.get(job.id)!.progress).toBe("97%|=====> | 58/60");
    store.setStage(job.id, "indexing");
    expect(store.get(job.id)!.progress).toBeUndefined();
  });

  it("trunca o progresso em 120 caracteres para não quebrar a tela", () => {
    const store = new JobStore();
    const job = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setProgress(job.id, "a".repeat(200));
    expect(store.get(job.id)!.progress).toBe("a".repeat(120));
  });
});


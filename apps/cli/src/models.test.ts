import { expect, it, vi } from "vitest";
import { runModelsFetch } from "./models.ts";

it("baixa os modelos de fala pelo preparo do sidecar", async () => {
  const execute = vi.fn(async () => undefined);

  await runModelsFetch({ execute });

  expect(execute).toHaveBeenCalledWith(
    "uv",
    ["run", "--no-sync", "python", "transcribe.py", "--prepare-models"],
    expect.stringMatching(/[\\/]services[\\/]speech$/),
  );
});

it("transforma falha de rede ou de espaço numa mensagem acionável", async () => {
  const execute = vi.fn(async () => {
    throw new Error("uv: falha de rede");
  });

  await expect(runModelsFetch({ execute })).rejects.toThrow(
    "não foi possível baixar os modelos de fala",
  );
  await expect(runModelsFetch({ execute })).rejects.toThrow(/rede|espaço/);
});

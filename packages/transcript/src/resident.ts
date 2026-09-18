import type { FileCoordinator } from "@decupa/coordinator";

export async function runSpeechJob<T>(
  coordinator: FileCoordinator,
  opts: { id: string; signal?: AbortSignal; build: () => Promise<T> | T },
): Promise<T> {
  return coordinator.run({
    id: opts.id,
    stage: "speech",
    signal: opts.signal,
    build: opts.build,
  });
}

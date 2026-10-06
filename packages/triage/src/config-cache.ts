import { stat } from "node:fs/promises";

/** Cache por arquivo, não por operação: cada operação recebe seu próprio snapshot. */
export function mtimeCached<T>(load: (path: string) => Promise<T>) {
  const files = new Map<string, { stamp: string; value: Promise<T> }>();
  const read = async (path: string): Promise<T> => {
    const info = await stat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    // ctime/ino também detectam substituição ou escrita com mtime preservado.
    const stamp = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}` : "missing";
    let cached = files.get(path);
    if (!cached || cached.stamp !== stamp) {
      cached = { stamp, value: load(path) };
      files.set(path, cached);
    }
    return structuredClone(await cached.value);
  };
  // Escritas próprias não dependem da resolução de timestamp do filesystem.
  return Object.assign(read, { invalidate: (path: string): void => { files.delete(path); } });
}

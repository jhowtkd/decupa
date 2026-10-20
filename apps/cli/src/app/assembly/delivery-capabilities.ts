import { stat } from "node:fs/promises";
import { join } from "node:path";

export type DeliveryCapabilities = { resolve: boolean; primary: "resolve" | "package" };
/** Detect installation only. Scripting readiness and import compatibility remain bridge checks. */
export async function detectDeliveryCapabilities(options: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isFile?: (path: string) => Promise<boolean>;
} = {}): Promise<DeliveryCapabilities> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (env.DECUPA_RESOLVE === "0" || env.DECUPA_RESOLVE === "1") {
    const resolve = env.DECUPA_RESOLVE === "1";
    return { resolve, primary: resolve ? "resolve" : "package" };
  }
  const isFile = options.isFile ?? (async path => (await stat(path).catch(() => null))?.isFile() === true);
  const candidates = platform === "darwin"
    ? ["/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve"]
    : platform === "win32"
      ? [join(env.ProgramFiles ?? "C:\\Program Files", "Blackmagic Design", "DaVinci Resolve", "Resolve.exe")]
      : ["/opt/resolve/bin/resolve", "/opt/resolve/resolve"];
  for (const path of candidates) if (await isFile(path)) return { resolve: true, primary: "resolve" };
  return { resolve: false, primary: "package" };
}

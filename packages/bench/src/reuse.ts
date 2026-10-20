import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type CacheMetric = {
  stage: "analysis" | "visual" | "proxy";
  sha256: string;
  /** Null means the producer cannot establish a reusable configuration. */
  configKey: string | null;
  outcome: "built" | "hit" | "hit-or-shared" | "error" | "not-applicable";
  /** Measured work time for builds; lookup/wait time for hits. Never interchange them. */
  durationMs: number;
};

export function cacheConfigKey(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function emitCacheMetric(sink: ((metric: CacheMetric) => void) | undefined, metric: CacheMetric): void {
  try { sink?.(metric); } catch { /* Telemetry must not change the work's outcome. */ }
}

export type ReuseGroup = {
  stage: CacheMetric["stage"]; sha256: string; configKey: string;
  projects: number; builds: number; hits: number; errors: number;
  reuseOpportunities: number; redundantBuilds: number;
  estimatedSavingsMs: number; unmeasuredBuilds: number; opportunitiesWithoutBuild: number;
};
type ReuseTotals = {
  reusableDerivatives: number; reuseOpportunities: number; redundantBuilds: number;
  estimatedSavingsMs: number; opportunitiesWithoutBuild: number; unmeasuredBuilds: number;
};
export type ReuseSummary = ReuseTotals & {
  projectsScanned: number; journalsScanned: number; ignoredCacheEvents: number;
  malformedLines: number; unreadableJournals: number;
  byStage: Record<CacheMetric["stage"], ReuseTotals>; groups: ReuseGroup[];
};

const emptyTotals = (): ReuseTotals => ({ reusableDerivatives: 0, reuseOpportunities: 0, redundantBuilds: 0,
  estimatedSavingsMs: 0, opportunitiesWithoutBuild: 0, unmeasuredBuilds: 0 });

type Observation = { project: string; atMs: number; outcome: string; durationMs: number | null };
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
async function directory(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Read-only snapshot of direct projects' operation journals. Never infers identity
 * from paths, operation metadata, coordinator events, or legacy cache events.
 * One opportunity per additional project. Savings count only its first observed
 * successful build (excluding the first successful project), never local retries
 * or hit/shared wait time. This is measured duplicate work, not predicted latency.
 */
export async function summarizeReuseJournals(projectsRoot: string): Promise<ReuseSummary> {
  const summary: ReuseSummary = {
    projectsScanned: 0, journalsScanned: 0, ignoredCacheEvents: 0, malformedLines: 0, unreadableJournals: 0,
    ...emptyTotals(), byStage: { analysis: emptyTotals(), visual: emptyTotals(), proxy: emptyTotals() }, groups: [],
  };
  const groups = new Map<string, { identity: Pick<ReuseGroup, "stage" | "sha256" | "configKey">; observations: Observation[] }>();
  const projects = await readdir(projectsRoot, { withFileTypes: true });
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!project.isDirectory()) continue;
    const hidden = join(projectsRoot, project.name, ".decupa"), dir = join(hidden, "metrics");
    if (!await directory(hidden) || !await directory(dir)) continue;
    summary.projectsScanned += 1;
    let journals;
    try { journals = await readdir(dir, { withFileTypes: true }); }
    catch { summary.unreadableJournals += 1; continue; }
    for (const file of journals.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      summary.journalsScanned += 1;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(join(dir, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            let row;
            try { row = record(JSON.parse(line)); }
            catch { summary.malformedLines += 1; continue; }
            if (row?.kind !== "cache") continue;
            const data = record(row.data);
            if (!data || !["analysis", "visual", "proxy"].includes(String(data.stage))
              || !hash(data.sha256) || !hash(data.configKey)
              || !["built", "hit", "hit-or-shared", "error"].includes(String(data.outcome))
              || typeof row.atMs !== "number" || !Number.isFinite(row.atMs)) {
              summary.ignoredCacheEvents += 1;
              continue;
            }
            const identity = { stage: data.stage as CacheMetric["stage"], sha256: data.sha256.toLowerCase(), configKey: data.configKey.toLowerCase() };
            const key = `${identity.stage}:${identity.sha256}:${identity.configKey}`;
            let group = groups.get(key);
            if (!group) { group = { identity, observations: [] }; groups.set(key, group); }
            group.observations.push({ project: project.name, atMs: row.atMs, outcome: String(data.outcome),
              durationMs: typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : null });
          }
        } finally { lines.close(); }
      } catch { summary.unreadableJournals += 1; }
      finally { await handle?.close().catch(() => undefined); }
    }
  }
  for (const { identity, observations } of groups.values()) {
    observations.sort((a, b) => a.atMs - b.atMs || a.project.localeCompare(b.project));
    const successes = observations.filter(event => event.outcome !== "error");
    const projects = new Set(successes.map(event => event.project));
    const firstProject = successes[0]?.project;
    const counted = new Set<string>();
    const redundant = successes.filter(event => {
      if (event.outcome !== "built" || event.project === firstProject || counted.has(event.project)) return false;
      counted.add(event.project);
      return true;
    });
    const group: ReuseGroup = { ...identity, projects: projects.size,
      builds: observations.filter(event => event.outcome === "built").length,
      hits: observations.filter(event => event.outcome === "hit" || event.outcome === "hit-or-shared").length,
      errors: observations.filter(event => event.outcome === "error").length,
      reuseOpportunities: Math.max(0, projects.size - 1), redundantBuilds: redundant.length,
      estimatedSavingsMs: redundant.reduce((sum, event) => sum + (event.durationMs ?? 0), 0),
      unmeasuredBuilds: redundant.filter(event => event.durationMs === null).length,
      opportunitiesWithoutBuild: Math.max(0, projects.size - 1) - redundant.length,
    };
    summary.groups.push(group);
    for (const totals of [summary, summary.byStage[group.stage]]) {
      if (group.reuseOpportunities > 0) totals.reusableDerivatives += 1;
      totals.reuseOpportunities += group.reuseOpportunities;
      totals.redundantBuilds += group.redundantBuilds;
      totals.estimatedSavingsMs += group.estimatedSavingsMs;
      totals.opportunitiesWithoutBuild += group.opportunitiesWithoutBuild;
      totals.unmeasuredBuilds += group.unmeasuredBuilds;
    }
  }
  summary.groups.sort((a, b) => a.stage.localeCompare(b.stage) || a.sha256.localeCompare(b.sha256) || a.configKey.localeCompare(b.configKey));
  return summary;
}

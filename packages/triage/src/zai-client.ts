import { analysisClientOptions, type AnalysisClientOptions } from "./analysis-client.ts";
import { OpenAiCompatClient } from "./openai-compat.ts";
import { ZAI_DEFAULT_BASE, ZAI_DEFAULT_MODEL } from "./provider.ts";

export type { AnalysisClientOptions };
export { ZAI_DEFAULT_BASE, ZAI_DEFAULT_MODEL };

export {
  isBudgetExhausted,
  isRetryable,
  readChoice,
} from "./openai-compat.ts";
export type { ZaiUsage } from "./openai-compat.ts";

export type ZaiClientOptions = AnalysisClientOptions;

export class ZaiClient {
  private readonly inner: OpenAiCompatClient;

  constructor(opts: ZaiClientOptions = {}) {
    this.inner = new OpenAiCompatClient(analysisClientOptions(opts));
  }

  usage() {
    return this.inner.usage();
  }

  send(content: unknown[], signal?: AbortSignal): Promise<string> {
    return this.inner.send(content, signal);
  }
}

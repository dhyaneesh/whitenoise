export type Scenario = {
  id: string;
  name: string;
  vanillaSteps: { server: string; tool: string; args: Record<string, unknown> }[];
  whitenoiseCode: string;
};

export type ContextComparison = {
  vanilla: { toolCount: number; schemaTokens: number; schemaJson: string };
  whitenoise: { toolCount: number; schemaTokens: number; schemaJson: string };
};

export type BenchmarkResult = {
  vanilla: { latencyMs: number; roundTrips: number; tokensTransferred: number };
  whitenoise: { latencyMs: number; roundTrips: number; tokensTransferred: number };
};

export type RunAllResultItem = {
  scenarioId: string;
  vanilla: BenchmarkResult['vanilla'];
  whitenoise: BenchmarkResult['whitenoise'];
};

export type LLMRunResult = {
  ok: boolean;
  latencyMs: number;
  roundTrips: number;
  promptTokens: number;
  completionTokens: number;
  finalMessage: string | null;
  error?: string;
  messageCount: number;
};

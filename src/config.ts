import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StandupFormat = "markdown" | "slack";

export type LlmProvider =
  | "gemini"
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "ollama"
  | "custom";

export interface LlmProviderInfo {
  id: LlmProvider;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  envVar: string;
  requiresKey: boolean;
}

export const LLM_PROVIDERS: Record<LlmProvider, LlmProviderInfo> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envVar: "GEMINI_API_KEY",
    requiresKey: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    requiresKey: true,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-20250514",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    envVar: "ANTHROPIC_API_KEY",
    requiresKey: true,
  },
  groq: {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    envVar: "GROQ_API_KEY",
    requiresKey: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o-mini",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    requiresKey: true,
  },
  ollama: {
    id: "ollama",
    label: "Ollama (Local)",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    envVar: "OLLAMA_API_KEY",
    requiresKey: false,
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    envVar: "CTX_LLM_API_KEY",
    requiresKey: false,
  },
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && Object.hasOwn(LLM_PROVIDERS, value);
}

export interface CtxConfig {
  geminiKey?: string;
  geminiModel: string;
  standupFormat: StandupFormat;
  llmProvider?: LlmProvider;
  llmModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
}

export interface RedactedConfig {
  hasGeminiKey: boolean;
  keySource: "env" | "config" | "none";
  geminiModel: string;
  standupFormat: StandupFormat;
  dataDir: string;
  llmProvider: LlmProvider;
  llmProviderLabel: string;
  llmModel: string;
  llmBaseUrl: string;
  hasApiKey: boolean;
  isLlmConfigured: boolean;
  envVarHint: string;
  providers: LlmProviderInfo[];
}

export interface GeminiSettings {
  apiKey: string | undefined;
  source: "env" | "config" | "none";
  model: string;
}

export interface LlmSettings {
  provider: LlmProvider;
  providerLabel: string;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  source: "env" | "config" | "none";
  envVar: string;
  requiresKey: boolean;
  isConfigured: boolean;
}

const DEFAULT_CONFIG: CtxConfig = {
  geminiModel: "gemini-2.5-flash",
  standupFormat: "markdown",
  llmProvider: "gemini",
};

/** Resolve the application data directory, honoring CTX_HOME for isolated runs/tests. */
export function getDataDir(): string {
  const override = process.env.CTX_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "ctx");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "ctx");
}

export function getDbPath(): string {
  return path.join(getDataDir(), "ctx.db");
}

export function getConfigPath(): string {
  return path.join(getDataDir(), "config.json");
}

/** Canonicalize filesystem paths so Windows drive/casing differences don't create duplicate records. */
export function canonicalPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  let target = resolved;
  try {
    if (fs.existsSync(resolved)) {
      target = fs.realpathSync.native(resolved);
    }
  } catch {
    target = resolved;
  }
  if (process.platform === "win32") {
    target = target.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  }
  return target;
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadConfig(): CtxConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CtxConfig>;
    return {
      geminiKey: nonEmpty(parsed.geminiKey),
      geminiModel: nonEmpty(parsed.geminiModel) ?? DEFAULT_CONFIG.geminiModel,
      standupFormat: parsed.standupFormat === "slack" ? "slack" : "markdown",
      llmProvider: isLlmProvider(parsed.llmProvider) ? parsed.llmProvider : "gemini",
      llmModel: nonEmpty(parsed.llmModel),
      llmApiKey: nonEmpty(parsed.llmApiKey),
      llmBaseUrl: nonEmpty(parsed.llmBaseUrl),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(next: CtxConfig): void {
  ensureDataDir();
  const payload: Record<string, string> = {
    geminiModel: next.geminiModel || DEFAULT_CONFIG.geminiModel,
    standupFormat: next.standupFormat === "slack" ? "slack" : "markdown",
    llmProvider: next.llmProvider && isLlmProvider(next.llmProvider) ? next.llmProvider : "gemini",
  };
  if (next.geminiKey?.trim()) payload.geminiKey = next.geminiKey.trim();
  if (next.llmModel?.trim()) payload.llmModel = next.llmModel.trim();
  if (next.llmApiKey?.trim()) payload.llmApiKey = next.llmApiKey.trim();
  if (next.llmBaseUrl?.trim()) payload.llmBaseUrl = next.llmBaseUrl.trim();
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function resolveLlmSettings(
  config: CtxConfig = loadConfig(),
  overrides: { provider?: LlmProvider; model?: string; baseUrl?: string } = {},
): LlmSettings {
  const envProviderRaw = process.env.CTX_LLM_PROVIDER?.trim().toLowerCase();
  const configuredProvider: LlmProvider = config.llmProvider && isLlmProvider(config.llmProvider)
    ? config.llmProvider
    : "gemini";
  const provider: LlmProvider =
    overrides.provider ??
    (isLlmProvider(envProviderRaw) ? envProviderRaw : undefined) ??
    configuredProvider;

  const info = LLM_PROVIDERS[provider];
  const sameAsConfigured = provider === configuredProvider;

  const providerEnvKey = process.env[info.envVar]?.trim();
  const genericEnvKey = provider === "gemini" ? undefined : process.env.CTX_LLM_API_KEY?.trim();
  const envKey = providerEnvKey || genericEnvKey;

  const cfgKey =
    (sameAsConfigured ? nonEmpty(config.llmApiKey) : undefined) ??
    (provider === "gemini" ? nonEmpty(config.geminiKey) : undefined);

  const apiKey = envKey || cfgKey;
  const source: "env" | "config" | "none" = envKey ? "env" : cfgKey ? "config" : "none";

  const envModel =
    process.env.CTX_LLM_MODEL?.trim() ||
    (provider === "gemini" ? process.env.CTX_GEMINI_MODEL?.trim() : undefined);
  const cfgModel =
    (sameAsConfigured ? nonEmpty(config.llmModel) : undefined) ??
    (provider === "gemini" ? nonEmpty(config.geminiModel) : undefined);
  const model = overrides.model?.trim() || envModel || cfgModel || info.defaultModel;

  const rawBaseUrl =
    overrides.baseUrl?.trim() ||
    process.env.CTX_LLM_BASE_URL?.trim() ||
    (sameAsConfigured ? nonEmpty(config.llmBaseUrl) : undefined) ||
    info.defaultBaseUrl;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");

  return {
    provider,
    providerLabel: info.label,
    model,
    baseUrl,
    apiKey,
    source,
    envVar: info.envVar,
    requiresKey: info.requiresKey,
    isConfigured: !info.requiresKey || Boolean(apiKey),
  };
}

export function resolveGeminiSettings(config: CtxConfig = loadConfig()): GeminiSettings {
  const resolved = resolveLlmSettings(config, { provider: "gemini" });
  return {
    apiKey: resolved.apiKey,
    source: resolved.source,
    model: resolved.model,
  };
}

export function redactConfig(config: CtxConfig = loadConfig()): RedactedConfig {
  const llm = resolveLlmSettings(config);
  const gemini = resolveGeminiSettings(config);
  return {
    hasGeminiKey: Boolean(gemini.apiKey),
    keySource: llm.source,
    geminiModel: gemini.model,
    standupFormat: config.standupFormat,
    dataDir: getDataDir(),
    llmProvider: llm.provider,
    llmProviderLabel: llm.providerLabel,
    llmModel: llm.model,
    llmBaseUrl: llm.baseUrl,
    hasApiKey: Boolean(llm.apiKey),
    isLlmConfigured: llm.isConfigured,
    envVarHint: llm.envVar,
    providers: Object.values(LLM_PROVIDERS),
  };
}

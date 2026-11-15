import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StandupFormat = "markdown" | "slack";

export interface CtxConfig {
  geminiKey?: string;
  geminiModel: string;
  standupFormat: StandupFormat;
}

export interface RedactedConfig {
  hasGeminiKey: boolean;
  keySource: "env" | "config" | "none";
  geminiModel: string;
  standupFormat: StandupFormat;
  dataDir: string;
}

export interface GeminiSettings {
  apiKey: string | undefined;
  source: "env" | "config" | "none";
  model: string;
}

const DEFAULT_CONFIG: CtxConfig = {
  geminiModel: "gemini-2.5-flash",
  standupFormat: "markdown",
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

export function loadConfig(): CtxConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CtxConfig>;
    return {
      geminiKey: typeof parsed.geminiKey === "string" && parsed.geminiKey.trim()
        ? parsed.geminiKey.trim()
        : undefined,
      geminiModel:
        typeof parsed.geminiModel === "string" && parsed.geminiModel.trim()
          ? parsed.geminiModel.trim()
          : DEFAULT_CONFIG.geminiModel,
      standupFormat: parsed.standupFormat === "slack" ? "slack" : "markdown",
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
  };
  if (next.geminiKey?.trim()) {
    payload.geminiKey = next.geminiKey.trim();
  }
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function resolveGeminiSettings(config: CtxConfig = loadConfig()): GeminiSettings {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  const cfgKey = config.geminiKey?.trim();
  const model = process.env.CTX_GEMINI_MODEL?.trim() || config.geminiModel || DEFAULT_CONFIG.geminiModel;

  if (envKey) {
    return { apiKey: envKey, source: "env", model };
  }
  if (cfgKey) {
    return { apiKey: cfgKey, source: "config", model };
  }
  return { apiKey: undefined, source: "none", model };
}

export function redactConfig(config: CtxConfig = loadConfig()): RedactedConfig {
  const gemini = resolveGeminiSettings(config);
  return {
    hasGeminiKey: Boolean(gemini.apiKey),
    keySource: gemini.source,
    geminiModel: gemini.model,
    standupFormat: config.standupFormat,
    dataDir: getDataDir(),
  };
}

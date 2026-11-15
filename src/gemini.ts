import { LLM_PROVIDERS, type LlmProvider } from "./config.ts";

export interface GeminiRequest {
  apiKey: string;
  model: string;
  systemInstruction: string;
  prompt: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface LlmRequest {
  provider?: LlmProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  systemInstruction: string;
  prompt: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: {
    type?: string;
    message?: string;
  };
}

async function fetchJsonWithTimeout<T>(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; status: number; statusText: string; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: true, status: res.status, statusText: res.statusText, data };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `${label} request timed out after ${timeoutMs}ms.` };
    }
    return {
      ok: false,
      error: `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_FALLBACK_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite-preview",
];

async function callGeminiSingle(
  req: GeminiRequest,
  modelName: string,
  timeoutMs: number,
): Promise<GeminiResult & { retryable?: boolean }> {
  const doFetch = req.fetchImpl ?? fetch;
  const baseUrl = (req.baseUrl || LLM_PROVIDERS.gemini.defaultBaseUrl).replace(/\/+$/, "");
  const cleanModel = modelName.trim().replace(/^models\//i, "");
  const url = `${baseUrl}/models/${encodeURIComponent(cleanModel)}:generateContent`;

  const res = await fetchJsonWithTimeout<GeminiApiResponse>(
    "Gemini",
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: req.systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: req.prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.25,
        },
      }),
    },
    timeoutMs,
    doFetch,
  );

  if (!res.ok) {
    return { ...res, retryable: true };
  }
  if (res.status < 200 || res.status >= 300) {
    const apiMsg = res.data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    const retryable =
      res.status === 404 ||
      res.status === 503 ||
      res.status === 429 ||
      /no longer available|not found|unavailable/i.test(apiMsg);
    return { ok: false, error: `Gemini API error: ${apiMsg}`, retryable };
  }

  const parts = res.data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return { ok: false, error: "Gemini returned an empty response.", retryable: false };
  }
  return { ok: true, text };
}

/** Call the Google Gemini generateContent REST API using x-goog-api-key header auth. */
export async function callGemini(req: GeminiRequest): Promise<GeminiResult> {
  const primaryModel = req.model.trim().replace(/^models\//i, "") || LLM_PROVIDERS.gemini.defaultModel;
  const timeoutMs = req.timeoutMs ?? 20000;
  const first = await callGeminiSingle(req, primaryModel, timeoutMs);
  if (first.ok) {
    return { ok: true, text: first.text };
  }

  if (!first.retryable || req.fetchImpl) {
    return { ok: false, error: first.error };
  }

  const fallbackTimeoutMs = Math.min(timeoutMs, 12000);
  for (const candidate of GEMINI_FALLBACK_MODELS) {
    if (candidate === primaryModel) continue;
    const retry = await callGeminiSingle(req, candidate, fallbackTimeoutMs);
    if (retry.ok) {
      return { ok: true, text: retry.text };
    }
  }

  return { ok: false, error: first.error };
}

async function callAnthropic(req: LlmRequest): Promise<GeminiResult> {
  if (!req.apiKey) {
    return { ok: false, error: "Anthropic API key is missing." };
  }
  const timeoutMs = req.timeoutMs ?? 25000;
  const doFetch = req.fetchImpl ?? fetch;
  const baseUrl = (req.baseUrl || LLM_PROVIDERS.anthropic.defaultBaseUrl).replace(/\/+$/, "");
  const url = baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl}/messages`;

  const res = await fetchJsonWithTimeout<AnthropicResponse>(
    "Anthropic",
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": req.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 1500,
        temperature: 0.25,
        system: req.systemInstruction,
        messages: [{ role: "user", content: req.prompt }],
      }),
    },
    timeoutMs,
    doFetch,
  );

  if (!res.ok) return res;
  if (res.status < 200 || res.status >= 300) {
    const apiMsg = res.data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    return { ok: false, error: `Anthropic API error: ${apiMsg}` };
  }

  const text = (res.data.content ?? [])
    .filter((block) => block.type === "text" || typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return { ok: false, error: "Anthropic returned an empty response." };
  }
  return { ok: true, text };
}

async function callOpenAiCompatible(req: LlmRequest): Promise<GeminiResult> {
  const provider = req.provider ?? "openai";
  const info = LLM_PROVIDERS[provider];
  const timeoutMs = req.timeoutMs ?? 25000;
  const doFetch = req.fetchImpl ?? fetch;
  const baseUrl = (req.baseUrl || info.defaultBaseUrl).replace(/\/+$/, "");
  const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (req.apiKey?.trim()) {
    headers.Authorization = `Bearer ${req.apiKey.trim()}`;
  }

  const res = await fetchJsonWithTimeout<OpenAiChatResponse>(
    info.label,
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: req.model,
        temperature: 0.25,
        messages: [
          { role: "system", content: req.systemInstruction },
          { role: "user", content: req.prompt },
        ],
      }),
    },
    timeoutMs,
    doFetch,
  );

  if (!res.ok) return res;
  if (res.status < 200 || res.status >= 300) {
    const apiMsg = res.data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    return { ok: false, error: `${info.label} API error: ${apiMsg}` };
  }

  const rawContent = res.data.choices?.[0]?.message?.content;
  const text = Array.isArray(rawContent)
    ? rawContent.map((part) => part.text ?? "").join("").trim()
    : (rawContent ?? "").trim();

  if (!text) {
    return { ok: false, error: `${info.label} returned an empty response.` };
  }
  return { ok: true, text };
}

/** Dispatch a summary generation request to the configured LLM provider. */
export async function callLlm(req: LlmRequest): Promise<GeminiResult> {
  const provider: LlmProvider = req.provider ?? "gemini";
  if (provider === "gemini") {
    return callGemini({
      apiKey: req.apiKey ?? "",
      model: req.model,
      baseUrl: req.baseUrl,
      systemInstruction: req.systemInstruction,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      fetchImpl: req.fetchImpl,
    });
  }
  if (provider === "anthropic") {
    return callAnthropic(req);
  }
  return callOpenAiCompatible(req);
}

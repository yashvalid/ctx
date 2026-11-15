export interface GeminiRequest {
  apiKey: string;
  model: string;
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

/** Call the Google Gemini generateContent REST API using x-goog-api-key header auth. */
export async function callGemini(req: GeminiRequest): Promise<GeminiResult> {
  const timeoutMs = req.timeoutMs ?? 20000;
  const doFetch = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    req.model,
  )}:generateContent`;

  try {
    const res = await doFetch(url, {
      method: "POST",
      signal: controller.signal,
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
    });

    const data = (await res.json().catch(() => ({}))) as GeminiApiResponse;
    if (!res.ok) {
      const apiMsg = data.error?.message || `HTTP ${res.status} ${res.statusText}`;
      return { ok: false, error: `Gemini API error: ${apiMsg}` };
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) {
      return { ok: false, error: "Gemini returned an empty response." };
    }
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `Gemini request timed out after ${timeoutMs}ms.` };
    }
    return {
      ok: false,
      error: `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

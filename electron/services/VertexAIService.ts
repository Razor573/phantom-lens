import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

/**
 * Vertex AI access via Application Default Credentials (ADC).
 *
 * Auth comes from the user's own machine - `gcloud auth application-default
 * login` writes %APPDATA%/gcloud/application_default_credentials.json on
 * Windows, which GoogleAuth picks up automatically. No API keys, no secrets
 * stored in the app. Usage bills to the GCP project's billing account
 * (the $300 trial credit while it lasts).
 *
 * Model catalogue is dynamic: listModels() queries the publisher models API,
 * so new models (e.g. gemini-4-argon) appear without an app update - the
 * same pattern as the Gemini API-key provider's listGeminiModels().
 */
export class VertexAIService {
  private auth = new GoogleAuth({ scopes: SCOPES });
  private cachedToken: string | null = null;
  private tokenExpiryMs = 0;

  /** OAuth2 access token from ADC, cached and refreshed before expiry. */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiryMs - 60_000) {
      return this.cachedToken;
    }
    try {
      const client = await this.auth.getClient();
      const resp = await client.getAccessToken();
      const token = resp?.token;
      if (!token) throw new Error("empty token");
      this.cachedToken = token;
      // ADC tokens live ~1h; refresh a little early.
      this.tokenExpiryMs = Date.now() + 50 * 60_000;
      return token;
    } catch (e: any) {
      this.cachedToken = null;
      throw new Error(
        "Vertex AI sign-in not found. On your machine run: gcloud auth application-default login (install the gcloud CLI first), then try again."
      );
    }
  }

  /** Forget the cached token (e.g. after a 401). */
  clearToken(): void {
    this.cachedToken = null;
    this.tokenExpiryMs = 0;
  }

  /**
   * All Google-published models available to this project, filtered to
   * text-generation models. Model IDs are short (e.g. "gemini-4-argon").
   */
  async listModels(
    projectId: string,
    location: string
  ): Promise<Array<{ id: string; name: string }>> {
    const token = await this.getAccessToken();
    const url =
      `https://${location}-aiplatform.googleapis.com/v1` +
      `/projects/${encodeURIComponent(projectId)}` +
      `/locations/${encodeURIComponent(location)}/publishers/google/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Vertex AI model list failed (HTTP ${res.status}): ${body.slice(0, 200)}`
      );
    }
    const data: any = await res.json();
    return (data.publisherModels || [])
      .filter(
        (m: any) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m: any) => {
        const full = String(m.name || ""); // publishers/google/models/<id>
        const id = full.split("/").pop() || full;
        return { id, name: m.displayName || id };
      })
      .filter((m: any) => m.id);
  }

  /**
   * Streamed generateContent against a publisher model. Yields text chunks.
   * Images are sent as inlineData parts, same as the Gemini provider.
   */
  async *streamGenerateContent(opts: {
    projectId: string;
    location: string;
    model: string;
    prompt: string;
    base64Images: string[];
    thinkingLevel?: string;
    signal: AbortSignal;
  }): AsyncGenerator<string> {
    const token = await this.getAccessToken();
    const modelId = opts.model.replace(/^publishers\/google\/models\//, "");
    const url =
      `https://${opts.location}-aiplatform.googleapis.com/v1` +
      `/projects/${encodeURIComponent(opts.projectId)}` +
      `/locations/${encodeURIComponent(opts.location)}` +
      `/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

    const parts: any[] = [{ text: opts.prompt }];
    for (const img of opts.base64Images) {
      parts.push({ inlineData: { mimeType: "image/png", data: img } });
    }
    const generationConfig: any = {
      candidateCount: 1,
      // Cost guard: Argon-class output is $10/1M tokens at intro pricing.
      maxOutputTokens: 8192,
      temperature: 0.45,
    };
    if (opts.thinkingLevel && /^gemini-[34]/.test(modelId)) {
      generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) this.clearToken();
      throw new Error(
        `Vertex AI request failed (HTTP ${res.status}): ${body.slice(0, 300)}`
      );
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const text =
              json.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text || "")
                .join("") || "";
            if (text) yield text;
          } catch {
            // Partial SSE frame - ignore, the rest arrives in later chunks.
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
}

export const vertexAIService = new VertexAIService();

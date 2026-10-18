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
  private auth: GoogleAuth;
  private cachedToken: string | null = null;
  private tokenExpiryMs = 0;
  private serviceAccountJson: string | null = null;

  constructor() {
    this.auth = this.buildAuth();
  }

  private buildAuth(): GoogleAuth {
    // Pasted service-account key (from Phantom Lens settings) wins;
    // otherwise fall back to gcloud ADC on the machine.
    if (this.serviceAccountJson) {
      try {
        const credentials = JSON.parse(this.serviceAccountJson);
        if (credentials?.client_email && credentials?.private_key) {
          return new GoogleAuth({ credentials, scopes: SCOPES });
        }
      } catch {
        // Invalid JSON - fall through to ADC.
      }
    }
    return new GoogleAuth({ scopes: SCOPES });
  }

  /** Use a pasted service-account JSON key instead of gcloud ADC. */
  setServiceAccountJson(json: string | null): void {
    const trimmed = (json || "").trim();
    this.serviceAccountJson = trimmed || null;
    this.auth = this.buildAuth();
    this.clearToken();
  }

  /** Validate pasted key JSON early so settings can show a clear error. */
  static validateServiceAccountJson(json: string): void {
    let parsed: any;
    // Strip BOM / zero-width chars that sneak in when copying from editors.
    const cleaned = (json || "").replace(/^﻿/, "").trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("That isn't valid JSON - paste the full key file contents.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("That isn't a service account key object.");
    }
    if (parsed.type && parsed.type !== "service_account") {
      throw new Error(`That looks like a "${parsed.type}" key, not a service account key.`);
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        "That doesn't look like a service account key - it needs client_email and private_key."
      );
    }
  }

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
        "Vertex AI sign-in not found. Paste a service account JSON key in settings (Vertex AI provider), or on your machine run: gcloud auth application-default login."
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
    // Publisher catalogue is a global Model Garden endpoint: no project or
    // location in the path - the project goes in x-goog-user-project.
    // (docs: publishers.models.list is v1beta1-only -
    // GET /v1beta1/publishers/{publisher}/models)
    const url = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/google/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": projectId,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Google returns an HTML error page for 404s - extract the title.
      const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
      const detail = titleMatch
        ? titleMatch[1].trim()
        : body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(
        `Vertex AI model list failed (HTTP ${res.status}): ${detail || "no details"}`
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
    webSearch?: boolean;
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
        // Google Search grounding: the model can search the live web.
        // Billed per search query (5k free/month on Gemini 3.x, then $14/1k).
        ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
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

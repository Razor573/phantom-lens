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
export interface VertexStreamOptions {
  projectId: string;
  location: string;
  model: string;
  prompt: string;
  base64Images: string[];
  thinkingLevel?: string;
  webSearch?: boolean;
  signal: AbortSignal;
}

export class VertexAIService {
  private auth: GoogleAuth;
  private cachedToken: string | null = null;
  private tokenExpiryMs = 0;
  private serviceAccountJson: string | null = null;
  private parsedProjectId: string | null = null;
  private resolvedModelLocations: Map<string, string> = new Map();

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
    const trimmed = (json || "").replace(/^\uFEFF/, "").trim();
    this.serviceAccountJson = trimmed || null;
    this.parsedProjectId = null;
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.project_id === "string" && parsed.project_id.trim()) {
          this.parsedProjectId = parsed.project_id.trim();
        }
      } catch {
        // Ignore parse error; buildAuth falls back to ADC.
      }
    }
    this.auth = this.buildAuth();
    this.clearToken();
    this.resolvedModelLocations.clear();
  }

  getProjectIdFromKey(): string | null {
    return this.parsedProjectId;
  }

  public static getEndpointHost(location: string): string {
    const loc = (location || "global").trim().toLowerCase() || "global";
    return loc === "global"
      ? "aiplatform.googleapis.com"
      : `${loc}-aiplatform.googleapis.com`;
  }

  public static isSupportedChatModel(id: string): boolean {
    if (!id || !id.startsWith("gemini-")) return false;
    if (
      id.startsWith("gemini-1.") ||
      id.startsWith("gemini-2.0-") ||
      id === "gemini-3-pro-preview" ||
      id === "gemini-2.5-flash-preview-04-17" ||
      id === "gemini-2.5-pro-exp-03-25" ||
      /-exp($|-)/.test(id)
    ) {
      return false;
    }
    if (
      /-(tts|live|transcribe|translate|image|embedding|omni|nano-banana|computer-use|robotics|audio)($|-)/.test(
        id
      )
    ) {
      return false;
    }
    return true;
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
    this.resolvedModelLocations.clear();
  }

  /**
   * All Google-published models available to this project, filtered to
   * text-generation models. Model IDs are short (e.g. "gemini-4-argon").
   */
  async listModels(
    projectId: string,
    location: string = "global"
  ): Promise<Array<{ id: string; name: string }>> {
    const token = await this.getAccessToken();
    const effectiveProject = (projectId || this.parsedProjectId || "").trim();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (effectiveProject) {
      headers["x-goog-user-project"] = effectiveProject;
    }

    const globalUrl =
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?listAllVersions=true&pageSize=100";
    let res = await fetch(globalUrl, { headers });
    const normLoc = (location || "global").trim().toLowerCase() || "global";
    if (!res.ok && normLoc !== "global") {
      const fallbackUrl =
        `https://${VertexAIService.getEndpointHost(normLoc)}/v1beta1/publishers/google/models` +
        `?listAllVersions=true&pageSize=100`;
      res = await fetch(fallbackUrl, { headers });
    }
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
    const seen = new Map<string, { id: string; name: string }>();
    for (const m of data.publisherModels || []) {
      const full = String(m.name || ""); // publishers/google/models/<id>
      const id = full.split("/").pop() || full;
      if (!VertexAIService.isSupportedChatModel(id)) continue;
      if (!seen.has(id)) {
        seen.set(id, { id, name: String(m.displayName || id) });
      }
    }
    return [...seen.values()].sort((a, b) =>
      b.id.localeCompare(a.id, undefined, { numeric: true })
    );
  }

  /**
   * Streamed generateContent against a publisher model. Yields text chunks.
   * Images are sent as inlineData parts, same as the Gemini provider.
   */
  async *streamGenerateContent(opts: VertexStreamOptions): AsyncGenerator<string> {
    const projectId = (opts.projectId || this.parsedProjectId || "").trim();
    if (!projectId) {
      throw new Error(
        "Vertex AI project ID is missing. Set a GCP Project ID or paste a service account JSON key."
      );
    }
    const requestedLoc = (opts.location || "global").trim().toLowerCase() || "global";
    const modelId = opts.model
      .trim()
      .replace(/^models\//, "")
      .replace(/^publishers\/google\/models\//, "");

    const token = await this.getAccessToken();
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
    const body = JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig,
      // Google Search grounding: the model can search the live web.
      // Billed per search query (5k free/month on Gemini 3.x, then $14/1k).
      ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    });

    const cacheKey = `${projectId}:${modelId}`;
    const cachedLoc = this.resolvedModelLocations.get(cacheKey);
    const isGlobalFirstModel = /^gemini-(3|4)(\.|-)/.test(modelId);
    const candidateLocs: string[] = [];
    const pushUnique = (loc?: string) => {
      if (loc && !candidateLocs.includes(loc)) candidateLocs.push(loc);
    };
    if (cachedLoc) pushUnique(cachedLoc);
    if (requestedLoc === "global" || isGlobalFirstModel) {
      pushUnique("global");
      pushUnique(requestedLoc);
      pushUnique("us-central1");
      pushUnique("europe-west2");
    } else {
      pushUnique(requestedLoc);
      pushUnique("global");
      pushUnique("us-central1");
    }
    const locationsToTry = candidateLocs;

    let res: Response | null = null;
    let lastError = "";
    for (const loc of locationsToTry) {
      const host = VertexAIService.getEndpointHost(loc);
      const url =
        `https://${host}/v1` +
        `/projects/${encodeURIComponent(projectId)}` +
        `/locations/${encodeURIComponent(loc)}` +
        `/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: opts.signal,
      });
      if (res.ok && res.body) {
        this.resolvedModelLocations.set(cacheKey, loc);
        break;
      }
      const errBody = await res.text().catch(() => "");
      if (res.status === 401) this.clearToken();
      lastError = `Vertex AI request failed (HTTP ${res.status}): ${errBody.slice(0, 300)}`;
      // Only retry on 404 (model not in region); other errors are real.
      if (res.status !== 404) {
        throw new Error(lastError);
      }
      res = null; // try next region
    }
    if (!res || !res.ok || !res.body) {
      throw new Error(lastError || "Vertex AI request failed in all regions");
    }

    const reader = res.body.getReader();
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
            const parts: Array<{ text?: string; thought?: boolean }> | undefined =
              json.candidates?.[0]?.content?.parts;
            const text =
              parts
                ?.filter((p) => !p.thought)
                .map((p) => p.text ?? "")
                .join("") ?? "";
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

import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

// Reliability tuning for Vertex AI streaming (see hedgedFirstChunk below).
// Vertex streaming tails are long (console p99 of minutes) while the median
// is seconds, so the client hedges across regions and gives up on a stalled
// first chunk fast instead of waiting out a queued request.
const FIRST_CHUNK_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_ATTEMPTS = 3;

function abortError(): Error {
  const e = new Error("Request aborted");
  e.name = "AbortError";
  return e;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read one chunk from an SSE reader, rejecting promptly when signal aborts.
 * Plain reader.read() ignores aborts once the stream is open - that is why
 * a stalled Vertex stream used to hang forever despite a timeout existing.
 * Callers must cancel the reader when this rejects.
 */
async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Fetch with exponential backoff on transient errors. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  maxAttempts = RETRY_MAX_ATTEMPTS
): Promise<Response> {
  let delay = RETRY_BASE_DELAY_MS;
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw abortError();
    const res = await fetch(url, { ...init, signal });
    // 429/409/5xx are transient for idempotent prediction calls: 429 is
    // throttling, 409 is a serving-side conflict (seen in the wild on
    // StreamGenerateContent around 2026-10-24 21:27-21:30), 5xx is a server
    // fault. All are safe to retry because a prediction has no side effects.
    if (res.status === 429 || res.status === 409 || res.status >= 500) {
      lastRes = res;
      try {
        await res.text();
      } catch {
        // Ignore body-read errors on an already-failed response.
      }
      if (attempt < maxAttempts - 1) {
        await sleepWithSignal(delay + Math.floor(Math.random() * 500), signal);
        delay *= 2;
        continue;
      }
    }
    return res;
  }
  return lastRes as Response;
}

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
  /** First-chunk deadline for the hedged region race (default 20s). */
  firstChunkTimeoutMs?: number;
}

interface SseHandle {
  loc: string;
  ctrl: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buf: string;
  firstParts: Array<{ text?: string; thought?: boolean }>;
}

interface HedgeTracker {
  controllers: AbortController[];
  handles: SseHandle[];
  settled: boolean;
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
    // The token exchange itself has no signal support, so race it against
    // a timeout - otherwise a stalled exchange hangs the whole request.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const tokenPromise = (async () => {
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
      })();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Vertex AI sign-in timed out while fetching an access token")),
          TOKEN_TIMEOUT_MS
        );
      });
      return await Promise.race([tokenPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
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
    let res = await fetch(globalUrl, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    const normLoc = (location || "global").trim().toLowerCase() || "global";
    if (!res.ok && normLoc !== "global") {
      const fallbackUrl =
        `https://${VertexAIService.getEndpointHost(normLoc)}/v1beta1/publishers/google/models` +
        `?listAllVersions=true&pageSize=100`;
      res = await fetch(fallbackUrl, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
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

  /** Regions to try, cached winner first, then global + regional fallbacks. */
  private candidateLocations(projectId: string, modelId: string, requestedLoc: string): string[] {
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
    return candidateLocs;
  }

  /** Shared request body for streaming and single-shot prediction. */
  private buildBody(opts: {
    prompt: string;
    base64Images: string[];
    thinkingLevel?: string;
    modelId: string;
    webSearch?: boolean;
  }): string {
    const parts: any[] = [{ text: opts.prompt }];
    for (const img of opts.base64Images) {
      parts.push({ inlineData: { mimeType: "image/png", data: img } });
    }
    const generationConfig: any = {
      candidateCount: 1,
      maxOutputTokens: 12288,
      temperature: 0.2,
    };
    if (opts.thinkingLevel && /^gemini-[34]/.test(opts.modelId)) {
      generationConfig.thinkingConfig = {
        thinkingLevel: opts.thinkingLevel,
        includeThoughts: true,
      };
    } else {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
      };
    }
    return JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig,
      // Google Search grounding: the model can search the live web.
      // Billed per search query (5k free/month on Gemini 3.x, then $14/1k).
      ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    });
  }

  /**
   * One region's attempt at a streaming request: fetch (with backoff on
   * 429/5xx), then read until the first SSE payload with content parts.
   * Returns a handle positioned just after that first payload so the winner
   * can keep streaming from it. Throws on 404/401/other failures.
   */
  private async attemptStream(
    loc: string,
    url: string,
    token: string,
    body: string,
    outerSignal: AbortSignal,
    tracker: HedgeTracker
  ): Promise<SseHandle> {
    const ctrl = new AbortController();
    tracker.controllers.push(ctrl);
    const onOuterAbort = () => ctrl.abort();
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      if (outerSignal.aborted) throw abortError();
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        },
        ctrl.signal
      );
      if (res.status === 404) {
        const errBody = await res.text().catch(() => "");
        const err: any = new Error(
          `Vertex AI request failed (HTTP 404): ${errBody.slice(0, 300)}`
        );
        err.status = 404;
        err.loc = loc;
        throw err;
      }
      if (res.status === 401) {
        this.clearToken();
        const err: any = new Error("Vertex AI request failed (HTTP 401)");
        err.status = 401;
        err.loc = loc;
        throw err;
      }
      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => "");
        const err: any = new Error(
          `Vertex AI request failed (HTTP ${res.status}): ${errBody.slice(0, 300)}`
        );
        err.status = res.status;
        err.loc = loc;
        throw err;
      }
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await readWithSignal(reader, ctrl.signal);
        if (done) throw new Error("Vertex AI stream ended before first chunk");
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
            if (parts && parts.length) {
              const handle: SseHandle = { loc, ctrl, reader, decoder, buf, firstParts: parts };
              // If the race already settled, this handle is orphaned: drop it
              // instead of leaking an open stream.
              if (tracker.settled) {
                try {
                  await reader.cancel();
                } catch {
                  // Ignore cancel errors on an orphaned stream.
                }
                throw abortError();
              }
              tracker.handles.push(handle);
              return handle;
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") throw e;
            // Partial JSON frame - keep reading.
          }
        }
      }
    } catch (e) {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors on a failed attempt.
        }
      }
      throw e;
    } finally {
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Hedged region race: all locations attempt in parallel, the first to
   * yield a chunk wins, losers are cancelled. A first-chunk deadline aborts
   * the whole race (correlated stall: every region slow at once) so the
   * caller can retry once instead of waiting out a queued request.
   */
  private async hedgedFirstChunk(
    locs: string[],
    buildUrl: (loc: string) => string,
    token: string,
    body: string,
    outerSignal: AbortSignal,
    firstChunkTimeoutMs: number,
    notFoundLocs: Set<string>
  ): Promise<SseHandle> {
    const tracker: HedgeTracker = { controllers: [], handles: [], settled: false };
    type AttemptResult =
      | { ok: true; handle: SseHandle }
      | { ok: false; err: any; loc: string };
    const attempts: Array<Promise<AttemptResult>> = locs.map((loc) =>
      this.attemptStream(loc, buildUrl(loc), token, body, outerSignal, tracker).then(
        (handle): AttemptResult => ({ ok: true, handle }),
        (err): AttemptResult => ({ ok: false, err, loc })
      )
    );
    let pending = attempts.length;
    let lastErr: any = null;
    const firstSuccess = new Promise<SseHandle>((resolve, reject) => {
      attempts.forEach((p) =>
        p.then((r) => {
          if (r.ok) {
            resolve(r.handle);
            return;
          }
          const failed = r as Extract<AttemptResult, { ok: false }>;
          if (failed.err?.status === 404) notFoundLocs.add(failed.loc);
          lastErr = failed.err;
          if (--pending === 0) reject(lastErr);
        })
      );
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const e: any = new Error("FIRST_CHUNK_TIMEOUT");
        e.code = "FIRST_CHUNK_TIMEOUT";
        reject(e);
      }, firstChunkTimeoutMs);
    });
    try {
      const winner = await Promise.race([firstSuccess, timeoutPromise]);
      tracker.settled = true;
      for (const ctrl of tracker.controllers) {
        if (ctrl !== winner.ctrl) {
          try {
            ctrl.abort();
          } catch {
            // Ignore abort errors on loser attempts.
          }
        }
      }
      for (const h of tracker.handles) {
        if (h !== winner) {
          try {
            await h.reader.cancel();
          } catch {
            // Ignore cancel errors on loser streams.
          }
        }
      }
      return winner;
    } catch (e) {
      tracker.settled = true;
      for (const ctrl of tracker.controllers) {
        try {
          ctrl.abort();
        } catch {
          // Ignore abort errors during cleanup.
        }
      }
      for (const h of tracker.handles) {
        try {
          await h.reader.cancel();
        } catch {
          // Ignore cancel errors during cleanup.
        }
      }
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /** Keep yielding SSE parts from the winning handle's stream. */
  private async *continueSse(
    handle: SseHandle,
    signal: AbortSignal
  ): AsyncGenerator<{ type: "thought" | "text"; content: string }> {
    const { reader, decoder } = handle;
    let buf = handle.buf;
    try {
      for (;;) {
        const { done, value } = await readWithSignal(reader, signal);
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
            if (parts) {
              for (const p of parts) {
                if (p.thought && p.text) {
                  yield { type: "thought", content: p.text };
                } else if (!p.thought && p.text) {
                  yield { type: "text", content: p.text };
                }
              }
            }
          } catch {
            // Partial SSE frame - ignore, the rest arrives in later chunks.
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors at stream end.
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors at stream end.
      }
    }
  }

  /**
   * Non-streaming fallback: one complete GenerateContent call, hedged
   * across regions (first complete response wins). Used only when
   * streaming fails before any chunk - the single-shot endpoint has
   * proven more reliable than the streaming one, and a complete answer
   * beats an error. Deadline is 45s so it fits inside the caller's 60s
   * inactivity window and 120s overall timeout.
   */
  private async generateContent(opts: {
    projectId: string;
    location: string;
    model: string;
    prompt: string;
    base64Images: string[];
    thinkingLevel?: string;
    webSearch?: boolean;
    signal: AbortSignal;
  }): Promise<string> {
    const projectId = opts.projectId.trim();
    const requestedLoc = (opts.location || "global").trim().toLowerCase() || "global";
    const modelId = opts.model
      .trim()
      .replace(/^models\//, "")
      .replace(/^publishers\/google\/models\//, "");
    const token = await this.getAccessToken();
    const body = this.buildBody({
      prompt: opts.prompt,
      base64Images: opts.base64Images,
      thinkingLevel: opts.thinkingLevel,
      modelId,
      webSearch: opts.webSearch,
    });
    const locs = this.candidateLocations(projectId, modelId, requestedLoc);
    const cacheKey = `${projectId}:${modelId}`;
    const controllers = locs.map(() => new AbortController());
    const onOuterAbort = () => {
      for (const c of controllers) {
        try {
          c.abort();
        } catch {
          // Ignore abort errors during cleanup.
        }
      }
    };
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    type SingleResult = { ok: true; loc: string; text: string } | { ok: false; err: any };
    const attempts: Array<Promise<SingleResult>> = locs.map((loc, i) => {
      const ctrl = controllers[i];
      const host = VertexAIService.getEndpointHost(loc);
      const url =
        `https://${host}/v1` +
        `/projects/${encodeURIComponent(projectId)}` +
        `/locations/${encodeURIComponent(loc)}` +
        `/publishers/google/models/${encodeURIComponent(modelId)}:generateContent`;
      return (async (): Promise<SingleResult> => {
        try {
          if (opts.signal.aborted) throw abortError();
          const res = await fetchWithRetry(
            url,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body,
            },
            ctrl.signal
          );
          if (res.status === 401) this.clearToken();
          if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            throw new Error(
              `Vertex AI request failed (HTTP ${res.status}): ${errBody.slice(0, 300)}`
            );
          }
          const json = await res.json();
          const parts: Array<{ text?: string; thought?: boolean }> | undefined =
            json.candidates?.[0]?.content?.parts;
          const text = (parts || [])
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text as string)
            .join("");
          if (!text) throw new Error("Vertex AI returned an empty response");
          return { ok: true, loc, text };
        } catch (err) {
          return { ok: false, err };
        }
      })();
    });
    let pending = attempts.length;
    let lastErr: any = null;
    const firstSuccess = new Promise<{ loc: string; text: string }>((resolve, reject) => {
      attempts.forEach((p) =>
        p.then((r) => {
          if (r.ok) {
            resolve({ loc: r.loc, text: r.text });
            return;
          }
          const failed = r as Extract<SingleResult, { ok: false }>;
          lastErr = failed.err;
          if (--pending === 0) reject(lastErr);
        })
      );
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("FALLBACK_TIMEOUT")), 45_000);
    });
    try {
      const winner = await Promise.race([firstSuccess, timeoutPromise]);
      this.resolvedModelLocations.set(cacheKey, winner.loc);
      return winner.text;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      opts.signal.removeEventListener("abort", onOuterAbort);
      for (const c of controllers) {
        try {
          c.abort();
        } catch {
          // Ignore abort errors during cleanup.
        }
      }
    }
  }

  /**
   * Runs the single-shot fallback while yielding empty thought chunks
   * every 15s. The empty chunks produce no UI output (the consumer only
   * acts on non-empty content) but they reset the consumer's 60s
   * inactivity timer, so a slow fallback isn't killed for silence.
   */
  private async *fallbackWithKeepAlive(opts: {
    projectId: string;
    location: string;
    model: string;
    prompt: string;
    base64Images: string[];
    thinkingLevel?: string;
    webSearch?: boolean;
    signal: AbortSignal;
  }): AsyncGenerator<{ type: "thought" | "text"; content: string }> {
    let settled = false;
    let result: string | null = null;
    let failure: any = null;
    const p = this.generateContent(opts).then(
      (text) => {
        settled = true;
        result = text;
      },
      (err) => {
        settled = true;
        failure = err;
      }
    );
    while (!settled) {
      await Promise.race([p, new Promise((r) => setTimeout(r, 15_000))]);
      if (!settled) yield { type: "thought", content: "" };
    }
    if (failure) throw failure;
    yield { type: "text", content: result as string };
  }

  /**
   * Streamed generateContent against a publisher model. Yields text chunks.
   * Images are sent as inlineData parts, same as the Gemini provider.
   *
   * Reliability design: regions race in parallel (hedged), a first-chunk
   * deadline with one retry covers the case where every region stalls at
   * once, and transient 429/409/5xx errors retry with backoff inside each
   * attempt. A request only truly fails if every region fails. If
   * streaming fails before any chunk is shown, a single-shot
   * GenerateContent call runs as a last resort so a complete answer
   * still arrives instead of an error.
   */
  async *streamGenerateContent(
    opts: VertexStreamOptions
  ): AsyncGenerator<{ type: "thought" | "text"; content: string }> {
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
    const body = this.buildBody({
      prompt: opts.prompt,
      base64Images: opts.base64Images,
      thinkingLevel: opts.thinkingLevel,
      modelId,
      webSearch: opts.webSearch,
    });

    const cacheKey = `${projectId}:${modelId}`;
    const candidateLocs = this.candidateLocations(projectId, modelId, requestedLoc);

    const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
    const notFound = new Set<string>();
    let lastError = "";
    let yielded = false;
    try {
      for (let round = 0; round < 2; round++) {
        const locs = candidateLocs.filter((l) => !notFound.has(l));
        if (locs.length === 0) break;
        try {
          const handle = await this.hedgedFirstChunk(
            locs,
            (loc) => {
              const host = VertexAIService.getEndpointHost(loc);
              return (
                `https://${host}/v1` +
                `/projects/${encodeURIComponent(projectId)}` +
                `/locations/${encodeURIComponent(loc)}` +
                `/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
              );
            },
            token,
            body,
            opts.signal,
            firstChunkTimeoutMs,
            notFound
          );
          this.resolvedModelLocations.set(cacheKey, handle.loc);
          for (const p of handle.firstParts) {
            if (p.thought && p.text) {
              yielded = true;
              yield { type: "thought", content: p.text };
            } else if (!p.thought && p.text) {
              yielded = true;
              yield { type: "text", content: p.text };
            }
          }
          for await (const chunk of this.continueSse(handle, opts.signal)) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (e: any) {
          lastError = e?.message || String(e);
          // Only the first-chunk deadline gets a retry round; other failures
          // (all regions 404/409/auth) are definitive for this attempt.
          if (e?.code === "FIRST_CHUNK_TIMEOUT" && round === 0) continue;
          throw e;
        }
      }
      throw new Error(lastError || "Vertex AI request failed in all regions");
    } catch (e) {
      // A cancelled request stays cancelled - never fall back after abort.
      if (opts.signal.aborted) throw abortError();
      // Streaming failed before anything was shown: last resort is the
      // single-shot call. Only when nothing was shown yet, so partial
      // output is never duplicated. If the fallback also fails, report
      // the original streaming failure (the more diagnostic error).
      if (!yielded) {
        try {
          yield* this.fallbackWithKeepAlive({
            projectId,
            location: requestedLoc,
            model: modelId,
            prompt: opts.prompt,
            base64Images: opts.base64Images,
            thinkingLevel: opts.thinkingLevel,
            webSearch: opts.webSearch,
            signal: opts.signal,
          });
          return;
        } catch {
          // Fallback also failed - fall through to the original error.
        }
      }
      throw e;
    }
  }
}

export const vertexAIService = new VertexAIService();

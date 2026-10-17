/**
 * Google subscription OAuth and Code Assist transport for Phantom Lens.
 *
 * Lets the user sign in with their Google account and consume their Google AI
 * subscription quota through Google's Code Assist backend
 * (cloudcode-pa.googleapis.com), instead of a pay-per-token API key.
 *
 * NOTE on wire-protocol identifiers: several string literals below still say
 * "antigravity" / "ANTIGRAVITY" (the IDE user-agent format, the metadata
 * ideType, the request userAgent). Those are part of the backend handshake the
 * Code Assist API expects - they are protocol values, not branding, and must
 * not be changed. Everything the user sees says "Google subscription".
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import * as crypto from 'crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { shell } from 'electron';
import { describeOAuthError, renderSubscriptionCallbackPage } from './subscriptionCallbackPage';

/**
 * Google OAuth client for the subscription sign-in flow. Never hardcoded:
 * GitHub push protection (and basic hygiene) forbids secrets in source.
 * Resolution order: GEMINI_SUBSCRIPTION_CLIENT_ID / GEMINI_SUBSCRIPTION_CLIENT_SECRET
 * env vars, then the values saved in Settings (see configureOAuthCredentials).
 * The redirect URI http://localhost:51122/oauth-callback must be registered as
 * an authorized redirect URI on this OAuth client in Google Cloud Console.
 */
export interface SubscriptionOAuthCredentials {
  clientId: string;
  clientSecret: string;
}
export const SUBSCRIPTION_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const SUBSCRIPTION_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SUBSCRIPTION_REDIRECT_URI = 'http://localhost:51122/oauth-callback';
export const SUBSCRIPTION_CALLBACK_PATH = '/oauth-callback';
export const SUBSCRIPTION_CALLBACK_PORT = 51122;
export const SUBSCRIPTION_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;
export const GOOGLE_API_USER_AGENT = 'google-api-nodejs-client/9.15.1';
export const SUBSCRIPTION_SETUP_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
export const SUBSCRIPTION_PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const SUBSCRIPTION_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const SUBSCRIPTION_REFRESH_LEAD_MS = 60_000;
export const SUBSCRIPTION_STREAM_URL =
  `${SUBSCRIPTION_DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

export type SubscriptionErrorCode =
  | 'cancelled'
  | 'browser'
  | 'callback'
  | 'config'
  | 'token_exchange'
  | 'token_refresh'
  | 'auth_required'
  | 'auth_revoked'
  | 'setup'
  /**
   * Onboarding COMPLETED and the account still has no project. Distinct from
   * 'setup', which responseJson also stamps on 401/403/429/5xx/invalid-JSON:
   * those mean the call to find out failed, not that there is nothing to find.
   * The message carries Google's own ineligible-tier reasons verbatim so the
   * user sees exactly why.
   */
  | 'setup_no_project'
  | 'models'
  | 'request'
  | 'response'
  | 'storage';

export class SubscriptionError extends Error {
  public readonly code: SubscriptionErrorCode;
  public readonly status?: number;

  constructor(code: SubscriptionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.status = status;
  }
}

export interface SubscriptionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  projectId: string;
}

/**
 * Minimal persistence contract for the OAuth token bundle. The host app
 * supplies the implementation (Phantom Lens uses a safeStorage-encrypted
 * file). Synchronous on purpose - token reads happen on hot paths.
 */
export interface SubscriptionTokenStore {
  loadTokens(): SubscriptionTokens | null;
  saveTokens(tokens: SubscriptionTokens): boolean;
  clearTokens(): boolean;
}

export interface SubscriptionModel {
  id: string;
  label: string;
}

export interface SubscriptionStatus {
  signedIn: boolean;
  inProgress: boolean;
  expiresAt?: number;
  projectId?: string;
  error?: string;
}

export interface SubscriptionImage {
  mimeType: string;
  data: string;
}

export interface SubscriptionStreamInput {
  model: string;
  userPrompt: string;
  systemPrompt?: string;
  images?: readonly SubscriptionImage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export function resolveSubscriptionWireModel(model: string): string {
  const normalized = model.toLowerCase().replace(/^models\//, '');
  // The catalogue carries a `-tiered` twin for each of these families, and its
  // own tieredModelIds.flash names gemini-3.8-flash-tiered.
  if (normalized.startsWith('gemini-3.8-flash')) return 'gemini-3.8-flash-tiered';
  if (normalized.startsWith('gemini-3.7-flash')) return 'gemini-3.7-flash-tiered';
  if (normalized.startsWith('gemini-3.6-flash')) return 'gemini-3.6-flash-tiered';
  if (normalized === 'gemini-3.1-pro-high' || normalized === 'gemini-3.1-pro') {
    return 'gemini-pro-agent';
  }
  return normalized;
}

export function generateSubscriptionPkce(): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomUUID() };
}

export function buildSubscriptionAuthorizationUrl(
  pkce: { challenge: string; state: string },
  credentials: SubscriptionOAuthCredentials,
): string {
  const params: Array<[string, string]> = [
    ['client_id', credentials.clientId],
    ['response_type', 'code'],
    ['redirect_uri', SUBSCRIPTION_REDIRECT_URI],
    ['scope', SUBSCRIPTION_SCOPES.join(' ')],
    ['code_challenge', pkce.challenge],
    ['code_challenge_method', 'S256'],
    ['state', pkce.state],
    ['access_type', 'offline'],
    ['prompt', 'consent'],
  ];
  return `${SUBSCRIPTION_AUTHORIZE_URL}?${new URLSearchParams(params)}`;
}

/**
 * Resolve the OAuth client credentials. Env vars win (useful for dev), then
 * the values saved via Settings (see configureOAuthCredentials). Throws a
 * plain-language 'config' error when nothing is configured - this is the
 * message the user sees in settings, telling them exactly what to do.
 */
export function resolveOAuthCredentials(): SubscriptionOAuthCredentials {
  const clientId = process.env.GEMINI_SUBSCRIPTION_CLIENT_ID ||
    GeminiSubscriptionService.oauthClientId || '';
  const clientSecret = process.env.GEMINI_SUBSCRIPTION_CLIENT_SECRET ||
    GeminiSubscriptionService.oauthClientSecret || '';
  if (!clientId.trim() || !clientSecret.trim()) {
    throw new SubscriptionError(
      'config',
      'Google OAuth is not configured. Add your OAuth client ID and secret in ' +
      'Settings under Google subscription, or set the GEMINI_SUBSCRIPTION_CLIENT_ID ' +
      'and GEMINI_SUBSCRIPTION_CLIENT_SECRET environment variables.',
    );
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

function metadata(ideType: 'ANTIGRAVITY' | 'IDE_UNSPECIFIED'): Record<string, string> {
  // 'ANTIGRAVITY' is the wire-protocol ideType the Code Assist backend expects.
  return { ideType, platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
}

export function subscriptionSetupHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': GOOGLE_API_USER_AGENT,
    'X-Goog-Api-Client': SUBSCRIPTION_SETUP_CLIENT,
    'Client-Metadata': JSON.stringify(metadata('IDE_UNSPECIFIED')),
  };
}

// Google gates the model catalogue on this version. Kept overridable via
// GEMINI_SUBSCRIPTION_CLIENT_VERSION so a backend-side bump does not need a
// code change: when a model the Gemini app shows is missing here, raise the
// env var to the current IDE version string.
// (Wire format `antigravity/<ideVersion> <os>/<arch>` is what the backend expects.)
export const SUBSCRIPTION_CLIENT_VERSION =
  process.env.GEMINI_SUBSCRIPTION_CLIENT_VERSION || '2.5.5';

/**
 * The backend's expected client format, `antigravity/<ideVersion> <os>/<arch>`,
 * with Go-style names: Windows is `windows` (not `win32`), x64 is `amd64`,
 * ia32 is `386`. Protocol value - do not rebrand.
 */
export function buildSubscriptionUserAgent(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch === 'ia32' ? '386' : arch;
  return `antigravity/${SUBSCRIPTION_CLIENT_VERSION} ${os}/${cpu}`;
}

const SUBSCRIPTION_USER_AGENT = buildSubscriptionUserAgent(process.platform, process.arch);

export function buildSubscriptionRequestPayload(input: {
  projectId: string;
  model: string;
  userPrompt: string;
  systemPrompt?: string;
  images?: readonly SubscriptionImage[];
  maxOutputTokens?: number;
  /** Pre-resolved wire model id. When set, the "-tiered" mapping is skipped. */
  wireModel?: string;
}): Record<string, unknown> {
  const projectId = input.projectId.trim();
  if (!projectId) throw new SubscriptionError('request', 'Google subscription setup has no project yet. Sign in again.');

  const contents: Array<Record<string, unknown>> = [
    {
      role: 'user',
      parts: [{ text: `System instruction: ${input.systemPrompt || ''}` }],
    },
  ];
  const parts: Array<Record<string, unknown>> = [{ text: input.userPrompt }];
  for (const image of input.images || []) {
    if (image.mimeType && image.data) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
  }
  contents.push({ role: 'user', parts });

  const wireModel = input.wireModel || resolveSubscriptionWireModel(input.model);
  const generationConfig: Record<string, unknown> = {
    candidateCount: 1,
    maxOutputTokens: Math.max(1, Math.floor(input.maxOutputTokens || 192)),
    temperature: 0.45,
  };
  if (wireModel.startsWith('gemini')) {
    // 3.8 rejects MINIMAL outright (HTTP 400 "Thinking level MINIMAL is not
    // supported for this model", measured 2026-09-25); LOW answers. 3.7 was
    // already sent LOW.
    generationConfig.thinkingConfig = wireModel.startsWith('gemini-2.5')
      ? { thinkingBudget: 0 }
      : { thinkingLevel: wireModel.includes('3.7') || wireModel.includes('3.8') ? 'low' : 'minimal' };
  }

  return {
    model: wireModel,
    userAgent: 'antigravity', // wire-protocol value the backend expects; not branding
    requestType: 'agent',
    project: projectId,
    requestId: `agent-${crypto.randomUUID()}`,
    request: { contents, generationConfig },
  };
}

export function parseSubscriptionModels(value: unknown): SubscriptionModel[] {
  const models = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).models
    : undefined;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];

  const result: SubscriptionModel[] = [];
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const label = typeof item.displayName === 'string' ? item.displayName.trim() : '';
    const quota = item.quotaInfo && typeof item.quotaInfo === 'object'
      ? (item.quotaInfo as Record<string, unknown>).remainingFraction
      : undefined;
    if (!label || item.isInternal === true || !id || id.startsWith('gemini-3.5-flash')) continue;
    if (id.toLowerCase().includes('image') || label.toLowerCase().includes('flash lite')) continue;
    if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) continue;
    result.push({ id, label });
  }
  return result.sort((a, b) => {
    const rank = (id: string) => id === 'gemini-3.6-flash-low' ? 0
      : id === 'gemini-3-flash' ? 1
        : id.includes('flash') ? 2 : 3;
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
  });
}

export function parseSubscriptionEvent(data: string): string {
  let response: any;
  try { response = JSON.parse(data)?.response; } catch { throw new SubscriptionError('response', 'Google returned malformed streaming data.'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new SubscriptionError('response', 'Google returned an invalid streaming response.');
  }
  if (!Array.isArray(response.candidates) || !response.candidates.length) return '';
  const candidate = response.candidates[0];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new SubscriptionError('response', 'Google returned an invalid candidate.');
  }
  const parts = candidate.content?.parts;
  if (parts !== undefined && !Array.isArray(parts)) {
    throw new SubscriptionError('response', 'Google returned invalid response parts.');
  }
  return (parts || []).map((part: any) => part?.thought !== true && typeof part?.text === 'string' ? part.text : '').join('');
}

function parseSubscriptionSse(buffer: string, final = false): { events: string[]; remainder: string } {
  if (buffer.length > 2 * 1024 * 1024) throw new SubscriptionError('response', 'Google returned an oversized streaming response.');
  const records = buffer.split(/\r?\n\r?\n/);
  const remainder = final ? '' : records.pop()!;
  const events = records.map(record => record.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim()).filter(Boolean);
  return { events, remainder };
}

// Retry policy: UnknownHostException retries are 4 normally and 12 for
// model discovery, using 250/500/1000/2000 ms backoff. HTTP errors are not retried.
function isDnsError(error: unknown): boolean {
  let current: any = error;
  for (let i = 0; i < 5 && current; i += 1) {
    const code = typeof current.code === 'string' ? current.code : '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') return true;
    if (typeof current.message === 'string' && /\b(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL)\b/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export function dnsRetryDelayMillis(remainingRetries: number): number {
  return 250 << Math.max(0, Math.min(3, 4 - remainingRetries));
}

const SUBSCRIPTION_FETCH_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_STREAM_TIMEOUT_MS = 60_000;

async function fetchWithDnsRetry(
  url: string,
  init: RequestInit,
  remainingRetries: number,
  timeoutMs = SUBSCRIPTION_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let retries = remainingRetries;
  const externalSignal = init.signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
  const requestInit = { ...init, signal: requestSignal };
  while (true) {
    try {
      return await fetch(url, requestInit);
    } catch (error) {
      if (externalSignal?.aborted) throw new SubscriptionError('cancelled', 'Google request cancelled.');
      if (timeoutSignal.aborted) throw new SubscriptionError('request', 'Google request timed out.');
      if (!isDnsError(error) || retries <= 0) throw error;
      try {
        await wait(dnsRetryDelayMillis(retries), undefined, { signal: requestSignal });
      } catch (waitError) {
        if (timeoutSignal.aborted) throw new SubscriptionError('request', 'Google request timed out.');
        throw waitError;
      }
      retries -= 1;
    }
  }
}

async function responseJson(response: Response, phase: SubscriptionErrorCode): Promise<any> {
  // fetchWithDnsRetry's AbortSignal deadline also covers consuming the body.
  const body = await response.text();
  if (!response.ok) {
    const status = response.status;
    let oauthError: unknown;
    try { oauthError = JSON.parse(body)?.error; } catch { /* Non-JSON errors are transient session failures. */ }
    const permanent = phase === 'token_refresh' && (status === 400 || status === 401) && oauthError === 'invalid_grant';
    const message = permanent
      ? 'Google subscription session expired. Sign in again.'
      : status === 401
        ? 'Google access was rejected. Refresh the session or sign in again.'
        : status === 403
          ? 'This Google account is not permitted to use the subscription API.'
        : status === 429
          ? 'Google quota is exhausted or temporarily limited. Try again later.'
          : status >= 500
            ? 'Google is temporarily unavailable. Try again shortly.'
            : `${phase === 'models' ? 'Google model discovery' : 'Google request'} failed (HTTP ${status}).`;
    throw new SubscriptionError(
      permanent ? 'auth_revoked' : phase,
      message,
      status,
    );
  }
  try { return JSON.parse(body); } catch { throw new SubscriptionError(phase, 'Google returned invalid JSON.'); }
}

interface CallbackServer {
  portReady: Promise<void>;
  callback: Promise<{ code?: string; state?: string; error?: string }>;
  close(reason?: Error): void;
}

function startCallbackServer(expectedState: string): CallbackServer {
  let resolveCallback!: (value: { code?: string; state?: string; error?: string }) => void;
  let rejectCallback!: (error: Error) => void;
  let settled = false;
  const callback = new Promise<{ code?: string; state?: string; error?: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A bind failure can close the server before startLogin awaits the callback;
  // keep that cleanup rejection from becoming an unhandled promise rejection.
  void callback.catch(() => undefined);
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      response.end('Method Not Allowed');
      return;
    }
    const host = (request.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1') {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid callback host');
      return;
    }
    let url: URL;
    try { url = new URL(request.url || '/', 'http://localhost'); } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid callback');
      return;
    }
    // Absolute HTTP request targets can disagree with Host; validate both.
    if (url.protocol !== 'http:' || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') ||
      (url.port && url.port !== String(SUBSCRIPTION_CALLBACK_PORT))) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid callback origin');
      return;
    }
    if (url.pathname !== SUBSCRIPTION_CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid callback state');
      return;
    }
    const oauthError = url.searchParams.get('error');
    const page = renderSubscriptionCallbackPage(
      oauthError || !url.searchParams.get('code')
        ? { kind: 'error', reason: describeOAuthError(oauthError, url.searchParams.get('error_description')) }
        : { kind: 'returned' },
      process.platform,
    );
    response.writeHead(200, page.headers);
    response.end(page.body);
    if (settled) return;
    settled = true;
    resolveCallback({
      code: url.searchParams.get('code') || undefined,
      state: url.searchParams.get('state') || undefined,
      error: url.searchParams.get('error') || undefined,
    });
  });
  const portReady = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(SUBSCRIPTION_CALLBACK_PORT, '127.0.0.1');
  });
  return {
    portReady,
    callback,
    close(reason) {
      if (!settled) {
        settled = true;
        rejectCallback(reason || new SubscriptionError('cancelled', 'Google subscription sign-in cancelled.'));
      }
      try { (server as any).closeAllConnections?.(); } catch { /* noop */ }
      try { server.close(); } catch { /* already closed */ }
    },
  };
}

function extractProjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

async function discoverProject(accessToken: string, signal: AbortSignal): Promise<string> {
  const headers = subscriptionSetupHeaders(accessToken);
  const loadResponse = await fetchWithDnsRetry(
    `${SUBSCRIPTION_PROD_ENDPOINT}/v1internal:loadCodeAssist`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: metadata('ANTIGRAVITY') }), signal },
    4,
  );
  const loaded = await responseJson(loadResponse, 'setup');
  const existing = extractProjectId(loaded?.cloudaicompanionProject);
  if (existing) return existing;

  let tierId = 'legacy-tier';
  if (Array.isArray(loaded?.allowedTiers)) {
    const tier = loaded.allowedTiers.find((item: any) => item?.isDefault === true && typeof item?.id === 'string' && item.id.trim());
    if (tier) tierId = tier.id.trim();
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const onboardResponse = await fetchWithDnsRetry(
      `${SUBSCRIPTION_PROD_ENDPOINT}/v1internal:onboardUser`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ tierId, metadata: metadata('ANTIGRAVITY') }), signal },
      4,
    );
    const onboarded = await responseJson(onboardResponse, 'setup');
    const project = onboarded?.done === true
      ? extractProjectId(onboarded?.response?.cloudaicompanionProject) : undefined;
    if (project) return project;
    if (onboarded?.done === true) {
      const reasons = Array.isArray(loaded?.ineligibleTiers)
        ? loaded.ineligibleTiers
          .filter((tier: any) => typeof tier?.reasonMessage === 'string' && tier.reasonMessage.trim())
          .map((tier: any) => tier.reasonMessage.trim()) : [];
      throw new SubscriptionError('setup_no_project', reasons.length
        ? `Google subscription setup failed: ${reasons.join(' ')}`
        : 'Google completed account setup without providing a project ID. This account may require a Google Cloud project.');
    }
    if (attempt < 5) await wait(1_500, undefined, { signal });
  }
  throw new SubscriptionError('setup_no_project', 'Google subscription setup did not finish. Try signing in again.');
}

export class GeminiSubscriptionService extends EventEmitter {
  private cachedTokens: SubscriptionTokens | null = null;
  private cachedModels: SubscriptionModel[] | null = null;
  private refreshInFlight: Promise<SubscriptionTokens | null> | null = null;
  private refreshController: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private activeLogin: { generation: number; server: CallbackServer; controller: AbortController } | null = null;
  private requestControllers = new Set<AbortController>();
  private generation = 0;
  private signedOut = false;
  private backgroundRefreshFailures = 0;
  private lastError: string | undefined;
  private static tokenStore: SubscriptionTokenStore | null = null;
  /** OAuth client credentials saved via Settings (env vars take precedence). */
  public static oauthClientId = '';
  public static oauthClientSecret = '';

  private constructor() { super(); }

  /**
   * Save the Google OAuth client credentials for this session. Called at
   * startup from the stored settings and whenever the user updates them.
   */
  public static configureOAuthCredentials(clientId: string, clientSecret: string): void {
    GeminiSubscriptionService.oauthClientId = (clientId || '').trim();
    GeminiSubscriptionService.oauthClientSecret = (clientSecret || '').trim();
  }

  /**
   * The host app provides the token store before first use (Phantom Lens
   * supplies a safeStorage-backed store). Kept injectable so this service
   * stays decoupled from any particular credential manager.
   */
  public static configureStore(store: SubscriptionTokenStore): void {
    GeminiSubscriptionService.tokenStore = store;
  }

  private requireStore(): SubscriptionTokenStore {
    const store = GeminiSubscriptionService.tokenStore;
    if (!store) {
      throw new SubscriptionError('storage', 'Google subscription storage is not configured.');
    }
    return store;
  }

  public static getInstance(): GeminiSubscriptionService {
    const global = globalThis as unknown as Record<string, GeminiSubscriptionService | undefined>;
    if (!global.__phantomLensSubscriptionServiceV1__) global.__phantomLensSubscriptionServiceV1__ = new GeminiSubscriptionService();
    return global.__phantomLensSubscriptionServiceV1__;
  }

  public initialize(): void {
    this.signedOut = false;
    this.backgroundRefreshFailures = 0;
    this.stopRefreshTimer();
    this.cachedTokens = this.loadFromStorage();
    this.lastError = undefined;
    this.scheduleRefresh();
    this.emit('status-changed', this.getStatus());
  }

  public dispose(): void {
    this.generation += 1;
    this.stopRefreshTimer();
    this.activeLogin?.controller.abort();
    this.activeLogin?.server.close(new SubscriptionError('cancelled', 'Google subscription sign-in cancelled.'));
    this.activeLogin = null;
    this.refreshController?.abort();
    this.refreshController = null;
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    this.refreshInFlight = null;
  }

  public getStatus(): SubscriptionStatus {
    const tokens = this.signedOut ? null : (this.cachedTokens || this.loadFromStorage());
    return {
      signedIn: Boolean(tokens?.accessToken && tokens.refreshToken && tokens.projectId),
      inProgress: Boolean(this.activeLogin),
      ...(tokens ? { expiresAt: tokens.expiresAt, projectId: tokens.projectId } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  public cancelLogin(): boolean {
    if (!this.activeLogin) return false;
    this.generation += 1;
    const active = this.activeLogin;
    active.controller.abort();
    active.server.close(new SubscriptionError('cancelled', 'Google subscription sign-in cancelled.'));
    this.activeLogin = null;
    this.lastError = 'Google subscription sign-in cancelled.';
    this.emit('status-changed', this.getStatus());
    return true;
  }

  public async startLogin(): Promise<SubscriptionTokens> {
    if (this.activeLogin) throw new SubscriptionError('callback', 'Google subscription sign-in is already in progress.');
    const generation = ++this.generation;
    this.signedOut = false;
    const pkce = generateSubscriptionPkce();
    const server = startCallbackServer(pkce.state);
    const controller = new AbortController();
    const active = { generation, server, controller };
    this.activeLogin = active;
    this.lastError = undefined;
    this.emit('status-changed', this.getStatus());
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      try {
        await server.portReady;
      } catch (error) {
        if ((error as any)?.code === 'EADDRINUSE') {
          throw new SubscriptionError('callback', 'Google subscription sign-in callback port is busy. Close the other sign-in window and try again.');
        }
        throw error;
      }
      this.assertGeneration(generation);
      // Resolve credentials before opening the browser so a missing config
      // fails fast with guidance instead of a broken Google page.
      const credentials = resolveOAuthCredentials();
      await shell.openExternal(buildSubscriptionAuthorizationUrl(pkce, credentials)).catch(() => {
        throw new SubscriptionError('browser', 'Could not open the Google sign-in page.');
      });
      const callback = await new Promise<{ code?: string; state?: string; error?: string }>((resolve, reject) => {
        timeout = setTimeout(() => reject(new SubscriptionError('callback', 'Google subscription sign-in timed out.')), 5 * 60_000);
        server.callback.then(resolve, reject);
      });
      this.assertGeneration(generation);
      if (callback.error) throw new SubscriptionError('callback', 'Google subscription sign-in was denied.');
      if (callback.state !== pkce.state) throw new SubscriptionError('callback', 'Google subscription sign-in state did not match. Start again.');
      if (!callback.code?.trim()) throw new SubscriptionError('callback', 'Google returned no authorization code.');

      const exchanged = await this.exchangeCode(callback.code, pkce.verifier, controller.signal);
      this.assertGeneration(generation);
      // No silent fallback to a shared project: if onboarding yields no
      // project, discoverProject throws 'setup_no_project' carrying Google's
      // own ineligible-tier reasons, which surfaces verbatim in settings so
      // the user knows exactly why instead of chatting on borrowed quota.
      const projectId = await discoverProject(exchanged.accessToken, controller.signal);
      this.assertGeneration(generation);
      const tokens = { ...exchanged, projectId };
      if (!this.saveToStorage(tokens)) throw new SubscriptionError('storage', 'Google subscription sign-in could not be saved. Check credential storage and try again.');
      this.cachedTokens = tokens;
      this.cachedModels = null;
      this.lastError = undefined;
      this.scheduleRefresh();
      this.emit('status-changed', this.getStatus());
      return tokens;
    } catch (error) {
      const normalized = this.normalizeError(error, 'Google subscription sign-in failed.');
      if (generation === this.generation) {
        this.lastError = normalized.message;
        this.emit('status-changed', this.getStatus());
      }
      throw normalized;
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      server.close();
      if (this.activeLogin === active) this.activeLogin = null;
      this.emit('status-changed', this.getStatus());
    }
  }

  public signOut(): { success: boolean; error?: string } {
    // Commit the durable change first. A failed disconnect must not appear to
    // succeed in memory and then silently reconnect from retained tokens on restart.
    if (!this.clearStorage()) {
      this.lastError = 'Disconnect failed: Google subscription credentials could not be cleared. Try disconnecting again.';
      this.emit('status-changed', this.getStatus());
      return { success: false, error: this.lastError };
    }
    this.generation += 1;
    this.signedOut = true;
    this.stopRefreshTimer();
    this.refreshController?.abort();
    this.refreshController = null;
    this.activeLogin?.controller.abort();
    this.activeLogin?.server.close(new SubscriptionError('cancelled', 'Google subscription sign-in cancelled.'));
    this.activeLogin = null;
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    this.cachedTokens = null;
    this.cachedModels = null;
    this.lastError = undefined;
    this.emit('models-changed', []);
    this.emit('status-changed', this.getStatus());
    return { success: true };
  }

  public async getAccessToken(): Promise<string | null> {
    if (this.signedOut) return null;
    const tokens = this.cachedTokens || this.loadFromStorage();
    if (!tokens?.refreshToken) return null;
    if (tokens.accessToken && tokens.expiresAt - Date.now() > SUBSCRIPTION_REFRESH_LEAD_MS) return tokens.accessToken;
    return (await this.refreshTokens())?.accessToken || null;
  }

  public async refreshTokens(): Promise<SubscriptionTokens | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (this.signedOut) return null;
    const generation = this.generation;
    const controller = new AbortController();
    this.refreshController = controller;
    const run = (async () => {
      const previous = this.signedOut ? null : (this.cachedTokens || this.loadFromStorage());
      if (!previous?.refreshToken) return null;
      const credentials = resolveOAuthCredentials();
      let response: Response;
      try {
        response = await fetchWithDnsRetry(SUBSCRIPTION_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': GOOGLE_API_USER_AGENT },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            refresh_token: previous.refreshToken.trim(),
            grant_type: 'refresh_token',
          }).toString(),
          signal: controller.signal,
        }, 4);
      } catch (error) {
        throw this.normalizeError(error, 'Google subscription token refresh failed.');
      }
      let bundle: any;
      try { bundle = await responseJson(response, 'token_refresh'); } catch (error) {
        if (error instanceof SubscriptionError && error.code === 'auth_revoked' && generation === this.generation) {
          this.markSignedOut(error.message);
        }
        throw error;
      }
      if (generation !== this.generation) throw new SubscriptionError('cancelled', 'Google request cancelled.');
      if (typeof bundle?.access_token !== 'string' || !bundle.access_token) {
        throw new SubscriptionError('token_refresh', 'Google token refresh returned no access token.');
      }
      const refreshToken = typeof bundle.refresh_token === 'string' && bundle.refresh_token.trim()
        ? bundle.refresh_token.trim() : previous.refreshToken;
      const expiresIn = typeof bundle.expires_in === 'number' && Number.isFinite(bundle.expires_in)
        ? bundle.expires_in : 3600;
      if (expiresIn <= 0) throw new SubscriptionError('token_refresh', 'Google returned an expired access token.');
      const next = {
        accessToken: bundle.access_token,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        projectId: previous.projectId,
      };
      if (!this.saveToStorage(next)) throw new SubscriptionError('storage', 'Google token refresh could not be saved.');
      if (generation !== this.generation) throw new SubscriptionError('cancelled', 'Google request cancelled.');
      this.cachedTokens = next;
      this.signedOut = false;
      this.backgroundRefreshFailures = 0;
      this.lastError = undefined;
      this.scheduleRefresh();
      this.emit('status-changed', this.getStatus());
      return next;
    })();
    let wrapped!: Promise<SubscriptionTokens | null>;
    const handled = run.catch((error) => {
      const normalized = this.normalizeError(error, 'Google subscription token refresh failed.');
      if (generation === this.generation && normalized.code !== 'cancelled') {
        this.lastError = normalized.message;
        this.emit('status-changed', this.getStatus());
      }
      throw normalized;
    });
    wrapped = handled.finally(() => {
      if (this.refreshInFlight === wrapped) this.refreshInFlight = null;
      if (this.refreshController === controller) this.refreshController = null;
    });
    this.refreshInFlight = wrapped;
    return wrapped;
  }

  private async authenticatedFetch(url: string, init: RequestInit, token: string, retries: number, timeoutMs = SUBSCRIPTION_FETCH_TIMEOUT_MS): Promise<Response> {
    const generation = this.generation;
    const send = (accessToken: string) => fetchWithDnsRetry(url, {
      ...init, headers: { 'Content-Type': 'application/json', 'User-Agent': SUBSCRIPTION_USER_AGENT,
        ...init.headers, Authorization: `Bearer ${accessToken}` },
    }, retries, timeoutMs);
    try {
      init.signal?.throwIfAborted();
      const response = await send(token);
      if (response.status !== 401) return response;
      try { await response.body?.cancel(); } catch { /* noop */ }
      this.assertGeneration(generation);
      init.signal?.throwIfAborted();
      const refreshed = await this.refreshTokens();
      this.assertGeneration(generation);
      init.signal?.throwIfAborted();
      if (!refreshed) throw new SubscriptionError('auth_required', 'Sign in with your Google subscription first.');
      return await send(refreshed.accessToken);
    } catch (error) { throw this.normalizeError(error, 'Google request failed.'); }
  }

  /**
   * The last discovered catalogue, or null if discovery has not run this
   * session. Synchronous on purpose: the caller builds its fallback rungs
   * inline and cannot await, and a rung that cannot NAME a model must not be
   * seated at all - sending an arbitrary id to the backend would fail at the
   * wire rather than fall through to the next provider.
   */
  public getCachedModels(): SubscriptionModel[] | null {
    return this.cachedModels ? this.cachedModels.map(model => ({ ...model })) : null;
  }

  public async getModels(force = false): Promise<SubscriptionModel[]> {
    if (this.signedOut) throw new SubscriptionError('auth_required', 'Sign in with your Google subscription first.');
    if (!force && this.cachedModels) return this.cachedModels.map(model => ({ ...model }));
    const generation = this.generation;
    const token = await this.getAccessToken();
    this.assertGeneration(generation);
    if (!token) throw new SubscriptionError('auth_required', this.lastError || 'Sign in with your Google subscription first.');
    const projectId = this.cachedTokens?.projectId || this.loadFromStorage()?.projectId;
    if (!projectId) throw new SubscriptionError('setup', 'Google subscription setup has no project. Sign in again.');
    const request = this.registerRequest();
    try {
      const response = await this.authenticatedFetch(`${SUBSCRIPTION_DAILY_ENDPOINT}/v1internal:fetchAvailableModels`, {
        method: 'POST', body: JSON.stringify({ project: projectId }), signal: request.signal,
      }, token, 12);
      const catalog = await responseJson(response, 'models');
      if (generation !== this.generation || this.signedOut) throw new SubscriptionError('cancelled', 'Google request cancelled.');
      const models = parseSubscriptionModels(catalog);
      this.cachedModels = models;
      this.emit('models-changed', models.map(model => ({ ...model })));
      return models.map(model => ({ ...model }));
    } finally {
      request.dispose();
    }
  }

  /**
   * Stream a chat completion through the subscription backend.
   *
   * The requested model is mapped to its "-tiered" wire id first; if the
   * backend rejects that id outright (HTTP 400 - usually a renamed catalogue),
   * the call retries once with the first model the account's own catalogue
   * actually serves, instead of failing with a bare 400.
   */
  public async *stream(input: SubscriptionStreamInput): AsyncGenerator<string, void, unknown> {
    const wireModel = resolveSubscriptionWireModel(input.model);
    try {
      yield* this.streamWithWireModel(input, wireModel);
    } catch (error) {
      if (!(error instanceof SubscriptionError) || error.code !== 'request' || error.status !== 400) throw error;
      const models = await this.getModels().catch(() => [] as SubscriptionModel[]);
      const fallback = models.find((m) => m.id !== wireModel)?.id ?? models[0]?.id;
      if (!fallback || fallback === wireModel) throw error;
      yield* this.streamWithWireModel(input, fallback);
    }
  }

  private async *streamWithWireModel(input: SubscriptionStreamInput, wireModel: string): AsyncGenerator<string, void, unknown> {
    if (this.signedOut) throw new SubscriptionError('auth_required', 'Sign in with your Google subscription first.');
    const generation = this.generation;
    const token = await this.getAccessToken();
    this.assertGeneration(generation);
    if (!token) throw new SubscriptionError('auth_required', this.lastError || 'Sign in with your Google subscription first.');
    const projectId = this.cachedTokens?.projectId || this.loadFromStorage()?.projectId || '';
    const payload = buildSubscriptionRequestPayload({ ...input, projectId, wireModel });
    const request = this.registerRequest(input.signal);
    let streamTimedOut = false;
    const streamDeadline = setTimeout(() => { streamTimedOut = true; request.abort(); }, 60_000);
    (streamDeadline as any).unref?.();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await this.authenticatedFetch(SUBSCRIPTION_STREAM_URL, {
        method: 'POST', headers: { Accept: 'text/event-stream', 'x-request-source': 'local' },
        body: JSON.stringify(payload), signal: request.signal,
      }, token, 4, SUBSCRIPTION_STREAM_TIMEOUT_MS);
      if (!response.ok) {
        const status = response.status;
        const message = status === 401
          ? 'Google access was rejected. Refresh the session or sign in again.'
          : status === 403
            ? 'This Google account is not permitted to use the subscription API.'
          : status === 429
            ? 'Google quota is exhausted or temporarily limited. Try again later.'
            : `Google request failed (HTTP ${status}).`;
        const error = new SubscriptionError('request', message, status);
        throw error;
      }
      if (!response.body) throw new SubscriptionError('response', 'Google returned an empty response.');

      // The backend can also answer with a single JSON Code Assist response.
      if (response.headers.get('content-type')?.includes('application/json')) {
        const text = parseSubscriptionEvent(await response.text());
        this.assertGeneration(generation);
        if (!text) throw new SubscriptionError('response', 'Google returned no answer.');
        yield text;
        return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let emitted = false;
      streamLoop: while (true) {
        const item = await reader.read();
        this.assertGeneration(generation);
        if (request.signal.aborted) throw new SubscriptionError('cancelled', 'Google request cancelled.');
        buffer += item.done ? decoder.decode() : decoder.decode(item.value, { stream: true });
        const parsed = parseSubscriptionSse(buffer, item.done);
        buffer = parsed.remainder;
        for (const data of parsed.events) {
          if (data === '[DONE]') break streamLoop;
          const text = parseSubscriptionEvent(data);
          if (text) { emitted = true; yield text; }
        }
        if (item.done) break;
      }
      if (generation !== this.generation || this.signedOut) throw new SubscriptionError('cancelled', 'Google request cancelled.');
      if (!emitted) throw new SubscriptionError('response', 'Google returned no answer.');
    } catch (error) {
      if (error instanceof SubscriptionError && error.code === 'auth_revoked') throw error;
      if (input.signal?.aborted || (request.signal.aborted && !streamTimedOut && this.generation !== generation)) {
        throw new SubscriptionError('cancelled', 'Google request cancelled.');
      }
      if (streamTimedOut) throw new SubscriptionError('request', 'Google request timed out.');
      throw this.normalizeError(error, 'Google returned malformed streaming data.');
    } finally {
      try { await reader?.cancel(); } catch { /* noop */ }
      try { reader?.releaseLock(); } catch { /* noop */ }
      clearTimeout(streamDeadline);
      request.dispose();
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new SubscriptionError('cancelled', 'Google request cancelled.');
  }

  private normalizeError(error: unknown, fallback: string): SubscriptionError {
    if (error instanceof SubscriptionError) return error;
    if ((error as any)?.name === 'AbortError') return new SubscriptionError('cancelled', 'Google request cancelled.');
    return new SubscriptionError('request', fallback);
  }

  private registerRequest(externalSignal?: AbortSignal): {
    signal: AbortSignal;
    abort: () => void;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    this.requestControllers.add(controller);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => {
        externalSignal?.removeEventListener('abort', forwardAbort);
        this.requestControllers.delete(controller);
      },
    };
  }

  private markSignedOut(message: string): void {
    this.generation += 1;
    this.signedOut = true;
    this.cachedTokens = null;
    this.cachedModels = null;
    this.stopRefreshTimer();
    for (const controller of this.requestControllers) controller.abort();
    this.lastError = message;
    this.clearStorage();
    this.emit('models-changed', []);
    this.emit('status-changed', this.getStatus());
  }

  private loadFromStorage(): SubscriptionTokens | null {
    return this.requireStore().loadTokens();
  }

  private saveToStorage(tokens: SubscriptionTokens): boolean {
    return this.requireStore().saveTokens(tokens);
  }

  private clearStorage(): boolean {
    return this.requireStore().clearTokens();
  }

  private scheduleRefresh(retryDelay?: number): void {
    this.stopRefreshTimer();
    const tokens = this.signedOut ? null : (this.cachedTokens || this.loadFromStorage());
    if (!tokens) return;
    const delay = retryDelay ?? Math.max(1_000, tokens.expiresAt - Date.now() - SUBSCRIPTION_REFRESH_LEAD_MS);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshTokens().catch(() => {
        // A temporary outage should get a few bounded retries, while a revoked
        // account is already cleared by refreshTokens(). Never create a hot loop.
        if (!this.signedOut && this.cachedTokens && this.backgroundRefreshFailures < 3) {
          this.backgroundRefreshFailures += 1;
          this.scheduleRefresh(Math.min(30_000 * (2 ** (this.backgroundRefreshFailures - 1)), 120_000));
        }
      });
    }, delay);
    (this.refreshTimer as any).unref?.();
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<Omit<SubscriptionTokens, 'projectId'>> {
    const credentials = resolveOAuthCredentials();
    let response: Response;
    try {
      response = await fetchWithDnsRetry(SUBSCRIPTION_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': GOOGLE_API_USER_AGENT },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: SUBSCRIPTION_REDIRECT_URI,
          code_verifier: verifier,
        }).toString(),
        signal,
      }, 4);
    } catch (error) { throw this.normalizeError(error, 'Google subscription token exchange failed.'); }
    const bundle = await responseJson(response, 'token_exchange');
    if (typeof bundle?.access_token !== 'string' || !bundle.access_token) {
      throw new SubscriptionError('token_exchange', 'Google token exchange returned no access token.');
    }
    if (typeof bundle.refresh_token !== 'string' || !bundle.refresh_token.trim()) {
      throw new SubscriptionError('token_exchange', 'Google did not return a refresh token. Sign in again.');
    }
    const expiresIn = typeof bundle.expires_in === 'number' && Number.isFinite(bundle.expires_in)
      ? bundle.expires_in : 3600;
    if (expiresIn <= 0) throw new SubscriptionError('token_exchange', 'Google returned an expired access token.');
    return {
      accessToken: bundle.access_token,
      refreshToken: bundle.refresh_token.trim(),
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}

let cleanupSubscriptionLifecycle: (() => void) | undefined;

export function initializeSubscriptionLifecycle(app: EventEmitter, onStatus: (status: SubscriptionStatus) => void, onModels: () => void): void {
  const service = GeminiSubscriptionService.getInstance();
  cleanupSubscriptionLifecycle?.();
  service.initialize();
  const onQuit = () => service.dispose();
  app.once('before-quit', onQuit);
  service.on('status-changed', onStatus);
  service.on('models-changed', onModels);
  cleanupSubscriptionLifecycle = () => {
    app.off('before-quit', onQuit);
    service.off('status-changed', onStatus);
    service.off('models-changed', onModels);
  };
}

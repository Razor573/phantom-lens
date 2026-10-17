/**
 * Minimal OAuth callback page for the Google subscription sign-in flow.
 *
 * Served by the loopback HTTP server on 127.0.0.1 after Google redirects
 * back with the authorization code. No scripts, no external assets - just a
 * status card telling the user they can close the tab and go back to the app.
 */

import * as crypto from 'crypto';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turns an OAuth `error` / `error_description` pair into one plain sentence. */
export function describeOAuthError(error?: string | null, description?: string | null): string {
  const code = (error || '').trim();
  const detail = (description || '').trim();
  if (code === 'access_denied') return 'Access was declined on the Google consent screen.';
  if (detail) return detail.slice(0, 300);
  if (code) return `Google returned "${code.slice(0, 80)}".`;
  return 'The sign-in response was incomplete.';
}

export interface SubscriptionCallbackPage {
  headers: Record<string, string>;
  body: string;
}

export function renderSubscriptionCallbackPage(
  outcome: { kind: 'returned' } | { kind: 'error'; reason: string },
  platform: NodeJS.Platform,
): SubscriptionCallbackPage {
  const nonce = crypto.randomBytes(16).toString('base64');
  const ok = outcome.kind === 'returned';
  const closeKeys = platform === 'darwin' ? '⌘W' : 'Ctrl+W';
  const headline = ok ? 'Signed in with Google' : 'Could not sign in';
  const sub = ok
    ? 'Phantom Lens is finishing setup. Head back to the app - your Google subscription is now connected.'
    : 'Nothing was connected. Try again from Phantom Lens settings.';
  const reason = !ok ? (outcome as { reason: string }).reason : '';

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(headline)} - Phantom Lens</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:#0b0d12;color:#f5f5f7}
  @media (prefers-color-scheme: light){body{background:#f2f2f7;color:#1d1d1f}}
  .card{max-width:420px;text-align:center;padding:36px 28px;border-radius:20px;
    background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}
  @media (prefers-color-scheme: light){.card{background:#fff;border-color:rgba(0,0,0,.08);
    box-shadow:0 24px 48px -28px rgba(20,30,60,.25)}}
  .dot{width:52px;height:52px;border-radius:50%;margin:0 auto 18px;display:grid;
    place-items:center;font-size:24px;
    background:${ok ? 'rgba(52,211,153,.15)' : 'rgba(255,105,97,.15)'}}
  h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}
  p{margin:0;color:#a1a1a6;font-size:14px;line-height:1.5}
  @media (prefers-color-scheme: light){p{color:#6e6e73}}
  .reason{margin-top:14px;font-size:13px;padding:10px 12px;border-radius:10px;
    background:rgba(255,105,97,.1);color:#ff8a80;text-align:left;overflow-wrap:anywhere}
  .close{margin-top:18px;font-size:13px;color:#8e8e93}
</style>
</head>
<body>
<main class="card" role="status">
  <div class="dot">${ok ? '✓' : '!'}</div>
  <h1>${escapeHtml(headline)}</h1>
  <p>${escapeHtml(sub)}</p>
  ${reason ? `<p class="reason">${escapeHtml(reason)}</p>` : ''}
  <p class="close">You can close this tab (${escapeHtml(closeKeys)}).</p>
</main>
<script nonce="${nonce}"></script>
</body>
</html>`;

  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body,
  };
}

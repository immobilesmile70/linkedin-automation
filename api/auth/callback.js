import { exchangeCode, fetchProfile } from '../../lib/linkedin.js';
import { requireEnv } from '../../lib/env.js';
import { escapeHtml, noStore, parseCookies, resolveRedirectUri } from '../../lib/http.js';

export const config = { maxDuration: 30 };

const CLEAR_STATE_COOKIE = 'li_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

function page({ title, body }, status = 200) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #0b0d12; color: #e6e8ee; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: #8b93a7; margin: 32px 0 10px; }
  p { margin: 0 0 12px; color: #b9bfcd; }
  a { color: #7cc4ff; }
  .card { background: #14171f; border: 1px solid #232936; border-radius: 14px; padding: 20px; margin-top: 20px; }
  .warn { border-color: #5a3b16; background: #22190d; color: #f3c98b; }
  .field { margin: 0 0 18px; }
  .label { font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #8b93a7; letter-spacing: .04em; margin-bottom: 6px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; background: #0b0d12; color: #dfe4ee; border: 1px solid #2a3140; border-radius: 8px; padding: 10px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .note { color: #8b93a7; font-size: 13px; margin: 6px 0 0; }
  code { background: #0b0d12; border: 1px solid #2a3140; border-radius: 6px; padding: 2px 6px; font-size: 13px; }
  .ok { color: #6ee7a8; }
  .bad { color: #ff9a9a; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function field(name, value, note = '') {
  if (!value) return '';
  return `<div class="field">
    <div class="label">${escapeHtml(name)}</div>
    <textarea readonly rows="${value.length > 90 ? 3 : 2}" onclick="this.select()">${escapeHtml(value)}</textarea>
    ${note ? `<p class="note">${note}</p>` : ''}
  </div>`;
}

function expiredMessage(expiresIn) {
  if (!expiresIn) return '';
  const date = new Date(Date.now() + expiresIn * 1000);
  return `Expires ${date.toISOString()} (in ${Math.round(expiresIn / 86400)} days).`;
}

export default async function handler(req, res) {
  noStore(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const url = new URL(req.url || '/api/auth/callback', 'http://localhost');
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req.headers?.cookie);
  const expectedState = cookies.li_oauth_state;

  res.setHeader('Set-Cookie', CLEAR_STATE_COOKIE);

  if (error) {
    res.status(400).send(
      page({
        title: 'LinkedIn sign-in cancelled',
        body: `<h1 class="bad">LinkedIn returned an error</h1>
          <p><code>${escapeHtml(error)}</code> ${escapeHtml(url.searchParams.get('error_description') || '')}</p>
          <p><a href="/api/auth/login">Try again</a></p>`,
      }),
    );
    return;
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    res.status(400).send(
      page({
        title: 'LinkedIn sign-in failed',
        body: `<h1 class="bad">OAuth state check failed</h1>
          <p>The callback did not match the sign-in attempt. Start again from the same browser.</p>
          <p><a href="/api/auth/login">Retry</a></p>`,
      }),
    );
    return;
  }

  try {
    const clientId = requireEnv(process.env, 'LINKEDIN_CLIENT_ID');
    const clientSecret = requireEnv(process.env, 'LINKEDIN_CLIENT_SECRET');
    const redirectUri = resolveRedirectUri(req, process.env);

    const tokens = await exchangeCode({ code, redirectUri, clientId, clientSecret });
    const profile = await fetchProfile(tokens.accessToken);

    const refreshNote = tokens.refreshToken
      ? 'Store this too: the cron job exchanges it for a fresh access token on every run.'
      : 'LinkedIn did not issue a refresh token for this app. Use LINKEDIN_ACCESS_TOKEN and re-run this flow before it expires.';

    res.status(200).send(
      page({
        title: 'LinkedIn connected',
        body: `<h1>LinkedIn connected <span class="ok">✓</span></h1>
          <p>${escapeHtml(profile.name || 'Member')} · <code>${escapeHtml(profile.personUrn)}</code></p>

          <div class="card warn">
            <strong>These are live credentials.</strong> Copy them into Vercel → Project → Settings → Environment
            Variables (Production + Preview), then close this tab. Anyone with this page's values can post as you.
          </div>

          ${field('LINKEDIN_ACCESS_TOKEN', tokens.accessToken, expiredMessage(tokens.expiresIn))}
          ${field('LINKEDIN_REFRESH_TOKEN', tokens.refreshToken, refreshNote)}
          ${field('LINKEDIN_PERSON_URN', profile.personUrn, 'Optional. Setting it saves one API call per run.')}
          ${tokens.scope ? `<p class="note">Granted scopes: <code>${escapeHtml(tokens.scope)}</code></p>` : ''}
          ${
            tokens.refreshToken
              ? ''
              : `<div class="card warn" style="margin-top:24px">
                   <strong>No refresh token.</strong> The LinkedIn app needs the “Programmatic Refresh Tokens” setting
                   (or the Share on LinkedIn product) before LinkedIn issues one. Until then the cron job needs a
                   fresh LINKEDIN_ACCESS_TOKEN every ~60 days.
                 </div>`
          }

          <h2>Next</h2>
          <p>Trigger a safe test that generates the post and image without publishing:</p>
          <p><code>curl -H "Authorization: Bearer $CRON_SECRET" "$PUBLIC_BASE_URL/api/cron?dry=1"</code></p>
          <p><a href="/">Back to the dashboard</a></p>`,
      }),
    );
  } catch (err) {
    console.error('[auth/callback] failed:', err?.name, err?.message);
    res.status(500).send(
      page({
        title: 'LinkedIn sign-in failed',
        body: `<h1 class="bad">Token exchange failed</h1>
          <p>${escapeHtml(err?.message || 'Unknown error')}</p>
          <p>Check that <code>LINKEDIN_REDIRECT_URI</code> exactly matches the redirect URL registered in the
          LinkedIn app, and that the client id/secret are for the same app.</p>
          <p><a href="/api/auth/login">Retry</a></p>`,
      }),
    );
  }
}

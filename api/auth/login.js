import crypto from 'node:crypto';
import { buildAuthorizeUrl } from '../../lib/linkedin.js';
import { requireEnv } from '../../lib/env.js';
import { noStore, resolveOrigin, resolveRedirectUri } from '../../lib/http.js';

export default async function handler(req, res) {
  noStore(res);

  try {
    const clientId = requireEnv(process.env, 'LINKEDIN_CLIENT_ID');
    const origin = resolveOrigin(req, process.env);
    const redirectUri = resolveRedirectUri(req, process.env);
    const state = crypto.randomBytes(24).toString('hex');
    const secure = origin.startsWith('https://') ? '; Secure' : '';

    res.setHeader(
      'Set-Cookie',
      `li_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
    );
    res.statusCode = 302;
    res.setHeader('Location', buildAuthorizeUrl({ clientId, redirectUri, state }));
    res.end();
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || 'Could not start LinkedIn sign-in.',
      hint: 'Add LINKEDIN_CLIENT_ID in Vercel, and register the redirect URI shown by /api/auth/callback in your LinkedIn app.',
    });
  }
}

import { optionalEnv } from './env.js';

export function headerValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function resolveOrigin(req, env = process.env) {
  const configured = optionalEnv(env, 'PUBLIC_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');

  const host = headerValue(req.headers?.['x-forwarded-host']) || headerValue(req.headers?.host);
  if (!host) throw new Error('Could not determine the request host. Set PUBLIC_BASE_URL.');

  const proto =
    headerValue(req.headers?.['x-forwarded-proto']) ||
    (String(host).startsWith('localhost') || String(host).startsWith('127.0.0.1') ? 'http' : 'https');

  return `${proto}://${host}`;
}

export function resolveRedirectUri(req, env = process.env) {
  return optionalEnv(env, 'LINKEDIN_REDIRECT_URI') || `${resolveOrigin(req, env)}/api/auth/callback`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      if (!key) return;
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    });
  return out;
}

export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

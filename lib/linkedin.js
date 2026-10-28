const API_BASE = 'https://api.linkedin.com';
const OAUTH_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const OAUTH_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';

export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'];

/** LinkedIn versioned APIs are pinned to a YYYYMM release and supported for ~1 year. */
export const DEFAULT_API_VERSION = '202610';

/**
 * LinkedIn requires exactly YYYYMM. Accepts 202510, 20251001, 2025-10 and similar input
 * and returns the matching release, falling back to the pinned default when unusable.
 */
export function resolveApiVersion(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  const match = /^(\d{4})(\d{2})(?:\d{2})?$/.exec(digits);
  if (!match) return DEFAULT_API_VERSION;

  const month = Number(match[2]);
  if (month < 1 || month > 12) return DEFAULT_API_VERSION;

  return `${match[1]}${match[2]}`;
}

export class LinkedInError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LinkedInError';
    this.statusCode = status;
  }
}

/**
 * LinkedIn parses commentary as "little text": unescaped reserved characters make the
 * post get truncated server-side. A leading backslash escapes them and is not rendered.
 */
export function escapeLittleText(text) {
  return String(text ?? '').replace(/[\\()[\]{}<>@|~_*]/g, (char) => `\\${char}`);
}

async function readBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFailure(res, body, status, { version } = {}) {
  const detail =
    typeof body === 'string'
      ? body
      : body?.message || body?.error_description || body?.error || JSON.stringify(body);
  let message = `LinkedIn API ${status} on ${res.url}: ${String(detail).slice(0, 400)}`;
  if (status === 426) {
    message +=
      ` LinkedIn rejected LinkedIn-Version: ${version || 'missing'}.` +
      ' The header must be a YYYYMM release that has not been sunset' +
      ` (latest as of build: ${DEFAULT_API_VERSION}); set LINKEDIN_API_VERSION to match.`;
  }
  return message;
}

function restHeaders(token, version, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': resolveApiVersion(version),
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  };
}

async function restFetch(path, { token, method = 'GET', body, version, headers = {} } = {}) {
  const sentVersion = resolveApiVersion(version);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: restHeaders(token, sentVersion, headers),
    body,
  });

  const parsed = await readBody(res);
  if (!res.ok) {
    throw new LinkedInError(
      describeFailure(res, parsed, res.status, { version: sentVersion }),
      res.status === 401 ? 401 : 502,
    );
  }
  return { res, data: parsed };
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, scopes = LINKEDIN_SCOPES }) {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  const data = await readBody(res);
  if (!res.ok) {
    throw new LinkedInError(describeFailure(res, data, res.status), 502);
  }
  if (!data?.access_token) {
    throw new LinkedInError('LinkedIn token endpoint returned no access_token.');
  }

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || null,
    refreshToken: data.refresh_token || null,
    refreshTokenExpiresIn: Number(data.refresh_token_expires_in) || null,
    scope: data.scope || null,
  };
}

export function exchangeCode({ code, redirectUri, clientId, clientSecret }) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

export function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

export async function fetchProfile(token) {
  const res = await fetch(`${API_BASE}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await readBody(res);
  if (!res.ok) throw new LinkedInError(describeFailure(res, data, res.status));
  if (!data?.sub) {
    throw new LinkedInError('LinkedIn userinfo did not return a member id.');
  }
  const name = [data.given_name, data.family_name].filter(Boolean).join(' ') || data.name || '';
  return { personUrn: `urn:li:person:${data.sub}`, name, email: data.email || null };
}

export async function fetchPersonUrn(token) {
  try {
    const { personUrn } = await fetchProfile(token);
    return personUrn;
  } catch (err) {
    const hint =
      'Set LINKEDIN_PERSON_URN explicitly (the /api/auth/callback page prints it) if the profile scope is unavailable.';
    throw new LinkedInError(`${err.message} ${hint}`);
  }
}

export async function initializeImageUpload({ token, ownerUrn, version }) {
  const { data } = await restFetch('/rest/images?action=initializeUpload', {
    token,
    version,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });

  const value = data?.value;
  if (!value?.uploadUrl || !value?.image) {
    throw new LinkedInError('LinkedIn initializeUpload response was missing uploadUrl or image.');
  }

  return { uploadUrl: value.uploadUrl, imageUrn: value.image };
}

async function putImage(uploadUrl, { token, bytes, contentType }) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });

  if (!res.ok) {
    const body = await readBody(res);
    throw new LinkedInError(describeFailure(res, body, res.status));
  }
}

export async function uploadImage({ token, ownerUrn, bytes, contentType, version }) {
  const upload = await initializeImageUpload({ token, ownerUrn, version });
  await putImage(upload.uploadUrl, { token, bytes, contentType });
  return { imageUrn: upload.imageUrn };
}

function postBody({ authorUrn, text, imageUrn, altText }) {
  const body = {
    author: authorUrn,
    commentary: escapeLittleText(text),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    body.content = {
      media: {
        id: imageUrn,
        altText: String(altText || text).slice(0, 200),
      },
    };
  }

  return body;
}

export async function createImagePost({ token, authorUrn, text, imageUrn, altText, version }) {
  const { res } = await restFetch('/rest/posts', {
    token,
    version,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody({ authorUrn, text, imageUrn, altText })),
  });

  return { postId: res.headers.get('x-restli-id') || null, status: res.status };
}

export async function createTextPost({ token, authorUrn, text, version }) {
  const { res } = await restFetch('/rest/posts', {
    token,
    version,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody({ authorUrn, text })),
  });

  return { postId: res.headers.get('x-restli-id') || null, status: res.status };
}

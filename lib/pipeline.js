import { ConfigError, optionalEnv, requireEnv } from './env.js';
import { generatePost, DEFAULT_MODEL } from './openrouter.js';
import { generateImage } from './image.js';
import {
  createImagePost,
  createTextPost,
  DEFAULT_API_VERSION,
  fetchPersonUrn,
  refreshAccessToken,
  uploadImage,
} from './linkedin.js';

const DEFAULT_TOPIC =
  'A concrete lesson from building an automation or AI workflow, with what broke and what you changed';

function collectMissing(env, dryRun) {
  const missing = [];
  ['OPENROUTER_API_KEY', 'IMAGE_API_URL', 'IMAGE_API_KEY'].forEach((name) => {
    if (!optionalEnv(env, name)) missing.push(name);
  });

  if (dryRun) return missing;

  const hasRefresh = Boolean(optionalEnv(env, 'LINKEDIN_REFRESH_TOKEN'));
  const hasAccess = Boolean(optionalEnv(env, 'LINKEDIN_ACCESS_TOKEN'));

  if (!hasRefresh && !hasAccess) {
    missing.push('LINKEDIN_REFRESH_TOKEN (or LINKEDIN_ACCESS_TOKEN)');
  }
  if (hasRefresh) {
    if (!optionalEnv(env, 'LINKEDIN_CLIENT_SECRET')) missing.push('LINKEDIN_CLIENT_SECRET');
    if (!optionalEnv(env, 'LINKEDIN_CLIENT_ID')) missing.push('LINKEDIN_CLIENT_ID');
  }

  return missing;
}

export function assertConfig(env, dryRun = false) {
  const missing = collectMissing(env, dryRun);
  if (missing.length) {
    throw new ConfigError(`Missing environment variables: ${missing.join(', ')}`);
  }
}

export async function resolveAccessToken(env) {
  const refreshToken = optionalEnv(env, 'LINKEDIN_REFRESH_TOKEN');

  if (refreshToken) {
    const result = await refreshAccessToken({
      refreshToken,
      clientId: requireEnv(env, 'LINKEDIN_CLIENT_ID'),
      clientSecret: requireEnv(env, 'LINKEDIN_CLIENT_SECRET'),
    });

    return {
      token: result.accessToken,
      source: 'LINKEDIN_REFRESH_TOKEN',
      expiresIn: result.expiresIn,
      rotatedRefreshToken: Boolean(result.refreshToken && result.refreshToken !== refreshToken),
    };
  }

  return {
    token: optionalEnv(env, 'LINKEDIN_ACCESS_TOKEN'),
    source: 'LINKEDIN_ACCESS_TOKEN',
    expiresIn: null,
    rotatedRefreshToken: false,
  };
}

export async function generateContent(env, { now = new Date() } = {}) {
  const generated = await generatePost({
    topic: optionalEnv(env, 'POST_TOPIC', DEFAULT_TOPIC),
    tone: optionalEnv(env, 'POST_TONE', 'direct, practical, a little opinionated'),
    audience: optionalEnv(env, 'POST_AUDIENCE', 'engineers and technical founders'),
    model: optionalEnv(env, 'OPENROUTER_MODEL', DEFAULT_MODEL),
    apiKey: requireEnv(env, 'OPENROUTER_API_KEY'),
    siteUrl: optionalEnv(env, 'PUBLIC_BASE_URL', 'https://linkedin-auto-poster.vercel.app'),
  });

  const image = await generateImage({
    prompt: generated.imagePrompt,
    url: requireEnv(env, 'IMAGE_API_URL'),
    apiKey: requireEnv(env, 'IMAGE_API_KEY'),
  });

  return {
    generatedAt: now.toISOString(),
    model: generated.model,
    usage: generated.usage,
    text: generated.text,
    imagePrompt: generated.imagePrompt,
    image: {
      contentType: image.contentType,
      bytes: image.bytes.length,
      data: image.bytes,
    },
  };
}

export async function runCron({ env = process.env, dryRun = false, now = new Date() } = {}) {
  assertConfig(env, dryRun);

  const content = await generateContent(env, { now });
  const summary = {
    dryRun,
    generatedAt: content.generatedAt,
    model: content.model,
    text: content.text,
    imagePrompt: content.imagePrompt,
    image: {
      contentType: content.image.contentType,
      bytes: content.image.bytes,
    },
  };

  if (dryRun) return summary;

  const auth = await resolveAccessToken(env);
  const authorUrn = optionalEnv(env, 'LINKEDIN_PERSON_URN') || (await fetchPersonUrn(auth.token));
  const withImage = optionalEnv(env, 'POST_WITH_IMAGE', 'true').toLowerCase() !== 'false';
  const version = optionalEnv(env, 'LINKEDIN_API_VERSION', DEFAULT_API_VERSION);

  let result;
  if (withImage) {
    const uploaded = await uploadImage({
      token: auth.token,
      ownerUrn: authorUrn,
      bytes: content.image.data,
      contentType: content.image.contentType,
      version,
    });
    result = await createImagePost({
      token: auth.token,
      authorUrn,
      text: content.text,
      imageUrn: uploaded.imageUrn,
      altText: content.imagePrompt,
      version,
    });
  } else {
    result = await createTextPost({ token: auth.token, authorUrn, text: content.text, version });
  }

  const warnings = [];
  if (auth.rotatedRefreshToken) {
    warnings.push(
      'LinkedIn returned a new refresh token. Run the connect flow again and update LINKEDIN_REFRESH_TOKEN in Vercel; the old refresh token may stop working.',
    );
  }

  return {
    ...summary,
    authorUrn,
    postId: result.postId,
    apiVersion: version,
    tokenSource: auth.source,
    tokenExpiresInSeconds: auth.expiresIn,
    refreshTokenRotated: auth.rotatedRefreshToken,
    warnings,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/cron.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

const ENV_KEYS = [
  'CRON_SECRET',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_MAX_TOKENS',
  'OPENROUTER_REASONING_EFFORT',
  'IMAGE_API_URL',
  'IMAGE_API_KEY',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'LINKEDIN_REFRESH_TOKEN',
  'LINKEDIN_ACCESS_TOKEN',
  'LINKEDIN_PERSON_URN',
  'LINKEDIN_API_VERSION',
  'POST_TOPIC',
  'POST_TONE',
  'POST_AUDIENCE',
  'POST_WITH_IMAGE',
  'PUBLIC_BASE_URL',
  'LINKEDIN_REDIRECT_URI',
];

const BASE_ENV = {
  CRON_SECRET: 'test-cron-secret',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  OPENROUTER_MODEL: 'test/model',
  IMAGE_API_URL: 'https://image-worker.test/generate',
  IMAGE_API_KEY: 'test-image-key',
  LINKEDIN_CLIENT_ID: 'test-client-id',
  LINKEDIN_CLIENT_SECRET: 'test-client-secret',
  LINKEDIN_REFRESH_TOKEN: 'test-refresh-token',
  LINKEDIN_PERSON_URN: 'urn:li:person:abc123',
  POST_TOPIC: 'Shipping small automation tools',
};

function setEnv(overrides = {}) {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  const merged = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null && value !== undefined) process.env[key] = String(value);
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function createBackend({ image, openrouter, token, post } = {}) {
  const calls = {
    openrouter: [],
    image: [],
    token: [],
    userinfo: [],
    register: [],
    upload: [],
    post: [],
  };

  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method || 'GET').toUpperCase();

    if (url === process.env.IMAGE_API_URL) {
      calls.image.push({ method, body: JSON.parse(init.body), headers: init.headers });
      return image
        ? image()
        : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }

    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      calls.openrouter.push({ body: JSON.parse(init.body), headers: init.headers });
      return openrouter
        ? openrouter()
        : json({
            model: 'test/model',
            usage: { total_tokens: 321 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: 'Small tools beat big plans (and big budgets).\n\nI shipped a 40-line cron job this week and it already pays for itself.\n\n#automation',
                    image_prompt: 'A tiny workshop bench with one glowing tool',
                  }),
                },
              },
            ],
          });
    }

    if (url === 'https://www.linkedin.com/oauth/v2/accessToken') {
      calls.token.push({ body: String(init.body), headers: init.headers });
      return token
        ? token()
        : json({
            access_token: 'fresh-access-token',
            expires_in: 5_184_000,
            refresh_token: 'test-refresh-token',
            refresh_token_expires_in: 31_536_000,
          });
    }

    if (url === 'https://api.linkedin.com/v2/userinfo') {
      calls.userinfo.push({ headers: init.headers });
      return json({ sub: 'abc123', given_name: 'Test', family_name: 'User' });
    }

    if (url === 'https://api.linkedin.com/rest/images?action=initializeUpload') {
      calls.register.push({ body: JSON.parse(init.body), headers: init.headers });
      return json({
        value: {
          uploadUrl: 'https://media.licdn.test/upload/42',
          image: 'urn:li:image:42',
        },
      });
    }

    if (url === 'https://media.licdn.test/upload/42') {
      calls.upload.push({ method, headers: init.headers, body: init.body });
      return new Response('', { status: 201 });
    }

    if (url === 'https://api.linkedin.com/rest/posts') {
      calls.post.push({ body: JSON.parse(init.body), headers: init.headers });
      return post
        ? post()
        : new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:777' } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  return { calls, fetchImpl };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    end(body) {
      this.body = body;
    },
  };
}

const createReq = ({ method = 'GET', url = '/api/cron', headers = {} } = {}) => ({
  method,
  url,
  headers,
});

async function run(backend, { url = '/api/cron', headers = { authorization: 'Bearer test-cron-secret' } } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = backend.fetchImpl;
  try {
    const res = createRes();
    await handler(createReq({ url, headers }), res);
    return res;
  } finally {
    globalThis.fetch = original;
  }
}

test('rejects a request without the cron secret', async () => {
  setEnv();
  const backend = createBackend();

  const anonymous = await run(backend, { headers: {} });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.ok, false);

  const wrong = await run(backend, { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.statusCode, 401);

  assert.equal(backend.calls.openrouter.length, 0);
});

test('rejects non-GET methods', async () => {
  setEnv();
  const backend = createBackend();
  const original = globalThis.fetch;
  globalThis.fetch = backend.fetchImpl;
  try {
    const res = createRes();
    await handler(createReq({ method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } }), res);
    assert.equal(res.statusCode, 405);
  } finally {
    globalThis.fetch = original;
  }
});

test('names the missing environment variable', async () => {
  setEnv({ OPENROUTER_API_KEY: null });
  const backend = createBackend();

  const res = await run(backend);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /OPENROUTER_API_KEY/);
  assert.equal(backend.calls.image.length, 0);
});

test('dry run generates the post and image without calling LinkedIn', async () => {
  setEnv();
  const backend = createBackend();

  const res = await run(backend, { url: '/api/cron?dry=1' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dryRun, true);
  assert.match(res.body.text, /Small tools beat big plans/);
  assert.equal(res.body.imagePrompt, 'A tiny workshop bench with one glowing tool');
  assert.equal(res.body.image.bytes, PNG.length);
  assert.equal(res.body.image.contentType, 'image/png');

  assert.equal(backend.calls.openrouter.length, 1);
  assert.equal(backend.calls.openrouter[0].body.model, 'test/model');
  assert.equal(backend.calls.openrouter[0].body.messages[1].content.includes('Shipping small automation tools'), true);
  assert.equal(backend.calls.image[0].body.prompt, 'A tiny workshop bench with one glowing tool');
  assert.equal(backend.calls.image[0].headers.Authorization, 'Bearer test-image-key');

  assert.equal(backend.calls.token.length, 0);
  assert.equal(backend.calls.register.length, 0);
  assert.equal(backend.calls.post.length, 0);
});

const TRUNCATED = {
  model: 'google/gemini-3.8-flash',
  usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 780 } },
  choices: [
    {
      finish_reason: 'length',
      message: {
        content:
          '{"text": "I spent the last two months re-architecting an internal web app around streaming LLM outputs. Here ',
      },
    },
  ],
};

const COMPLETE = {
  model: 'google/gemini-3.8-flash',
  usage: { completion_tokens: 940, completion_tokens_details: { reasoning_tokens: 600 } },
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          text: 'Recovered post about streaming outputs.',
          image_prompt: 'A terminal window glowing in a dark room',
        }),
      },
    },
  ],
};

test('gives reasoning models a token budget big enough for the JSON', async () => {
  setEnv({ OPENROUTER_MODEL: 'google/gemini-3.8-flash' });
  const backend = createBackend();

  const res = await run(backend, { url: '/api/cron?dry=1' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = backend.calls.openrouter[0].body;
  assert.ok(body.max_tokens >= 4000, `max_tokens=${body.max_tokens}`);
  assert.equal(body.response_format.type, 'json_object');
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
});

test('retries with a larger budget when the reply is cut off', async () => {
  setEnv({ OPENROUTER_MODEL: 'google/gemini-3.8-flash' });
  let calls = 0;
  const backend = createBackend({
    openrouter: () => {
      calls += 1;
      return json(calls === 1 ? TRUNCATED : COMPLETE);
    },
  });

  const res = await run(backend, { url: '/api/cron?dry=1' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.text, /Recovered post/);
  assert.equal(backend.calls.openrouter.length, 2);
  assert.ok(
    backend.calls.openrouter[1].body.max_tokens > backend.calls.openrouter[0].body.max_tokens,
  );
  assert.equal(backend.calls.openrouter[1].body.messages.length, 4);
  assert.equal(res.body.postId, undefined);
});

test('explains truncation when the JSON never completes', async () => {
  setEnv({ OPENROUTER_MODEL: 'google/gemini-3.8-flash' });
  const backend = createBackend({ openrouter: () => json(TRUNCATED) });

  const res = await run(backend, { url: '/api/cron?dry=1' });

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /finish_reason=length/);
  assert.match(res.body.error, /reasoning_tokens=780/);
  assert.match(res.body.error, /OPENROUTER_MAX_TOKENS/);
  assert.equal(backend.calls.image.length, 0);
});

test('publishes an image post using a refreshed token', async () => {
  setEnv();
  const backend = createBackend({
    token: () =>
      json({
        access_token: 'fresh-access-token-2',
        expires_in: 5_184_000,
        refresh_token: 'rotated-refresh-token',
      }),
  });

  const res = await run(backend);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.postId, 'urn:li:share:777');
  assert.equal(res.body.tokenSource, 'LINKEDIN_REFRESH_TOKEN');
  assert.equal(res.body.refreshTokenRotated, true);
  assert.equal(res.body.warnings.length, 1);

  assert.equal(backend.calls.token.length, 1);
  const tokenBody = new URLSearchParams(backend.calls.token[0].body);
  assert.equal(tokenBody.get('grant_type'), 'refresh_token');
  assert.equal(tokenBody.get('refresh_token'), 'test-refresh-token');
  assert.equal(tokenBody.get('client_id'), 'test-client-id');
  assert.equal(tokenBody.get('client_secret'), 'test-client-secret');

  assert.equal(backend.calls.userinfo.length, 0);
  assert.equal(backend.calls.register.length, 1);
  assert.equal(
    backend.calls.register[0].body.initializeUploadRequest.owner,
    'urn:li:person:abc123',
  );
  assert.equal(
    backend.calls.register[0].headers.Authorization,
    'Bearer fresh-access-token-2',
  );
  assert.equal(backend.calls.register[0].headers['LinkedIn-Version'], '202510');
  assert.equal(backend.calls.register[0].headers['X-Restli-Protocol-Version'], '2.0.0');

  assert.equal(backend.calls.upload.length, 1);
  assert.equal(backend.calls.upload[0].method, 'PUT');
  assert.equal(backend.calls.upload[0].headers.Authorization, 'Bearer fresh-access-token-2');
  assert.equal(backend.calls.upload[0].headers['Content-Type'], 'image/png');
  assert.equal(backend.calls.upload[0].body.length, PNG.length);

  assert.equal(backend.calls.post.length, 1);
  const post = backend.calls.post[0].body;
  assert.equal(post.author, 'urn:li:person:abc123');
  assert.equal(post.lifecycleState, 'PUBLISHED');
  assert.equal(post.visibility, 'PUBLIC');
  assert.equal(post.distribution.feedDistribution, 'MAIN_FEED');
  assert.equal(post.isReshareDisabledByAuthor, false);
  assert.match(post.commentary, /Small tools beat big plans/);
  assert.ok(post.commentary.includes('\\(and big budgets\\)'), post.commentary);
  assert.equal(post.content.media.id, 'urn:li:image:42');
  assert.equal(post.content.media.altText, 'A tiny workshop bench with one glowing tool');
  assert.equal(backend.calls.post[0].headers['LinkedIn-Version'], '202510');
});

test('falls back to a static access token and looks up the person urn', async () => {
  setEnv({
    LINKEDIN_REFRESH_TOKEN: null,
    LINKEDIN_ACCESS_TOKEN: 'static-token',
    LINKEDIN_PERSON_URN: null,
  });
  const backend = createBackend();

  const res = await run(backend);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.tokenSource, 'LINKEDIN_ACCESS_TOKEN');
  assert.equal(res.body.authorUrn, 'urn:li:person:abc123');
  assert.equal(backend.calls.token.length, 0);
  assert.equal(backend.calls.userinfo.length, 1);
  assert.equal(backend.calls.userinfo[0].headers.Authorization, 'Bearer static-token');
  assert.equal(backend.calls.post[0].body.author, 'urn:li:person:abc123');
});

test('publishes text only when POST_WITH_IMAGE is false', async () => {
  setEnv({ POST_WITH_IMAGE: 'false' });
  const backend = createBackend();

  const res = await run(backend);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(backend.calls.register.length, 0);
  assert.equal(backend.calls.upload.length, 0);
  assert.equal(backend.calls.post.length, 1);
  assert.equal(backend.calls.post[0].body.content, undefined);
  assert.match(backend.calls.post[0].body.commentary, /Small tools beat big plans/);
});

test('pins the LinkedIn API version from the environment', async () => {
  setEnv({ LINKEDIN_API_VERSION: '202406' });
  const backend = createBackend();

  const res = await run(backend);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.apiVersion, '202406');
  assert.equal(backend.calls.register[0].headers['LinkedIn-Version'], '202406');
  assert.equal(backend.calls.post[0].headers['LinkedIn-Version'], '202406');
});

test('accepts a base64 JSON image response', async () => {
  setEnv();
  const backend = createBackend({
    image: () => json({ b64_json: PNG.toString('base64') }),
  });

  const res = await run(backend);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(backend.calls.upload[0].headers['Content-Type'], 'image/png');
  assert.equal(backend.calls.upload[0].body.length, PNG.length);
});

test('reports text model failures and publishes nothing', async () => {
  setEnv();
  const backend = createBackend({
    openrouter: () => json({ error: { message: 'rate limited' } }, 429),
  });

  const res = await run(backend);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /429/);
  assert.equal(backend.calls.image.length, 0);
  assert.equal(backend.calls.post.length, 0);
});

test('reports image endpoint failures and publishes nothing', async () => {
  setEnv();
  const backend = createBackend({
    image: () => json({ error: 'worker down' }, 500),
  });

  const res = await run(backend);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /worker down/);
  assert.equal(backend.calls.post.length, 0);
});

test('reports LinkedIn publish failures', async () => {
  setEnv();
  const backend = createBackend({
    post: () => json({ message: 'Not enough permissions to access ugcPosts' }, 403),
  });

  const res = await run(backend);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /403/);
  assert.match(res.body.error, /Not enough permissions/);
});

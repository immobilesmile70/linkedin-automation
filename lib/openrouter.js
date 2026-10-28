const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

// Reasoning models (gemini-3.8-flash, o-series, ...) bill their thinking tokens
// against max_tokens, so a small budget truncates the reply mid-JSON.
export const DEFAULT_MAX_TOKENS = 4000;
export const DEFAULT_REASONING_EFFORT = 'low';

const MAX_TOKENS_CEILING = 16000;
const MIN_MAX_TOKENS = 900;
const ATTEMPTS = 2;
const EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];

const RETRY_NUDGE = [
  'That reply was not one complete JSON object: it was cut off or malformed.',
  'Send the whole post and image prompt again as a single JSON object with exactly the keys',
  '"text" and "image_prompt". No prose, no commentary, no markdown fences.',
  'Keep the post under 1100 characters so it fits comfortably.',
].join(' ');

export class OpenRouterError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'OpenRouterError';
    this.statusCode = status;
  }
}

function buildMessages({ topic, tone, audience }) {
  const system = [
    'You write LinkedIn posts for a practitioner building automation and AI workflows.',
    'Rules:',
    '- First person, specific and concrete. No corporate filler, no "In today\'s fast-paced world".',
    '- 600 to 1100 characters. Short paragraphs, at most 3 hashtags at the end.',
    '- No markdown headings, no bold markers, no bullet characters other than simple "- ".',
    '- 0 or 1 emoji, only if it fits the tone.',
    'You also describe a matching illustration for the post.',
    'Reply with a single JSON object and nothing else, shaped exactly like:',
    '{"text": "<the post, ready to publish>", "image_prompt": "<a 1-2 sentence, concrete visual description for a text-to-image model, no text or logos in the image>"}',
  ].join('\n');

  const user = [
    `Topic: ${topic}`,
    `Tone: ${tone}`,
    `Audience: ${audience}`,
    'Write the post and the illustration prompt now.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('the reply was empty');

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(unfenced.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }

  throw new Error('the reply was not a complete JSON object');
}

export function clampPost(text, limit = 2950) {
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim();
}

export function resolveMaxTokens(value) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.max(Math.round(parsed), MIN_MAX_TOKENS), MAX_TOKENS_CEILING);
}

export function resolveReasoningEffort(value) {
  const effort = String(value ?? '').trim().toLowerCase();
  if (effort === 'none' || effort === 'off') return '';
  if (EFFORTS.includes(effort)) return effort;
  return DEFAULT_REASONING_EFFORT;
}

async function callModel({ apiKey, model, siteUrl, messages, maxTokens, reasoningEffort }) {
  const body = {
    model,
    messages,
    temperature: 0.9,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };

  const effort = resolveReasoningEffort(reasoningEffort);
  // Ignored by models without reasoning support, so this is safe for plain models.
  if (effort) body.reasoning = { effort, exclude: true };

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': siteUrl,
      'X-Title': 'LinkedIn Auto Poster',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new OpenRouterError(`OpenRouter request failed (${res.status}) for ${model}: ${detail}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const usage = data?.usage || null;

  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason || '',
    model: data?.model || model,
    usage,
    reasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens || 0),
    maxTokens,
  };
}

function describeFailure({ completion, error, attempt }) {
  const detail = [
    `model=${completion.model}`,
    `finish_reason=${completion.finishReason || 'unknown'}`,
    `max_tokens=${completion.maxTokens}`,
    `reasoning_tokens=${completion.reasoningTokens}`,
    `attempts=${attempt}`,
  ];

  let hint = 'The model answered, but not with a JSON object.';
  if (completion.finishReason === 'length') {
    hint = completion.content.trim()
      ? 'The reply was cut off by the token budget. Raise OPENROUTER_MAX_TOKENS or lower OPENROUTER_REASONING_EFFORT.'
      : 'The reasoning phase used the whole token budget, so no post was ever written. Raise OPENROUTER_MAX_TOKENS or lower OPENROUTER_REASONING_EFFORT.';
  }

  const snippet = String(completion.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return [
    `OpenRouter did not return usable JSON (${detail.join(', ')}): ${error?.message || 'unknown error'}.`,
    hint,
    `Reply started with: ${snippet || '<empty>'}`,
  ].join(' ');
}

export async function generatePost({
  topic,
  tone,
  audience,
  model,
  apiKey,
  siteUrl = 'https://linkedin-auto-poster.vercel.app',
  maxTokens = DEFAULT_MAX_TOKENS,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
}) {
  if (!apiKey) throw new OpenRouterError('Missing OPENROUTER_API_KEY.', 500);
  if (!model) throw new OpenRouterError('Missing OPENROUTER_MODEL.', 500);

  const baseMessages = buildMessages({ topic, tone, audience });
  let messages = baseMessages;
  let budget = resolveMaxTokens(maxTokens);
  let lastError = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const completion = await callModel({
      apiKey,
      model,
      siteUrl,
      messages,
      maxTokens: budget,
      reasoningEffort,
    });

    try {
      const parsed = parseJsonObject(completion.content);
      const text = clampPost(parsed.text || parsed.post || parsed.content);
      const imagePrompt = String(parsed.image_prompt || parsed.imagePrompt || '').trim();

      if (!text) throw new Error('the reply contained no post text');
      if (!imagePrompt) throw new Error('the reply contained no image prompt');

      return {
        text,
        imagePrompt: imagePrompt.slice(0, 1000),
        model: completion.model,
        usage: completion.usage,
        finishReason: completion.finishReason,
        attempts: attempt,
      };
    } catch (err) {
      lastError = new OpenRouterError(describeFailure({ completion, error: err, attempt }));

      if (attempt === ATTEMPTS) break;

      // Show the model its own broken reply and give it a bigger budget.
      messages = [
        ...baseMessages,
        { role: 'assistant', content: String(completion.content || '').slice(0, 4000) },
        { role: 'user', content: RETRY_NUDGE },
      ];
      budget = Math.min(budget * 2, MAX_TOKENS_CEILING);
    }
  }

  throw lastError;
}

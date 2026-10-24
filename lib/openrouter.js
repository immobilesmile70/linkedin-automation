const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

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
  if (!text) throw new OpenRouterError('OpenRouter returned an empty completion.');

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

  throw new OpenRouterError(`OpenRouter did not return usable JSON: ${unfenced.slice(0, 300)}`);
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

export async function generatePost({ topic, tone, audience, model, apiKey, siteUrl = 'https://linkedin-auto-poster.vercel.app' }) {
  if (!apiKey) throw new OpenRouterError('Missing OPENROUTER_API_KEY.', 500);
  if (!model) throw new OpenRouterError('Missing OPENROUTER_MODEL.', 500);

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': siteUrl,
      'X-Title': 'LinkedIn Auto Poster',
    },
    body: JSON.stringify({
      model,
      messages: buildMessages({ topic, tone, audience }),
      temperature: 0.9,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new OpenRouterError(`OpenRouter request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(raw);

  const text = clampPost(parsed.text || parsed.post || parsed.content);
  const imagePrompt = String(parsed.image_prompt || parsed.imagePrompt || '').trim();

  if (!text) throw new OpenRouterError('OpenRouter response contained no post text.');
  if (!imagePrompt) throw new OpenRouterError('OpenRouter response contained no image prompt.');

  return {
    text,
    imagePrompt: imagePrompt.slice(0, 1000),
    model: data?.model || model,
    usage: data?.usage || null,
  };
}

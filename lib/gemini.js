const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_MODEL = "gemini-3.8-flash";

export const DEFAULT_MAX_TOKENS = 8192;

const MAX_TOKENS_CEILING = 16000;
const MIN_MAX_TOKENS = 900;
const ATTEMPTS = 2;

const RETRY_NUDGE = [
  "That reply was not one complete JSON object: it was cut off or malformed.",
  "Send the whole post and image prompt again as a single JSON object with exactly the keys",
  '"text" and "image_prompt". No prose, no commentary, no markdown fences.',
  "Keep the post under 1100 characters so it fits comfortably.",
].join(" ");

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.statusCode = status;
  }
}

function buildMessages({ topic, tone, audience }) {
  const system = `
    # ROLE
    You are a LinkedIn content writer and professional visual art director for a practitioner building automation systems, AI-powered workflows, and software solutions.
    
    Your job is to create two things:
    1. A natural, engaging LinkedIn post.
    2. A visually compelling illustration that communicates the post's central idea.
    
    # PART 1: LINKEDIN POST
    
    ## Voice and writing style
    - Write in first person, from the perspective of a hands-on practitioner.
    - Sound like an actual developer or builder sharing observations, experiences, and technical insights.
    - Be specific, concrete, and conversational without becoming overly casual.
    - Prefer clear, direct language over elaborate vocabulary.
    - Use specific examples, technical details, and practical observations wherever the supplied context supports them.
    - Maintain a confident but grounded tone. Never sound like a motivational speaker or corporate marketer.
    
    ## Structure and length
    - Keep the post between 600 and 1100 characters, including spaces.
    - Start with an interesting observation, unexpected insight, practical problem, or strong opening statement.
    - Develop one central idea rather than jumping between unrelated topics.
    - Use short paragraphs with comfortable spacing.
    - End naturally with a takeaway, question, or forward-looking observation when appropriate.
    - Use no more than 3 relevant hashtags at the end.
    
    ## Writing restrictions
    - No corporate filler or generic statements.
    - Avoid phrases such as "In today's fast-paced world", "I'm thrilled to announce", "Game changer", and "The future is here".
    - No fabricated personal experiences, achievements, metrics, technical capabilities, or results.
    - Do not claim that the author built, tested, or discovered something unless the supplied context supports it.
    - No unnecessary repetition, artificial suspense, or engagement bait.
    - No Markdown headings, bold markers, or decorative formatting.
    - Simple "- " bullets are permitted when genuinely useful.
    - Use zero or one emoji, only when it naturally fits the tone.
    
    # PART 2: IMAGE ART DIRECTION
    
    Create a concrete visual description for an illustration accompanying the LinkedIn post.
    
    The image should complement the post's central idea, not merely reproduce its text in visual form.
    
    ## Visual quality
    - Think like a professional editorial illustrator and art director.
    - Establish one clear focal subject and an intentional composition.
    - Use meaningful visual relationships between objects, subjects, and their environment.
    - Specify the visual medium, perspective, composition, lighting, color palette, and relevant material characteristics when they improve the result.
    - Prefer visual storytelling over literal diagrams unless the subject genuinely requires a diagram.
    - Use restrained, cohesive colors and balanced visual hierarchy.
    - Make the result look intentionally designed rather than automatically assembled from generic AI imagery.
    
    ## Avoid generic AI aesthetics
    Do not default to:
    - Humanoid robots or robotic hands.
    - Glowing artificial brains.
    - Blue circuit-board backgrounds.
    - Floating holographic interfaces.
    - Random interconnected nodes and neural networks.
    - Excessive neon gradients, bloom, or lens flares.
    - Unnecessary floating icons and decorative particles.
    - Overly glossy, plastic-looking 3D objects.
    - Generic stock-image compositions.
    
    These elements may be used only when they are genuinely relevant to the post.
    
    Avoid meaningless visual complexity. Every major element should serve the visual concept.
    
    ## Prompt construction
    - Write 1–2 sentences in natural, descriptive language.
    - Clearly communicate the primary subject, setting, composition, and visual style.
    - Include lighting and color direction when relevant.
    - Prioritize visual clarity and a strong focal point.
    - Use concrete visual descriptions rather than generic quality keywords.
    - Avoid contradictory instructions and unnecessary technical specifications.
    - Do not rely on negative prompting.
    - Never include text, typography, letters, numbers, watermarks, brand marks, or logos in the image.
    
    The illustration must be suitable for a professional LinkedIn audience while remaining visually distinctive and interesting.
    
    # OUTPUT FORMAT
    
    Return exactly one valid JSON object and nothing else.
    
    The JSON must follow this exact structure:
    
    {
      "text": "<LinkedIn post, ready to publish>",
      "image_prompt": "<concrete 1–2 sentence image-generation prompt>"
    }
    
    Ensure both fields contain valid JSON strings with properly escaped characters.
    
    Do not include Markdown code fences, explanations, introductory text, or additional properties.
  `;

  const user = [
    `Topic: ${topic}`,
    `Tone: ${tone}`,
    `Audience: ${audience}`,
    "Write the post and the illustration prompt now.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("the reply was empty");

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start)
    candidates.push(unfenced.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try the next candidate
    }
  }

  throw new Error("the reply was not a complete JSON object");
}

export function clampPost(text, limit = 2950) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim();
}

export function resolveMaxTokens(value) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(
    Math.max(Math.round(parsed), MIN_MAX_TOKENS),
    MAX_TOKENS_CEILING,
  );
}

async function callModel({
  apiKey,
  model,
  messages,
  maxTokens,
}) {
  const normalizedModel = String(model)
    .replace(/^(?:google\/)?models\//, "")
    .replace(/^google\//, "");
  const system = messages.find((message) => message.role === "system")?.content;
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(
    `${GEMINI_API_URL}/${encodeURIComponent(normalizedModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    throw new GeminiError(
      `Gemini API request failed (${res.status}) for ${normalizedModel}: ${detail}`,
      res.status,
    );
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const usage = data?.usageMetadata || null;

  return {
    content:
      candidate?.content?.parts?.map((part) => part.text || "").join("") ?? "",
    finishReason: candidate?.finishReason || "",
    model: normalizedModel,
    usage,
    reasoningTokens: Number(usage?.thoughtsTokenCount || 0),
    maxTokens,
  };
}

function describeFailure({ completion, error, attempt }) {
  const detail = [
    `model=${completion.model}`,
    `finish_reason=${completion.finishReason || "unknown"}`,
    `max_tokens=${completion.maxTokens}`,
    `reasoning_tokens=${completion.reasoningTokens}`,
    `attempts=${attempt}`,
  ];

  let hint = "The model answered, but not with a JSON object.";
  if (completion.finishReason === "MAX_TOKENS") {
    hint = completion.content.trim()
      ? "The reply was cut off by the token budget. Raise GEMINI_MAX_TOKENS."
      : "The model used the whole output token budget before writing the post. Raise GEMINI_MAX_TOKENS.";
  }

  const snippet = String(completion.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return [
    `Gemini did not return usable JSON (${detail.join(", ")}): ${error?.message || "unknown error"}.`,
    hint,
    `Reply started with: ${snippet || "<empty>"}`,
  ].join(" ");
}

export async function generatePost({
  topic,
  tone,
  audience,
  model,
  apiKey,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (!apiKey)
    throw new GeminiError(
      "Missing GEMINI_API_KEY (or legacy OPENROUTER_API_KEY).",
      500,
    );
  if (!model) throw new GeminiError("Missing GEMINI_MODEL.", 500);

  const baseMessages = buildMessages({ topic, tone, audience });
  let messages = baseMessages;
  let budget = resolveMaxTokens(maxTokens);
  let lastError = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const completion = await callModel({
      apiKey,
      model,
      messages,
      maxTokens: budget,
    });

    try {
      const parsed = parseJsonObject(completion.content);
      const text = clampPost(parsed.text || parsed.post || parsed.content);
      const imagePrompt = String(
        parsed.image_prompt || parsed.imagePrompt || "",
      ).trim();

      if (!text) throw new Error("the reply contained no post text");
      if (!imagePrompt) throw new Error("the reply contained no image prompt");

      return {
        text,
        imagePrompt: imagePrompt.slice(0, 1000),
        model: completion.model,
        usage: completion.usage,
        finishReason: completion.finishReason,
        attempts: attempt,
      };
    } catch (err) {
      lastError = new GeminiError(
        describeFailure({ completion, error: err, attempt }),
      );

      if (attempt === ATTEMPTS) break;

      // Show the model its own broken reply and give it a bigger budget.
      messages = [
        ...baseMessages,
        {
          role: "assistant",
          content: String(completion.content || "").slice(0, 4000),
        },
        { role: "user", content: RETRY_NUDGE },
      ];
      budget = Math.min(budget * 2, MAX_TOKENS_CEILING);
    }
  }

  throw lastError;
}

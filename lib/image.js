export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
    this.statusCode = 502;
  }
}

function sniffContentType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  return null;
}

function stripDataUrl(value) {
  return value.replace(/^data:[^;]+;base64,/, '');
}

function pickBase64(data) {
  const candidates = [
    data?.image,
    data?.b64_json,
    data?.base64,
    data?.image_base64,
    data?.data?.[0]?.b64_json,
    data?.data?.[0]?.image,
    typeof data?.data === 'string' ? data.data : null,
  ];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) || null;
}

function pickUrl(data) {
  const candidates = [data?.url, data?.image_url, data?.data?.[0]?.url];
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || null;
}

/**
 * Calls the Cloudflare Worker image endpoint from automation.py:
 *   POST <url>  Authorization: Bearer <key>  { "prompt": "..." }
 * Handles a raw image body, a base64 JSON payload, or a JSON payload with an image URL.
 */
export async function generateImage({ prompt, url, apiKey, timeoutMs = 90000 }) {
  if (!url) throw new ImageError('Missing IMAGE_API_URL.');
  if (!apiKey) throw new ImageError('Missing IMAGE_API_KEY.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'image/*, application/json',
      },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });

    const contentTypeHeader = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400);
      throw new ImageError(`Image API failed (${res.status}): ${detail}`);
    }

    if (!contentTypeHeader.includes('json')) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new ImageError('Image API returned an empty body.');
      return {
        bytes,
        contentType: sniffContentType(bytes) || contentTypeHeader.split(';')[0] || 'image/png',
      };
    }

    const data = await res.json();
    const base64 = pickBase64(data);

    if (base64) {
      const bytes = Buffer.from(stripDataUrl(base64), 'base64');
      if (!bytes.length) throw new ImageError('Image API returned empty base64 image data.');
      return { bytes, contentType: sniffContentType(bytes) || 'image/png' };
    }

    const imageUrl = pickUrl(data);
    if (imageUrl) {
      const imageRes = await fetch(imageUrl, { signal: controller.signal });
      if (!imageRes.ok) throw new ImageError(`Could not download generated image (${imageRes.status}).`);
      const bytes = Buffer.from(await imageRes.arrayBuffer());
      if (!bytes.length) throw new ImageError('Generated image download was empty.');
      return { bytes, contentType: sniffContentType(bytes) || 'image/png' };
    }

    throw new ImageError(`Image API returned JSON without image data: ${JSON.stringify(data).slice(0, 300)}`);
  } catch (err) {
    if (err instanceof ImageError) throw err;
    if (err?.name === 'AbortError') throw new ImageError(`Image API timed out after ${timeoutMs}ms.`);
    throw new ImageError(`Image API request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

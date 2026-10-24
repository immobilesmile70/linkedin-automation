import { runCron } from '../lib/pipeline.js';
import { ConfigError } from '../lib/env.js';
import { noStore } from '../lib/http.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  noStore(res);

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use GET.' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers?.authorization || '';

  if (!secret) {
    res.status(500).json({ ok: false, error: 'CRON_SECRET is not configured.' });
    return;
  }
  if (authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }

  const url = new URL(req.url || '/api/cron', 'http://localhost');
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const result = await runCron({ env: process.env, dryRun });
    console.log(
      `[cron] ${dryRun ? 'dry run' : 'published'} topic="${result.text.slice(0, 60)}..." postId=${result.postId || 'n/a'}`,
    );
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] failed:', err?.name, err?.message);
    const statusCode = err instanceof ConfigError ? 500 : err?.statusCode || 500;
    res.status(statusCode).json({
      ok: false,
      error: err?.message || 'Cron run failed.',
      name: err?.name || 'Error',
    });
  }
}

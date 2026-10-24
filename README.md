# LinkedIn Auto Poster

A Vercel cron job that writes a LinkedIn post with an OpenRouter text model, renders a matching
illustration with your image worker (the Cloudflare endpoint from `automation.py`), and publishes both
to your LinkedIn profile.

```
Vercel Cron (09:00 UTC daily)
  └─ GET /api/cron            bearer CRON_SECRET
       ├─ OpenRouter          → post text + image prompt (JSON)
       ├─ Image worker        → PNG bytes
       ├─ LinkedIn refresh    → fresh access token
       ├─ LinkedIn Images     → initializeUpload + PUT image
       └─ LinkedIn Posts      → publish text + image
```

## 1. LinkedIn app

1. Create an app at <https://www.linkedin.com/developers/apps>.
2. **Products**: request **Share on LinkedIn** (gives `w_member_social`) and **Sign In with LinkedIn
   using OpenID Connect** (`openid profile`).
3. **Auth** tab → add the redirect URL of your deployment, exactly:
   `https://<your-app>.vercel.app/api/auth/callback`
   (add `http://localhost:3000/api/auth/callback` too if you use `vercel dev`).
4. Copy the client id and client secret.
5. Refresh tokens are only issued if the app has **Programmatic Refresh Tokens** enabled. Without it,
   re-run the connect flow every ~60 days to renew `LINKEDIN_ACCESS_TOKEN`.

## 2. Deploy

```bash
npm i -g vercel        # if needed
vercel                 # link the project
vercel --prod          # deploy
```

No dependencies and no build step — Vercel runs the files in `api/` as functions and serves `public/`.

Then add the environment variables below in **Vercel → Project → Settings → Environment Variables**
(Production and Preview), and redeploy so the functions pick them up.

## 3. Connect LinkedIn

Open `https://<your-app>.vercel.app/` → **Connect LinkedIn**, approve, and copy the values it prints
into Vercel. The page is `no-store` and shows the token only once per sign-in.

## 4. Test, then let it run

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-app>.vercel.app/api/cron?dry=1"
```

`dry=1` generates the text and image and returns them as JSON without touching LinkedIn. Drop the
parameter (or wait for the schedule) to publish.

The schedule is in `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron", "schedule": "0 9 * * *" }] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` itself when `CRON_SECRET` exists. On the Hobby plan a
cron job can run only once per day, at some point inside the scheduled hour.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | yes | Bearer secret that guards `/api/cron` (use `openssl rand -hex 32`). |
| `OPENROUTER_API_KEY` | yes | OpenRouter key. |
| `OPENROUTER_MODEL` | recommended | Model slug, e.g. `google/gemini-2.5-flash`. |
| `IMAGE_API_URL` | yes | Your image worker URL (the `worker_url` from `automation.py`). |
| `IMAGE_API_KEY` | yes | Bearer key sent to the image worker. |
| `LINKEDIN_CLIENT_ID` | yes | From the LinkedIn app. |
| `LINKEDIN_CLIENT_SECRET` | yes | From the LinkedIn app (used for token exchange and refresh). |
| `LINKEDIN_REFRESH_TOKEN` | yes* | Printed by the connect flow; exchanged for an access token each run. |
| `LINKEDIN_ACCESS_TOKEN` | yes* | Fallback when LinkedIn issues no refresh token. |
| `LINKEDIN_PERSON_URN` | optional | `urn:li:person:…`; skips one API call per run. |
| `LINKEDIN_API_VERSION` | optional | Versioned API release, `YYYYMM`, default `202510`. |
| `POST_TOPIC` | optional | What the post should be about. Has a sensible default. |
| `POST_TONE` | optional | Writing tone. |
| `POST_AUDIENCE` | optional | Who reads it. |
| `POST_WITH_IMAGE` | optional | `false` publishes text only (the image is still generated). |
| `PUBLIC_BASE_URL` | optional | e.g. `https://<your-app>.vercel.app`; used for the OAuth redirect. |
| `LINKEDIN_REDIRECT_URI` | optional | Overrides the exact callback URL. |

\* One of `LINKEDIN_REFRESH_TOKEN` or `LINKEDIN_ACCESS_TOKEN` is required.

## Endpoints

| Route | Method | Description |
| --- | --- | --- |
| `/` | GET | Dashboard with the connect button and env reference. |
| `/api/auth/login` | GET | Starts LinkedIn OAuth (`state` in an HttpOnly cookie). |
| `/api/auth/callback` | GET | Exchanges the code and renders the env values to copy. |
| `/api/cron` | GET | Cron entry point. `?dry=1` skips publishing. |

## Notes and limits

- **Token storage**: tokens live in Vercel env vars, not a database. If LinkedIn rotates the refresh
  token, the cron response includes a warning; re-run the connect flow and update
  `LINKEDIN_REFRESH_TOKEN`.
- **Duration**: `api/cron.js` allows 60s (`vercel.json`). If your image worker is slow, raise
  `functions["api/cron.js"].maxDuration` (Pro plans allow more).
- **Text length**: posts are trimmed to ~2,950 characters, under LinkedIn's 3,000 limit.
- **Little-text escaping**: LinkedIn truncates commentary at unescaped reserved characters (`(` `)` `[`
  `]` `{` `}` `<` `>` `@` `|` `~` `_` `*`), so `lib/linkedin.js` backslash-escapes them before
  posting. The backslashes are consumed by LinkedIn and do not appear in the published post.
- **API version**: the job uses the versioned `/rest/posts` and `/rest/images` APIs. LinkedIn supports
  each `LinkedIn-Version` for about a year; if a run fails with a 426, set `LINKEDIN_API_VERSION` to a
  currently supported release and redeploy.
- **Failures**: config, OpenRouter, image and LinkedIn errors return JSON with `ok: false` and a
  message; check Vercel → Logs for `[cron] failed`.
- **Image formats**: the worker may return raw bytes, `{ b64_json | image | base64 }`, or `{ url }`.

## Local development

```bash
cp .env.example .env    # fill in the values
npm run dev             # vercel dev
npm test                # node --test, network fully mocked
```

`npm test` covers auth on the cron route, the dry run, publishing with a refreshed token, the static
token fallback, text-only posts, base64 image responses, and the failure paths.

## Files

```
api/cron.js              cron entry point
api/auth/login.js        OAuth start
api/auth/callback.js     code exchange + env values
lib/pipeline.js          orchestration
lib/openrouter.js        text model
lib/image.js             image worker client
lib/linkedin.js          OAuth, upload, publish
lib/env.js lib/http.js   config and request helpers
public/                  dashboard
test/cron.test.js        tests
```

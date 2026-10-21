---
name: deploy-worker
description: Deploy this team's Lunch Uncle Cloudflare Worker after fixes have been merged, without exposing course API keys or overwriting another team's Worker.
---

# Deploy Lunch Uncle

Deploy only when the user asks to deploy.

1. Run `git status --short` and stop if there are uncommitted changes that the user has not explained.
2. Check that `.env` is ignored with `git check-ignore .env`. Stop if it is not ignored.
3. Read the Worker name in `wrangler.toml`. If it is still `lunch-uncle`, ask the team to choose a unique name and update it before deploying.
4. Confirm that `.env.example` lists `LLM_BASE_URL` and `LLM_MODEL`. `src/loop.js` reads both from `env`.
5. Run `npm test`.
6. Ask the user to set each production secret interactively. Never print, read, or copy values from `.env`:

   ```sh
   npx wrangler secret put OPENCODE_API_KEY
   npx wrangler secret put GOOGLE_PLACES_API_KEY
   npx wrangler secret put LLM_BASE_URL
   npx wrangler secret put LLM_MODEL
   ```

7. Run `npm run deploy`.
8. Open the deployed URL, ask Uncle where to eat today, and report the observed reply. If the reply is wrong, do not claim the deployment is verified.

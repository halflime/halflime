# Deployment

## Hosted instance

Open the [Deploy to Cloudflare button](../README.md#deploy-to-cloudflare) and choose where to copy the repository. Cloudflare reads `wrangler.jsonc` to create the Worker and its D1 database in your account. You can choose a database name in the form; leave the binding named `DB` so the Worker and migrations can find it.

Run `openssl rand -hex 32` twice. Save the first value as `ADMIN_TOKEN` for your MCP client or admin API calls. Use the second as `HASH_SECRET` and keep it on the Worker. Save both in a password manager. Your apps need only their project keys.

Keep `pnpm run deploy` as the Workers Builds deploy command. On each deployment it applies pending migrations to `DB` before publishing the Worker. Keep the assigned database ID in your copy of `wrangler.jsonc` so future deployments use the same database.

At the `workers.dev` URL Cloudflare gives you, connect to [`/mcp`](../README.md#mcp) and call `list_projects`. On a new instance, look for `{ "projects": [], "hasMore": false }`. That checks the admin token and the database tables; `/health` only tells you the Worker is running.

Opening the instance root in a browser redirects to `https://halflime.dev/`. To send visitors to your own homepage, add `"vars": { "HOMEPAGE_URL": "https://example.org/about/" }` to the top level of your core `wrangler.jsonc` and redeploy. Use an absolute HTTPS URL without embedded credentials. If the setting is missing or invalid, the Worker uses the HalfLime homepage.

## Local instance

In the core repository, use Node 24 and pnpm 12.9.1. Copy `.dev.vars.example` to `.dev.vars` and fill in two separate random values for local use. Leave production secrets out of this file.

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler d1 migrations apply DB --local
pnpm dev
```

Use the address printed by `pnpm dev` (normally `http://localhost:8787`). The local database lives under `.wrangler/`; local migrations do not change your hosted data. To check the core before deploying, run `pnpm check`, `pnpm test` and `pnpm build`. The build packages the Worker without uploading it.

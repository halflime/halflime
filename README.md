# HalfLime

HalfLime counts events from your apps and websites in your own Cloudflare account. Send an event when someone finishes an export, for example, and you can ask how many exports happened this week and which formats people used. Query the counts from an MCP client or over HTTP.

One Worker and one D1 database can serve several projects. Each project has its own ingestion key and reports. If one app needs a database to itself, run a second instance with a separate database and secrets.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/halflime/halflime)

The button installs HalfLime in your Cloudflare account and requires a public source repository. With a private checkout, you can [run HalfLime locally](docs/deployment.md#local-instance). For hosted setup and updates, see [Worker secrets and database migrations](docs/deployment.md#hosted-instance). Cloudflare usage charges depend on your account.

## MCP

Connect a Streamable HTTP MCP client to `/mcp` on your Worker. Use `Authorization: Bearer <ADMIN_TOKEN>`. The token can read and manage every project in the instance. Configure it in the client, not in a chat prompt or your app. The endpoint uses stateless POST requests rather than OAuth or an SSE stream.

For a first project, call `create_project` with:

```json
{ "name": "Desktop editor", "type": "app", "properties": ["format"] }
```

Save the returned `id` for queries and `appKey` for the app. The key can send events only. HalfLime stores its hash and won't show the key again. For a website, use `type: "website"` and include its origin, for example `"origins": ["https://shop.example"]`.

[Send an `export_finished` event](docs/api.md#send-your-first-event), then call `get_breakdown`. Set `projectId` to the returned `id`, `from` and `to` to the start and end of today in UTC, and `dimension` to `prop:format`. On a fresh project, the `pdf` row should show one event and one session.

Use `get_stats` for totals and `get_timeseries` for hourly or daily counts. `list_projects` and `get_project` show project settings. The reporting tools return counts, not individual event records.

## HTTP API

The [HTTP API reference](docs/api.md) covers project creation, event fields, retries and reports. You can use it directly without an MCP client or SDK.

## Privacy and session counts

The JavaScript and Rust SDKs keep a random session ID in memory. A new client or 30 minutes of inactivity starts a new session. The Worker stores a keyed hash of the ID for each project and UTC day, not the ID itself. If one session sends events on both sides of midnight UTC, a report covering both days counts two sessions. Rotating `HASH_SECRET` also changes future hashes. Treat the count as sessions, not people.

The Worker does not collect client IP addresses, User-Agent strings or request headers as analytics. For a pageview at `/pricing?plan=pro#details`, it stores `/pricing`; for a referrer, it keeps only the hostname. A name in a URL path can still get through. Send route templates such as `/users/:id`, not customer names, account IDs or free text. Allow only the custom properties you need; filters cannot catch every personal detail.

Events stay in D1 until you delete them. The template disables Worker request logs and traces; review your Cloudflare account settings for other logging and backups.

## License

Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)). Licensed under Apache-2.0. See [LICENSE](LICENSE) and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).

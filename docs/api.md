# HTTP API

Use the project's public `appKey` in the `App-Key` header to send events. To create projects or read reports, send the instance's private `ADMIN_TOKEN` as a bearer token in the `Authorization` header. Never put the admin token in a browser or a distributed app.

## Send your first event

Create an `app` project as described in the [README](../README.md#mcp). Export `INSTANCE_URL` (the Worker URL, or `http://localhost:8787` for local development) and `APP_KEY` (the `appKey` returned at creation). Run this in a terminal with Node 24:

```sh
node --input-type=module <<'JS'
const event = {
  eventId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  eventName: 'export_finished',
  props: { format: 'pdf' }
};
const response = await fetch(new URL('/api/v1/events', process.env.INSTANCE_URL), {
  method: 'POST',
  redirect: 'error',
  headers: { 'Content-Type': 'application/json', 'App-Key': process.env.APP_KEY },
  body: JSON.stringify([event])
});
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
console.log(await response.json());
JS
```

The first send returns `{ "accepted": 1 }`. If a request loses its response, retry the original payload. HalfLime ignores an `eventId` it has already stored for that project and returns `{ "accepted": 0 }` for that single-event retry. Running the snippet again creates a new event and session. In an app, reuse the session ID for events in the same session.

## Projects

| Request | Result |
| --- | --- |
| `POST /api/v1/projects` | Creates a project (201). Returns `id`, `name`, `type`, `origins`, `properties`, `createdAt` and a one-time `appKey`. |
| `GET /api/v1/projects` | Returns up to 100 projects, newest first. `hasMore` tells you if there are older projects; the API has no pagination cursor. |
| `GET /api/v1/projects/:id` | Returns one project's settings without its key. |

At creation, give the project a `name` (1 to 100 characters) and a `type` (`app` or `website`). A website needs at least one allowed origin. Use the exact origin, such as `https://shop.example`, without a path or trailing slash. You can register up to 20 origins of at most 200 characters each.

Use `properties` to name the custom event fields you want to keep. The default is an empty list. You can allow up to 20 keys; each starts with a letter and contains at most 40 ASCII letters, digits or underscores. HalfLime rejects sensitive names such as `email` and `userId`.

## Event fields and limits

`POST /api/v1/events` takes a JSON array of 1 to 25 events. The Worker checks the whole batch before writing it to D1. If any event is invalid or the database write fails, it stores none of the batch.

| Field | What to send |
| --- | --- |
| `eventId`, `sessionId` | Random UUIDs. Use `eventId` to identify the event on retries, never to identify a person. |
| `timestamp` | ISO 8601 with a timezone, no more than 366 days old or five minutes in the future. |
| `eventName` | An action such as `export_finished`, 1 to 100 characters. |
| `props` (optional) | Up to 20 flat keys with string (up to 200 characters), finite number or boolean values. Only allowlisted, non-sensitive entries survive filtering. |
| `systemProps` (optional) | `appVersion`, `appBuildNumber`, `osName`, `osVersion`, `locale`, `sdkVersion` and `deviceModel` accept strings up to 100 characters; `isDebug` accepts a boolean. The Worker drops unrecognized or unsafe values. |
| `path`, `referrer` (optional) | Up to 2048 characters each. The Worker keeps at most 512 characters of the URL path and only the referrer's hostname. |

Unknown top-level fields and nested custom properties make the batch invalid. For websites, each request must carry an `Origin` registered on that project. Native apps may omit `Origin`; if they send it, it must match. Browser preflight allows `POST` with `App-Key` and `Content-Type`, without cookies. An origin check does not make a public key private: someone who copies it can submit events outside a browser.

## Reports

Pass `projectId`, `from` and `to` as query parameters. The range includes `from` and excludes `to`. Use ISO timestamps with a timezone and a positive range of at most 31 days.

| Request | What you get |
| --- | --- |
| `GET /api/v1/stats` | Total `events` and distinct `sessions` for the range. |
| `GET /api/v1/breakdown` | Add `dimension`: `eventName`, `appVersion`, `osName`, `path`, `referrer`, or `prop:` followed by an allowed key. Returns `rows` with `value`, `events` and `sessions`, sorted by event count (top 100, ties by value). Missing values form a `null` group. |
| `GET /api/v1/timeseries` | Add `interval=hour` or `interval=day`. Returns `rows` with `bucket` (UTC start time), `events` and `sessions`. Empty buckets are omitted. |

One session can appear in several breakdown rows. Use `get_stats` or `/api/v1/stats` for the total instead of adding those rows. See [how sessions are counted](../README.md#privacy-and-session-counts).

## Errors and health checks

The HTTP API returns errors as JSON with an `error` field. Check the status before retrying:

| Status | What to check |
| --- | --- |
| 400 | The JSON, event fields, project settings or report range are invalid. |
| 401 | The key or token is missing or incorrect. Check which credential the endpoint needs. |
| 403 | Check the request origin. Admin endpoints and MCP reject cross-origin browser requests. |
| 404 | The project or route does not exist. |
| 413 / 415 | POST bodies must be at most 64 KiB and use `Content-Type: application/json`. |
| 500 | The Worker hit an internal error, such as a failed database operation. It does not return internal details. |
| 503 | Check both Worker secrets. Each must be 32 to 1024 characters. |

`GET /health` is public and returns `{ "ok": true }` even if D1 or the secrets are missing. To check the installation, make an authenticated `GET /api/v1/projects` request instead.

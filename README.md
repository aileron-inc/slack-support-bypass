# slack-support-bypass

Thin Cloudflare Worker that forwards Slack Events API payloads to per-route Grok Bot webhooks.

No business logic. No LLM. No Slack posting except the `url_verification` challenge response.

The **public repo is Worker code + this README + `routes.example.json`**. There is no committed `routes.json` and no secrets.

Public GitHub remote: <https://github.com/aileron-inc/slack-support-bypass>

## Architecture

```
Slack Events API
    │  POST {path from operator routes}
    ▼
slack-support-bypass (this Worker)
    │  1. Look up path in env.ROUTES_JSON (injected at dev/deploy)
    │  2. Verify Slack signature with that route's signing secret
    │  3. url_verification → { challenge } immediately
    │  4. Drop bot / message_changed / message_deleted (200 ACK)
    │  5. Optional teamId filter from the same route row
    │  6. 200 ACK, then ctx.waitUntil POST to that route's Grok webhook
    ▼
Grok Bot webhook  (Authorization: Bearer + X-Automation-Key)
```

- Signature replay window is ~5 minutes. Compare is timing-safe.
- Webhook POST times out at 8 seconds. Failures are logged once. No retry.
- `permalink` is always `null`.
- The same mention can arrive as both `app_mention` and `message`. Deduplicate on `message_ts` in the Grok Bot.

## Home-directory config (already on the machine)

Operator files are **not** in this repo. They already live at:

```
~/.slack-support-bypass/routes.json
~/.slack-support-bypass/secrets.env
```

Plaintext is fine. The Worker never reads the home directory at runtime. Dev and deploy copy those files into wrangler:

| File | Becomes |
| --- | --- |
| `~/.slack-support-bypass/routes.json` | `ROUTES_JSON` (`.dev.vars` locally, `wrangler secret put` in prod) |
| `~/.slack-support-bypass/secrets.env` | the `*Env` names listed in that routes file |

Override the home directory with `SLACK_SUPPORT_BYPASS_HOME` if needed.

[`routes.example.json`](./routes.example.json) is a **sample shape only** (fake names `acme` / `contoso`, fake team IDs `T000FAKE1` / `T000FAKE2`). Do not treat it as the operator table.

### Local

```bash
npm run sync-config    # home files → gitignored .dev.vars
npm run dev            # 127.0.0.1:43123
```

### Production

`wrangler.jsonc` does not hardcode `account_id`. Use the aileron-inc Cloudflare account:

```bash
export CLOUDFLARE_ACCOUNT_ID=<aileron-inc Cloudflare account id>
npx wrangler secret put ROUTES_JSON < ~/.slack-support-bypass/routes.json
# then wrangler secret put for every *Env name in that routes.json
npx wrangler deploy
```

Do not deploy until the account id and those secrets are actually available. Bot tokens stay on the Grok Bot side.

## How to add a company

1. Append one object to `~/.slack-support-bypass/routes.json`.
2. Add the three values to `~/.slack-support-bypass/secrets.env`.
3. Point the Slack app Request URL at `https://<worker>` + `path`.
4. `npm run sync-config` locally, or `wrangler secret put` in prod, then deploy.
5. No TypeScript change.

Row shape (sample — not real team IDs):

```json
{
  "name": "acme",
  "path": "/slack/acme",
  "teamId": "T000FAKE1",
  "signingSecretEnv": "SLACK_SIGNING_SECRET_ACME",
  "webhookUrlEnv": "GROK_WEBHOOK_URL_ACME",
  "webhookKeyEnv": "GROK_WEBHOOK_KEY_ACME"
}
```

`teamId` is optional. When set, a mismatched `payload.team_id` is ACKed and not forwarded.

## Slack App setup

One Slack app **From scratch** per home-dir route row. [Your Apps](https://api.slack.com/apps).

1. Create New App → From scratch.
2. Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`.
3. Event Subscriptions: Request URL = `https://slack-support-bypass.<SUBDOMAIN>.workers.dev` + the route `path`. Bot events: `app_mention`, `message.channels`, `message.groups`.
4. Install to Workspace.
5. Put the Signing Secret in `~/.slack-support-bypass/secrets.env` (and `wrangler secret put` in prod).
6. Invite the bot to the target channels.

## Grok webhook

`waitUntil` POST. Failures logged only. No retry.

- `Authorization: Bearer <key>`
- `X-Automation-Key: <key>`
- `Content-Type: application/json`

```json
{
  "action": "slack_event",
  "route": "acme",
  "event_type": "app_mention",
  "channel_id": "C...",
  "thread_ts": "1710000000.000050",
  "message_ts": "1710000000.000100",
  "user_id": "U...",
  "text": "<@Ubot> hello",
  "team_id": "T000FAKE1",
  "permalink": null
}
```

## Develop

```bash
npm install
npm test
npm run typecheck
npm run sync-config
npm run dev
```

`npm test` uses `routes.example.json` via `ROUTES_JSON` (signature, challenge, path lookup, bot/edit/delete drop, teamId filter).

## License

[MIT](./LICENSE)

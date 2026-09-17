# slack-support-bypass

Thin Cloudflare Worker that forwards Slack Events API payloads to per-route Grok Bot webhooks.

No business logic. No LLM. No Slack posting except the `url_verification` challenge response.

The **public git repo is Worker code + docs + examples only**. Route tables (including Slack `teamId`) and secrets are **not** in git.

Public GitHub remote: https://github.com/aileron-inc/slack-support-bypass

## Architecture

```
Slack Events API
    |  POST {path from operator routes}
    v
slack-support-bypass (this Worker)
    |  1. Look up path in env.ROUTES_JSON (injected at dev/deploy)
    |  2. Verify Slack signature with that route's signing secret
    |  3. url_verification -> { challenge } immediately
    |  4. Drop bot / message_changed / message_deleted (200 ACK)
    |  5. Optional teamId filter from the same route row
    |  6. 200 ACK, then ctx.waitUntil POST to that route's Grok webhook
    v
Grok Bot webhook  (Authorization: Bearer + X-Automation-Key)
```

- Signature replay window is ~5 minutes. Compare is timing-safe.
- Webhook POST times out at 8 seconds. Failures are logged once. No retry.
- `permalink` is always `null`.

## Home-directory config (source of truth)

The Worker cannot see your home directory on Cloudflare. Keep real files at home (plaintext is fine) and copy them into wrangler at dev/deploy time.

```
~/.slack-support-bypass/routes.json    # route table (paths, teamIds, env NAMES)
~/.slack-support-bypass/secrets.env    # signing secrets + webhook URL/key VALUES
```

```bash
mkdir -p ~/.slack-support-bypass
cp routes.example.json ~/.slack-support-bypass/routes.json
cp secrets.env.example ~/.slack-support-bypass/secrets.env
```

`routes.example.json` is a sample (`acme` / `contoso`, fake team IDs `T000FAKE1` / `T000FAKE2`). It is not an operator config.

Override the home path with `SLACK_SUPPORT_BYPASS_HOME` if needed.

### Local / wrangler dev

```bash
npm run sync-config    # writes gitignored .dev.vars from the two home files
npm run dev            # wrangler on 127.0.0.1:43123
```

### Production

`account_id` is not hardcoded in `wrangler.jsonc`. Deploy to the aileron-inc Cloudflare account:

```bash
export CLOUDFLARE_ACCOUNT_ID=<aileron-inc Cloudflare account id>
npx wrangler secret put ROUTES_JSON < ~/.slack-support-bypass/routes.json
npx wrangler secret put SLACK_SIGNING_SECRET_ACME
# repeat for every *Env field in your home routes.json
npx wrangler deploy
```

Do not deploy until credentials and secrets are actually available. Bot tokens belong on the Grok Bot side only.

## How to add a company

1. Append one object to `~/.slack-support-bypass/routes.json`.
2. Add the three values to `~/.slack-support-bypass/secrets.env`.
3. Create the Slack app with Request URL `https://<worker>` + `path`.
4. `npm run sync-config` for local, or `wrangler secret put` for prod, then deploy.
5. No TypeScript change.

## Slack App setup

Create one Slack app From scratch per home-dir route row.

1. Create New App -> From scratch
2. Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`
3. Event Subscriptions: Request URL = worker URL + route path; bot events `app_mention`, `message.channels`, `message.groups`
4. Install to Workspace
5. Copy Signing Secret into `~/.slack-support-bypass/secrets.env`
6. Invite the bot to target channels

## Develop

```bash
npm install
npm test
npm run typecheck
npm run sync-config
npm run dev
```

## License

MIT

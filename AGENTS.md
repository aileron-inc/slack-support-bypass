# Agent boundary

This Worker is a **forward-only** Slack Events → Grok webhook pipe.

- Do not add reply, thread, FAQ, channel-routing, or LLM logic here.
- Do not call Slack Web API. The only Slack write is the `url_verification` `{ challenge }` response.
- Do not store events. Do not add PII deletion jobs.
- Do not hardcode a company-name switch.
- Public git: Worker code + README + `routes.example.json`. Never commit `routes.json` or secrets.
- Operator files are already on the machine: `~/.slack-support-bypass/routes.json` and `~/.slack-support-bypass/secrets.env`. Inject at dev/deploy via `.dev.vars` / `wrangler secret put`.
- Webhook failures are logged once. Do not add retries.

# Agent boundary

This Worker is a **forward-only** Slack Events to Grok webhook pipe.

- Do not add reply, thread, FAQ, channel-routing, or LLM logic here.
- Do not call Slack Web API. The only Slack write is the url_verification challenge response.
- Do not store events. Do not add PII deletion, retention, or redaction jobs.
- Do not hardcode a company-name switch. Routes are operator data, not source.
- Do not commit routes.json, team IDs, webhook URLs, or signing secrets. The public repo may contain routes.example.json (fake team IDs) only.
- Real route tables and secrets live in ~/.slack-support-bypass/routes.json and ~/.slack-support-bypass/secrets.env (plaintext). Inject them at dev/deploy via .dev.vars / wrangler secret put.
- Failures to the Grok webhook are logged once. Do not add retries.

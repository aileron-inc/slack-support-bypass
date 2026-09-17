import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import routesExample from "./routes.example.json" with { type: "json" };

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ROUTES_JSON: JSON.stringify(routesExample),
            SLACK_SIGNING_SECRET_ACME: "secret-acme",
            GROK_WEBHOOK_URL_ACME: "https://grok-webhook.test/acme",
            GROK_WEBHOOK_KEY_ACME: "key-acme",
            SLACK_SIGNING_SECRET_CONTOSO: "secret-contoso",
            GROK_WEBHOOK_URL_CONTOSO: "https://grok-webhook.test/contoso",
            GROK_WEBHOOK_KEY_CONTOSO: "key-contoso",
          },
        },
      },
    },
  },
});

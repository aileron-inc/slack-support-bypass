import { loadRoutes, routeFromPath, secretsFor } from "./routes";
import {
  grokWebhookBody,
  shouldForwardEvent,
  verifySlackSignature,
  type SlackPayload,
} from "./slack";

const WEBHOOK_TIMEOUT_MS = 8_000;

async function postGrokWebhook(
  url: string,
  key: string,
  body: ReturnType<typeof grokWebhookBody>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Automation-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({
          message: "grok webhook failed",
          route: body.route,
          status: res.status,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "grok webhook error",
        route: body.route,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = routeFromPath(url.pathname, loadRoutes(env));
    if (!route) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secrets = secretsFor(route, env);
    if (!secrets.signingSecret) {
      console.error(
        JSON.stringify({ message: "missing signing secret", route: route.name }),
      );
      return new Response("Server misconfigured", { status: 500 });
    }

    const rawBody = await request.text();
    const ok = await verifySlackSignature(
      secrets.signingSecret,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      rawBody,
    );
    if (!ok) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: SlackPayload;
    try {
      payload = JSON.parse(rawBody) as SlackPayload;
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (payload.type === "url_verification") {
      if (typeof payload.challenge !== "string") {
        return new Response("Bad request", { status: 400 });
      }
      return Response.json({ challenge: payload.challenge });
    }

    if (payload.type !== "event_callback") {
      return new Response(null, { status: 200 });
    }

    if (route.teamId && payload.team_id && payload.team_id !== route.teamId) {
      console.log(
        JSON.stringify({
          message: "skip team_id mismatch",
          route: route.name,
          team_id: payload.team_id,
        }),
      );
      return new Response(null, { status: 200 });
    }

    if (!shouldForwardEvent(payload.event)) {
      return new Response(null, { status: 200 });
    }

    if (!secrets.webhookUrl || !secrets.webhookKey) {
      console.error(
        JSON.stringify({
          message: "missing grok webhook config",
          route: route.name,
        }),
      );
      return new Response(null, { status: 200 });
    }

    const body = grokWebhookBody(route.name, payload, payload.event);
    console.log(
      JSON.stringify({
        message: "forward slack event",
        route: route.name,
        event_type: body.event_type,
        channel_id: body.channel_id,
      }),
    );
    ctx.waitUntil(postGrokWebhook(secrets.webhookUrl, secrets.webhookKey, body));
    return new Response(null, { status: 200 });
  },
} satisfies ExportedHandler<Env>;

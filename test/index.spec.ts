import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { loadRoutes, routeFromPath } from "../src/routes";
import {
  shouldForwardEvent,
  slackSignature,
  verifySlackSignature,
  type SlackEvent,
} from "../src/slack";
import routesExample from "../routes.example.json" with { type: "json" };

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type WebhookCall = {
  url: string;
  authorization: string;
  automationKey: string;
  body: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;
let webhookCalls: WebhookCall[] = [];

function mockWebhooks() {
  webhookCalls = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://grok-webhook.test/")) {
      const headers = new Headers(init?.headers);
      webhookCalls.push({
        url,
        authorization: headers.get("authorization") ?? "",
        automationKey: headers.get("x-automation-key") ?? "",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("ok", { status: 200 });
    }
    return originalFetch(input, init);
  };
}

beforeEach(() => {
  mockWebhooks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function signedRequest(
  path: string,
  secret: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Request<unknown, IncomingRequestCfProperties>> {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new IncomingRequest(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await slackSignature(secret, timestamp, rawBody),
      ...extraHeaders,
    },
    body: rawBody,
  });
}

async function send(request: Request<unknown, IncomingRequestCfProperties>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const mention = {
  type: "event_callback",
  team_id: "T000FAKE1",
  event: {
    type: "app_mention",
    user: "U111",
    text: "<@Ubot> hello",
    ts: "1710000000.000100",
    thread_ts: "1710000000.000050",
    channel: "C111",
  },
};

describe("verifySlackSignature", () => {
  const secret = "secret-acme";
  const body = '{"ok":true}';

  it("accepts a valid current signature", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await slackSignature(secret, timestamp, body);
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(
      true,
    );
  });

  it("rejects a wrong secret", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await slackSignature("other", timestamp, body);
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(
      false,
    );
  });

  it("rejects a replayed timestamp", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = await slackSignature(secret, timestamp, body);
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(
      false,
    );
  });

  it("rejects missing headers", async () => {
    expect(await verifySlackSignature(secret, null, "v0=abc", body)).toBe(false);
    expect(await verifySlackSignature(secret, "1", null, body)).toBe(false);
  });
});

describe("route lookup from injected data", () => {
  it("loads routes from ROUTES_JSON, not from a committed table", () => {
    const routes = loadRoutes(env);
    expect(routes.map((route) => route.name)).toEqual(
      routesExample.routes.map((route) => route.name),
    );
    expect(env.ROUTES_JSON).toBe(JSON.stringify(routesExample));
  });

  it("maps each sample path to that route record", () => {
    const routes = loadRoutes(env);
    for (const route of routesExample.routes) {
      expect(routeFromPath(route.path, routes)).toEqual(route);
    }
  });

  it("resolves trailing slashes via the same path data", () => {
    expect(routeFromPath("/slack/contoso/", loadRoutes(env))?.name).toBe(
      "contoso",
    );
  });

  it("rejects unknown paths", () => {
    const routes = loadRoutes(env);
    expect(routeFromPath("/slack/other", routes)).toBeNull();
    expect(routeFromPath("/acme", routes)).toBeNull();
  });

  it("keeps per-route teamId and env names on the injected rows", () => {
    const acme = routeFromPath("/slack/acme", loadRoutes(env));
    expect(acme?.teamId).toBe("T000FAKE1");
    expect(acme?.signingSecretEnv).toBe("SLACK_SIGNING_SECRET_ACME");
    expect(acme?.webhookUrlEnv).toBe("GROK_WEBHOOK_URL_ACME");
    expect(acme?.webhookKeyEnv).toBe("GROK_WEBHOOK_KEY_ACME");
  });

  it("returns no routes when ROUTES_JSON is missing or invalid", () => {
    expect(loadRoutes({})).toEqual([]);
    expect(loadRoutes({ ROUTES_JSON: "not-json" })).toEqual([]);
    expect(loadRoutes({ ROUTES_JSON: "{}" })).toEqual([]);
  });
});

describe("shouldForwardEvent", () => {
  const human: SlackEvent = {
    type: "message",
    user: "U111",
    text: "hi",
    ts: "1.2",
    channel: "C111",
  };

  it("forwards human app_mention and message", () => {
    expect(shouldForwardEvent(human)).toBe(true);
    expect(shouldForwardEvent({ ...human, type: "app_mention" })).toBe(true);
  });

  it("ignores bots, edits, and deletes", () => {
    expect(shouldForwardEvent({ ...human, bot_id: "B1" })).toBe(false);
    expect(shouldForwardEvent({ ...human, subtype: "bot_message" })).toBe(false);
    expect(shouldForwardEvent({ ...human, subtype: "message_changed" })).toBe(
      false,
    );
    expect(shouldForwardEvent({ ...human, subtype: "message_deleted" })).toBe(
      false,
    );
  });
});

describe("worker", () => {
  it("returns challenge for url_verification", async () => {
    const res = await send(
      await signedRequest("/slack/acme", "secret-acme", {
        type: "url_verification",
        challenge: "challenge-xyz",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "challenge-xyz" });
    expect(webhookCalls).toHaveLength(0);
  });

  it("rejects a bad signature", async () => {
    const rawBody = JSON.stringify(mention);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await send(
      new IncomingRequest("https://example.com/slack/acme", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": await slackSignature("wrong", timestamp, rawBody),
        },
        body: rawBody,
      }),
    );
    expect(res.status).toBe(401);
    expect(webhookCalls).toHaveLength(0);
  });

  it("404s unknown routes", async () => {
    const res = await send(
      await signedRequest("/slack/unknown", "secret-acme", mention),
    );
    expect(res.status).toBe(404);
    expect(webhookCalls).toHaveLength(0);
  });

  it.each(
    routesExample.routes.map((route) => [
      route.name,
      route.path,
      `secret-${route.name}`,
      `key-${route.name}`,
      route.teamId ?? "T000FAKE1",
    ]),
  )(
    "forwards %s events to that app webhook from injected route data",
    async (name, path, secret, key, teamId) => {
      const res = await send(
        await signedRequest(path, secret, {
          ...mention,
          team_id: teamId,
        }),
      );
      expect(res.status).toBe(200);
      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0]?.url).toBe(`https://grok-webhook.test/${name}`);
      expect(webhookCalls[0]?.authorization).toBe(`Bearer ${key}`);
      expect(webhookCalls[0]?.automationKey).toBe(key);
      expect(webhookCalls[0]?.body).toEqual({
        action: "slack_event",
        route: name,
        event_type: "app_mention",
        channel_id: "C111",
        thread_ts: "1710000000.000050",
        message_ts: "1710000000.000100",
        user_id: "U111",
        text: "<@Ubot> hello",
        team_id: teamId,
        permalink: null,
      });
    },
  );

  it("acks bot messages without forwarding", async () => {
    const res = await send(
      await signedRequest("/slack/acme", "secret-acme", {
        type: "event_callback",
        team_id: "T000FAKE1",
        event: {
          type: "message",
          bot_id: "B999",
          user: "Ubot",
          text: "I am a bot",
          ts: "1.1",
          channel: "C111",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(webhookCalls).toHaveLength(0);
  });

  it("acks message_changed and message_deleted without forwarding", async () => {
    for (const subtype of ["message_changed", "message_deleted"] as const) {
      webhookCalls = [];
      const res = await send(
        await signedRequest("/slack/contoso", "secret-contoso", {
          type: "event_callback",
          team_id: "T000FAKE2",
          event: {
            type: "message",
            subtype,
            user: "U111",
            text: "edited",
            ts: "1.1",
            channel: "C111",
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(webhookCalls).toHaveLength(0);
    }
  });

  it("forwards a human message event", async () => {
    const res = await send(
      await signedRequest("/slack/contoso", "secret-contoso", {
        type: "event_callback",
        team_id: "T000FAKE2",
        event: {
          type: "message",
          user: "U222",
          text: "help",
          ts: "2.2",
          channel: "C222",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.body.thread_ts).toBeNull();
    expect(webhookCalls[0]?.body.event_type).toBe("message");
  });

  it("acks events from the wrong team without forwarding", async () => {
    const res = await send(
      await signedRequest("/slack/acme", "secret-acme", {
        ...mention,
        team_id: "T000FAKE2",
      }),
    );
    expect(res.status).toBe(200);
    expect(webhookCalls).toHaveLength(0);
  });
});

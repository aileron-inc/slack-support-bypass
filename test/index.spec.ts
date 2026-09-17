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
): Promise<Request<unknown, IncomingRequestCfProperties>> {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new IncomingRequest(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await slackSignature(secret, timestamp, rawBody),
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
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await slackSignature("other", timestamp, body);
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(false);
  });

  it("rejects a replayed timestamp", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = await slackSignature(secret, timestamp, body);
    expect(await verifySlackSignature(secret, timestamp, signature, body)).toBe(false);
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
  });

  it("maps each sample path to that route record", () => {
    const routes = loadRoutes(env);
    for (const route of routesExample.routes) {
      expect(routeFromPath(route.path, routes)).toEqual(route);
    }
  });

  it("rejects unknown paths", () => {
    expect(routeFromPath("/slack/other", loadRoutes(env))).toBeNull();
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
    expect(shouldForwardEvent({ ...human, subtype: "message_changed" })).toBe(false);
    expect(shouldForwardEvent({ ...human, subtype: "message_deleted" })).toBe(false);
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
    const res = await send(await signedRequest("/slack/unknown", "secret-acme", mention));
    expect(res.status).toBe(404);
    expect(webhookCalls).toHaveLength(0);
  });

  it("forwards acme events to that app webhook", async () => {
    const res = await send(await signedRequest("/slack/acme", "secret-acme", mention));
    expect(res.status).toBe(200);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.url).toBe("https://grok-webhook.test/acme");
    expect(webhookCalls[0]?.authorization).toBe("Bearer key-acme");
    expect(webhookCalls[0]?.automationKey).toBe("key-acme");
  });

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

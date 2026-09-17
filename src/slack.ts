const REPLAY_WINDOW_SEC = 60 * 5;

export type SlackEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
};

export type SlackPayload = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackEvent;
};

export type GrokWebhookBody = {
  action: "slack_event";
  route: string;
  event_type: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string;
  user_id: string;
  text: string;
  team_id: string;
  permalink: null;
};

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toHex(mac);
}

export async function slackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const digest = await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`);
  return `v0=${digest}`;
}

export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_WINDOW_SEC) {
    return false;
  }

  const expected = await slackSignature(signingSecret, timestamp, rawBody);
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(signature);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export function shouldForwardEvent(
  event: SlackEvent | undefined,
): event is SlackEvent & {
  type: "app_mention" | "message";
  channel: string;
  ts: string;
  user: string;
} {
  if (!event) return false;
  if (event.type !== "app_mention" && event.type !== "message") return false;
  if (event.bot_id) return false;
  if (
    event.subtype === "bot_message" ||
    event.subtype === "message_changed" ||
    event.subtype === "message_deleted"
  ) {
    return false;
  }
  return Boolean(event.channel && event.ts && event.user);
}

export function grokWebhookBody(
  routeName: string,
  payload: SlackPayload,
  event: SlackEvent & {
    type: string;
    channel: string;
    ts: string;
    user: string;
  },
): GrokWebhookBody {
  return {
    action: "slack_event",
    route: routeName,
    event_type: event.type,
    channel_id: event.channel,
    thread_ts: event.thread_ts ?? null,
    message_ts: event.ts,
    user_id: event.user,
    text: event.text ?? "",
    team_id: payload.team_id ?? "",
    permalink: null,
  };
}

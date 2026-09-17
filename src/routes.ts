export type RouteConfig = {
  name: string;
  path: string;
  teamId?: string;
  signingSecretEnv: string;
  webhookUrlEnv: string;
  webhookKeyEnv: string;
};

type RoutesFile = {
  routes: RouteConfig[];
};

function isRouteConfig(value: unknown): value is RouteConfig {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  return (
    typeof route.name === "string" &&
    typeof route.path === "string" &&
    typeof route.signingSecretEnv === "string" &&
    typeof route.webhookUrlEnv === "string" &&
    typeof route.webhookKeyEnv === "string" &&
    (route.teamId === undefined || typeof route.teamId === "string")
  );
}

/** Parse operator route table from env.ROUTES_JSON (home-dir file, injected at dev/deploy). */
export function loadRoutes(env: Env): RouteConfig[] {
  const raw = env.ROUTES_JSON;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as RoutesFile).routes)
      ? (parsed as RoutesFile).routes
      : [];

  return rows.filter(isRouteConfig);
}

export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/** Path lookup against injected route data. No company-name switch. */
export function routeFromPath(
  pathname: string,
  routes: readonly RouteConfig[],
): RouteConfig | null {
  const path = normalizePath(pathname);
  return routes.find((route) => route.path === path) ?? null;
}

export function secretsFor(
  route: RouteConfig,
  env: Env,
): {
  signingSecret: string | undefined;
  webhookUrl: string | undefined;
  webhookKey: string | undefined;
} {
  return {
    signingSecret: env[route.signingSecretEnv],
    webhookUrl: env[route.webhookUrlEnv],
    webhookKey: env[route.webhookKeyEnv],
  };
}

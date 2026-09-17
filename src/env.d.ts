// Secrets and ROUTES_JSON are injected from ~/.slack-support-bypass at
// dev/deploy. Names come from the operator route table, not from wrangler.jsonc.
interface Env {
  ROUTES_JSON?: string;
  [key: string]: string | undefined;
}

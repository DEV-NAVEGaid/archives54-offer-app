import { createHmac, timingSafeEqual } from "node:crypto";

export function stripGid(id: string): string {
  if (!id) return id;
  const match = id.match(/\/(\d+)$/);
  return match ? match[1] : id;
}

// ponytail: client-supplied shopDomain flows into fetch URLs that carry the
// Admin API token — without this check, "{shopDomain: 'evil.com'}" exfiltrates
// the token. This app serves exactly ONE shop, so allow-list it.
export function getTrustedShopDomain(clientDomain: string): string | null {
  const normalize = (s: string) =>
    s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  const trusted = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!trusted || !clientDomain) return null;
  return normalize(clientDomain) === normalize(trusted)
    ? normalize(clientDomain)
    : null;
}

// ponytail: verifies Shopify app-proxy (or OAuth callback) HMAC signature.
// Blocks direct API access — requests must arrive through Shopify's proxy.
// Does NOT authenticate the customerId itself (still client-supplied); a full
// fix needs Customer Accounts API. Proportionate for low-stakes UI state.
export function verifyShopifySignature(
  searchParams: URLSearchParams,
  sigParam = "signature"
): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;
  const sig = searchParams.get(sigParam);
  if (!sig) return false;
  const params: Record<string, string> = {};
  searchParams.forEach((v, k) => {
    if (k !== sigParam) params[k] = v;
  });
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
  
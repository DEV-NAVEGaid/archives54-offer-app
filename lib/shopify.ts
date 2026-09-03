import { createHmac, timingSafeEqual } from "node:crypto";

export function stripGid(id: string): string {
  if (!id) return id;
  const match = id.match(/\/(\d+)$/);
  return match ? match[1] : id;
}

export function getTrustedShopDomain(clientDomain: string): string | null {
  const normalize = (s: string) =>
    s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  const trusted = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!trusted || !clientDomain) return null;
  return normalize(clientDomain) === normalize(trusted)
    ? normalize(clientDomain)
    : null;
}

// Verify Shopify App Proxy HMAC and return the authenticated shop/customer.
export function verifyShopifySignature(
  searchParams: URLSearchParams,
  sigParam = "signature"
): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;
  const sig = searchParams.get(sigParam);
  if (!sig) return false;
  const params = new Map<string, string[]>();
  searchParams.forEach((v, k) => {
    if (k === sigParam) return;
    const values = params.get(k) || [];
    values.push(v);
    params.set(k, values);
  });
  const message = Array.from(params.entries())
    .map(([k, values]) => `${k}=${values.join(",")}`)
    .sort()
    .join("");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function getAppProxyAuth(
  searchParams: URLSearchParams
): { customerId: string; shopDomain: string } | null {
  if (!verifyShopifySignature(searchParams)) return null;

  const shop = searchParams.get("shop");
  const loggedInCustomerId = searchParams.get("logged_in_customer_id");
  if (!shop || !loggedInCustomerId) return null;

  const shopDomain = getTrustedShopDomain(shop);
  const customerId = stripGid(loggedInCustomerId);
  if (!shopDomain || !customerId) return null;

  return { customerId, shopDomain };
}

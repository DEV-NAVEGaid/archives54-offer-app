import { redis } from "./redis";

const EXPIRY_MINUTES = 30;

// Generate unique discount code: ARCH54-XXXXXX
export function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "ARCH54-";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Create discount code in Shopify via GraphQL + store in Redis
export async function createDiscountCode(params: {
  productId: string;
  variantId: string;
  customerId: string;
  shopDomain: string;
  salePrice: number;
  finalPrice: number;
}): Promise<{ code: string; expiresIn: number } | null> {
  const { productId, variantId, customerId, shopDomain, salePrice, finalPrice } = params;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("[Archive54] SHOPIFY_ACCESS_TOKEN not set");
    return null;
  }

  const code = generateCode();
  const expiresIn = EXPIRY_MINUTES * 60;
  const expiresAt = Date.now() + expiresIn * 1000;

  // Calculate fixed discount amount; guard below refuses codes with no real discount
  const discountAmount = Math.round((salePrice - finalPrice) * 100) / 100;

  // If no discount needed (finalPrice >= salePrice), skip code creation
  if (discountAmount <= 0) {
    console.warn(`[Archive54] No discount needed: salePrice ${salePrice} <= finalPrice ${finalPrice} (product ${productId})`);
    return null;
  }

  // Use GraphQL to create discount code (only needs write_discounts scope)
  const endsAt = new Date(expiresAt).toISOString();
  const productGid = `gid://shopify/Product/${productId}`;

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: `ARCH54 ${code}`,
      code: code,
      startsAt: new Date().toISOString(),
      endsAt: endsAt,
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerGets: {
        value: {
          discountAmount: {
            amount: discountAmount.toFixed(2),
            appliesOnEachItem: false
          }
        },
        items: {
          products: {
            productsToAdd: [productGid],
          },
        },
      },
      customerSelection: {
        customers: {
          add: [`gid://shopify/Customer/${customerId}`],
        },
      },
    },
  };

  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/2026-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: mutation, variables }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Archive54] GraphQL discount creation failed:", res.status, errText);
      return null;
    }

    const data = await res.json();

    if (data.errors && data.errors.length > 0) {
      console.error("[Archive54] GraphQL errors:", JSON.stringify(data.errors));
      return null;
    }

    const userErrors = data.data?.discountCodeBasicCreate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      console.error("[Archive54] Discount creation user errors:", JSON.stringify(userErrors));
      return null;
    }

    console.log(`[Archive54] Discount code created via GraphQL: ${code} for product ${productId}, expires in ${EXPIRY_MINUTES}min`);

    // 2. Store in Redis for server-side validation — best effort: Shopify
    // enforces expiry/usage/customer at checkout even if Redis is down
    try {
      await redis.set(
        `discount:${code}`,
        JSON.stringify({
          code,
          productId,
          variantId,
          finalPrice,
          expiresAt,
          customerId,
          used: false,
        }),
        { ex: expiresIn }
      );
    } catch (e) {
      console.error("[Archive54] Redis unavailable — code only stored in Shopify:", e);
    }

    return { code, expiresIn };
  } catch (e) {
    console.error("[Archive54] Discount creation error:", e);
    return null;
  }
}

// Validate a discount code
export async function validateDiscountCode(
  code: string,
  shopDomain: string
): Promise<{ valid: boolean; message: string; finalPrice?: number }> {
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!accessToken) {
    return { valid: false, message: "Server nicht konfiguriert." };
  }

  // 1. Check Redis — graceful: if Redis is down, say "can't check" not "not found"
  let raw: string | null;
  try {
    raw = await redis.get<string>(`discount:${code}`);
  } catch (e) {
    console.error("[Archive54] Redis unavailable during code validation:", e);
    return {
      valid: false,
      message:
        "Rabattcode kann derzeit nicht geprüft werden. Bitte versuchen Sie es in wenigen Minuten erneut.",
    };
  }
  if (!raw) {
    return { valid: false, message: "Rabattcode nicht gefunden oder abgelaufen." };
  }

  const data = typeof raw === "string" ? JSON.parse(raw) : raw;

  // 2. Check expiry
  if (Date.now() > data.expiresAt) {
    await redis.del(`discount:${code}`);
    return { valid: false, message: "Rabattcode ist abgelaufen." };
  }

  // 3. Check if already used
  if (data.used) {
    return { valid: false, message: "Rabattcode wurde bereits verwendet." };
  }

  return {
    valid: true,
    message: "Rabattcode gültig.",
    finalPrice: data.finalPrice,
  };
}

// Mark discount code as used
export async function markDiscountUsed(code: string): Promise<void> {
  // ponytail: best-effort flag — Shopify usageLimit 1 is the real enforcement
  try {
    const raw = await redis.get<string>(`discount:${code}`);
    if (raw) {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      data.used = true;
      await redis.set(`discount:${code}`, JSON.stringify(data), { ex: 1800 });
    }
  } catch (e) {
    console.error("[Archive54] markDiscountUsed failed (ignored):", e);
  }
}

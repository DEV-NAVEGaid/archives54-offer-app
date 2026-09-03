import { redis } from "./redis";

const PRICING_CACHE_TTL = 300;

export interface ProductPricing {
  uvp: number; // Compare-at price (regular price before discount)
  salePrice: number; // Listed sale price (54% off UVP)
  floorPrice: number; // Minimum offer level (60% off UVP)
  counterTriggerPrice: number; // Minimum offer that gets a counter (85% of floor)
  counterPrice: number; // Counter offer midpoint between sale and floor
  variantId: string;
  metafieldOverride: boolean;
  availableForSale: boolean;
}

export interface OfferEvaluation {
  result: "accept" | "counter" | "decline";
  action:
  | "ACCEPT"
  | "ACCEPT_NO_CODE"
  | "COUNTER"
  | "DECLINE";
  message: string;
  finalPrice: number;
  counterPrice?: number;
  discountCode?: string;
  expiresIn?: number;
}

// Round to 2 decimal places
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Out of stock per Admin REST: untracked, or "continue" policy, or qty > 0
function computeAvailability(variant: {
  inventory_management?: string | null;
  inventory_policy?: string;
  inventory_quantity?: number | null;
}): boolean {
  return (
    variant.inventory_management == null ||
    variant.inventory_policy === "continue" ||
    (variant.inventory_quantity ?? 0) > 0
  );
}

async function fetchVariant(
  productId: string,
  variantId: string,
  shopDomain: string,
  accessToken: string
): Promise<{
  id: number;
  price: string;
  compare_at_price?: string;
  inventory_management?: string | null;
  inventory_policy?: string;
  inventory_quantity?: number | null;
  [k: string]: unknown;
}> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/2026-10/products/${productId}.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) throw new Error(`Failed to fetch product: ${res.status}`);
  const data = await res.json();
  const variant = data.product.variants.find(
    (v: { id: number }) => String(v.id) === String(variantId)
  );
  if (!variant) throw new Error(`Variant ${variantId} not found on product ${productId}`);
  return variant;
}

// Fetch product pricing from Shopify Admin API
export async function getProductPricing(
  productId: string,
  variantId: string,
  shopDomain: string
): Promise<ProductPricing> {

  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN not set");

  const cacheKey = `pricing:v4:${productId}:${variantId}`;
  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      console.log(`[Archive54] Pricing cache hit for variant ${variantId}`);
      const p = typeof cached === "string" ? JSON.parse(cached) : cached;
      try {
        const v = await fetchVariant(productId, variantId, shopDomain, accessToken);
        p.availableForSale = computeAvailability(v);
      } catch {
        // keep cached availability if refresh fails
      }
      return p;
    }
  } catch {
    // cache is optional
  }

  // ALWAYS fetch from Shopify Admin API (Security: Never trust frontend prices)
  console.log(`[Archive54] Fetching pricing from Shopify API for security...`);
  const variant = await fetchVariant(productId, variantId, shopDomain, accessToken);
  const availableForSale = computeAvailability(variant);

  const rawPrice = Number(variant.price);
  const rawCompare = Number(variant.compare_at_price ?? "");
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new Error(`Variant ${variantId} has no valid price (price=${variant.price}) — set the price in Shopify admin`);
  }
  // else "0.00" string would make uvp=0 → floor=0 → every offer accepted
  const salePrice = round2(rawPrice);
  const uvp = Number.isFinite(rawCompare) && rawCompare > rawPrice ? round2(rawCompare) : salePrice;

  let floorPrice = round2(uvp * 0.40);
  let metafieldOverride = false;
  const metafield = await getVariantMetafield(
    variantId,
    "archive54",
    "min_price",
    shopDomain,
    accessToken
  );
  if (metafield) {
    const configuredFloor = Number(metafield.value);
    if (Number.isFinite(configuredFloor) && configuredFloor > 0 && configuredFloor <= salePrice) {
      floorPrice = round2(configuredFloor);
      metafieldOverride = true;
    } else {
      console.warn(
        `[Archive54] Ignoring invalid metafield min_price=${metafield.value} for variant ${variantId}`
      );
    }
  }

  const counterPrice = Math.min(round2((salePrice + floorPrice) / 2), salePrice);
  const counterTriggerPrice = round2(floorPrice * 0.85);

  const pricing: ProductPricing = {
    uvp,
    salePrice,
    floorPrice,
    counterTriggerPrice,
    counterPrice,
    variantId,
    metafieldOverride,
    availableForSale,
  };

  try {
    await redis.set(cacheKey, JSON.stringify(pricing), { ex: PRICING_CACHE_TTL });
  } catch {
    // cache is optional
  }

  return pricing;
}

async function getVariantMetafield(
  variantId: string,
  namespace: string,
  key: string,
  shopDomain: string,
  accessToken: string
): Promise<{ value: string } | null> {
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/2026-10/variants/${variantId}/metafields.json?namespace=${namespace}&key=${key}`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    return data.metafields?.[0] || null;
  } catch {
    return null;
  }
}

// Evaluate customer offer against pricing rules
export function evaluateOffer(
  customerOffer: number,
  pricing: ProductPricing
): OfferEvaluation {
  const amt = round2(customerOffer);
  // Scenario 1: Offer ≥ Sale Price → Accept at sale price
  if (amt >= pricing.salePrice) {
    // If salePrice == UVP (no discount), no code needed — just accept at regular price
    if (pricing.salePrice >= pricing.uvp) {
      return {
        result: "accept",
        action: "ACCEPT_NO_CODE",
        message: `Ihr Angebot wurde akzeptiert! Der reguläre Preis beträgt ${fmtEUR(pricing.salePrice)}.`,
        finalPrice: pricing.salePrice,
      };
    }
    // If salePrice < UVP (has discount), still accept at sale price — no extra code needed
    return {
      result: "accept",
      action: "ACCEPT_NO_CODE",
      message: `Ihr Angebot wurde akzeptiert! Der Sale-Preis beträgt ${fmtEUR(pricing.salePrice)}.`,
      finalPrice: pricing.salePrice,
    };
  }

  // Scenario 2: Offer ≥ Floor Price → Accept, generate discount code
  if (amt >= pricing.floorPrice) {
    return {
      result: "accept",
      action: "ACCEPT",
      message: `Ihr Angebot von ${fmtEUR(amt)} wurde akzeptiert!`,
      finalPrice: amt,
    };
  }

  // Scenario 3: Offer ≥ Counter Trigger but below the floor → Counter
  if (amt >= pricing.counterTriggerPrice) {
    return {
      result: "counter",
      action: "COUNTER",
      message: `Wie wäre es mit ${fmtEUR(pricing.counterPrice)}?`,
      finalPrice: amt,
      counterPrice: pricing.counterPrice,
    };
  }

  // Scenario 4: Offer below the floor → Decline
  return {
    result: "decline",
    action: "DECLINE",
    message:
      "Dein Angebot liegt unter unserem Mindestpreis für diesen Designer.",
    finalPrice: pricing.floorPrice,
  };
}

function fmtEUR(amount: number): string {
  return amount.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

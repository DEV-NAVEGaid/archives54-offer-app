import { redis } from "./redis";

const PRICING_CACHE_TTL = 300;

export interface ProductPricing {
  uvp: number; // Compare-at price (regular price before discount)
  salePrice: number; // Listed sale price (54% off UVP)
  floorPrice: number; // Minimum acceptable (60% off UVP or metafield)
  counterPrice: number; // Counter offer (~57% off UVP)
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

// Fetch a single variant from the product's variant list via Admin REST
// ponytail: typed loosely — Shopify variant JSON has 6+ fields we access
// dynamically; a full interface is ceremony for a one-fetch helper
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
  shopDomain: string,
  widgetSalePrice?: number,
  widgetCompareAtPrice?: number
): Promise<ProductPricing> {

  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN not set");

  const cacheKey = `pricing:${productId}:${variantId}`;
  // ponytail: cache is optional — read/write failures are swallowed, pricing
  // works without Redis. The random floor is frozen per cache window, which
  // makes quotes consistent within those 5 minutes. Availability is always
  // refreshed on a hit (inventory changes between cache write and now) — the
  // 1 product fetch is still cheaper than the 2 calls (product + metafield)
  // on a miss.
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

  const rawPrice = parseFloat(variant.price);
  const rawCompare = parseFloat(variant.compare_at_price ?? "");
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new Error(`Variant ${variantId} has no valid price (price=${variant.price}) — set the price in Shopify admin`);
  }
  // else "0.00" string would make uvp=0 → floor=0 → every offer accepted
  const salePrice = round2(rawPrice);
  const uvp = Number.isFinite(rawCompare) && rawCompare > rawPrice ? round2(rawCompare) : salePrice;

  // Check metafield override for accept price (variant level)
  let acceptPrice: number;
  let metafieldOverride = false;
  if (accessToken) {
    const metafield = await getVariantMetafield(
      variantId, "archive54", "min_price", shopDomain, accessToken
    );
    // else "0.5" or garbage would make floor ~0 → every offer accepted
    const metaValue = metafield ? parseFloat(metafield.value) : NaN;
    if (Number.isFinite(metaValue) && metaValue > 0 && metaValue < salePrice) {
      acceptPrice = round2(metaValue);
      metafieldOverride = true;
    } else {
      if (metafield) console.warn(`[Archive54] Ignoring invalid metafield min_price=${metafield.value} for variant ${variantId}`);
      // Default: Random between 54% and 60% off UVP
      const randomDiscount = 0.54 + Math.random() * (0.60 - 0.54);
      acceptPrice = round2(uvp * (1 - randomDiscount));
    }
  } else {
    const randomDiscount = 0.54 + Math.random() * (0.60 - 0.54);
    acceptPrice = round2(uvp * (1 - randomDiscount));
  }

  // Minimum offer to trigger a counter (e.g., 15% below accept price)
  const counterTriggerPrice = round2(acceptPrice * 0.85);

  const pricing: ProductPricing = {
    uvp,
    salePrice,
    floorPrice: acceptPrice, // Renamed in interface conceptually, keeping floorPrice for compat
    counterPrice: counterTriggerPrice,
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

// Get metafield from Shopify (variant level)
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

  // Scenario 3: Offer >= counterPrice but < floor → Counter with Accept Price
  if (amt >= pricing.counterPrice) {
    return {
      result: "counter",
      action: "COUNTER",
      message: `Wie wäre es mit ${fmtEUR(pricing.floorPrice)}? Das ist unser Mindestpreis.`,
      finalPrice: amt,
      counterPrice: pricing.floorPrice,
    };
  }

  // Scenario 4: Offer < counter price → Decline
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

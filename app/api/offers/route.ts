import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, reserveOffer, getDailyUsage, refundOffer, setPendingCounter } from "@/lib/rate-limit";
import { getProductPricing, evaluateOffer } from "@/lib/pricing";
import { stripGid, getTrustedShopDomain } from "@/lib/shopify";
import { createDiscountCode } from "@/lib/discount";
import { RedisUnavailableError } from "@/lib/redis";

// GET — check customer's daily quota status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId");
    const productId = searchParams.get("productId");

    if (!customerId) {
      return NextResponse.json(
        { action: "ERROR", message: "customerId fehlt." },
        { status: 400 }
      );
    }

    const usage = await getDailyUsage(customerId);

    let productOffered = false;
    if (productId) {
      const check = await checkRateLimit(customerId, productId);
      productOffered = check.productOffered;
    }

    return NextResponse.json({
      action: "OK",
      dailyCount: usage.used,
      remaining: usage.remaining,
      productOffered,
    });
  } catch (error) {
    console.error("[Archive54] Quota check error:", error);
    return NextResponse.json(
      { action: "ERROR", message: "Fehler beim Laden der Quota." },
      { status: 500 }
    );
  }
}

// POST — submit an offer
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { customerId, amount, shopDomain } = body;
    let { productId, variantId } = body;

    // Strip Shopify GID prefixes (e.g. "gid://shopify/Product/12345" → "12345")
    productId = stripGid(productId);
    variantId = stripGid(variantId);

    // Validate required fields
    if (!customerId || !productId || !variantId || !amount || !shopDomain) {
      return NextResponse.json(
        {
          action: "ERROR",
          message: "Pflichtfelder fehlen.",
        },
        { status: 400 }
      );
    }

    const offerAmount = parseFloat(String(amount));
    if (isNaN(offerAmount) || offerAmount <= 0) {
      return NextResponse.json(
        {
          action: "ERROR",
          message: "Ungültiger Betrag.",
        },
        { status: 400 }
      );
    }

    // Never let client-supplied shopDomain point our Admin API token elsewhere
    const trustedDomain = getTrustedShopDomain(shopDomain);
    if (!trustedDomain) {
      return NextResponse.json(
        { action: "ERROR", message: "Ungültige Shop-Domain." },
        { status: 400 }
      );
    }

    // 1. Atomically reserve quota (SET NX per product + incr daily — no TOCTOU race)
    const rateCheck = await reserveOffer(customerId, productId);
    if (!rateCheck.reserved) {
      const productOffered = rateCheck.reason?.includes("Produkt");
      return NextResponse.json({
        action: productOffered ? "ALREADY_OFFERED" : "QUOTA_FULL",
        message: rateCheck.reason,
        dailyCount: rateCheck.dailyCount,
        remaining: rateCheck.remaining,
      });
    }

    // 2. Build pricing using shared logic in lib/pricing.ts
    const widgetSalePrice = body.salePrice ? parseFloat(String(body.salePrice)) : 0;
    const widgetCompareAtPrice = body.compareAtPrice ? parseFloat(String(body.compareAtPrice)) : 0;

    const pricing = await getProductPricing(
      productId,
      variantId,
      trustedDomain,
      widgetSalePrice,
      widgetCompareAtPrice
    );

    // 3. Evaluate offer against rules
    // Out of stock → ERROR (not DECLINE) so widget shows inline message without
    // incrementing quota visually; server already refunded the reserved slot.
    if (!pricing.availableForSale) {
      await refundOffer(customerId, productId, true);
      return NextResponse.json({
        action: "ERROR",
        message: "Dieser Artikel ist leider ausverkauft.",
      });
    }

    const evaluation = evaluateOffer(offerAmount, pricing);

    // 4. Quota already reserved atomically in step 1 — get count for response
    const usage = await getDailyUsage(customerId);

    // 6. Build response
    const response: Record<string, unknown> = {
      action: evaluation.action,
      message: evaluation.message,
      finalPrice: evaluation.finalPrice,
      dailyCount: usage.used,
      remaining: usage.remaining,
    };

    // For counter offers, include counter price + store pending counter (bug 10)
    if (evaluation.action === "COUNTER") {
      response.counterPrice = evaluation.counterPrice;
      await setPendingCounter(customerId, productId, evaluation.counterPrice!);
    }

    // For ACCEPT (with code), generate discount code
    if (evaluation.action === "ACCEPT") {
      try {
        const discount = await createDiscountCode({
          productId,
          variantId,
          customerId,
          shopDomain: trustedDomain,
          salePrice: pricing.salePrice,
          finalPrice: evaluation.finalPrice,
        });
        if (discount) {
          response.discountCode = discount.code;
          response.expiresIn = discount.expiresIn;
        } else {
          // Discount code failed — fall back to ACCEPT_NO_CODE
          console.warn("[Archive54] Discount code generation returned null, falling back to ACCEPT_NO_CODE");
          response.action = "ACCEPT_NO_CODE";
          response.message = `Ihr Angebot wurde akzeptiert! Der Sale-Preis beträgt ${pricing.salePrice.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}.`;
          response.finalPrice = pricing.salePrice;
        }
      } catch (e) {
        console.error("[Archive54] Discount code generation failed:", e);
        // Fall back to ACCEPT_NO_CODE
        response.action = "ACCEPT_NO_CODE";
        response.message = `Ihr Angebot wurde akzeptiert! Der Sale-Preis beträgt ${pricing.salePrice.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}.`;
        response.finalPrice = pricing.salePrice;
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Archive54] Offer error:", error);
    if (error instanceof RedisUnavailableError) {
      return NextResponse.json(
        {
          action: "ERROR",
          message:
            "Unser System ist momentan nicht verfügbar. Bitte versuchen Sie es in wenigen Minuten erneut.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        action: "ERROR",
        message: error instanceof Error ? error.message : "Ein interner Fehler ist aufgetreten.",
      },
      { status: 400 }
    );
  }
}



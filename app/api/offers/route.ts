import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, reserveOffer, getDailyUsage, refundOffer, setPendingCounter } from "@/lib/rate-limit";
import { getProductPricing, evaluateOffer } from "@/lib/pricing";
import { stripGid, getAppProxyAuth } from "@/lib/shopify";
import { createDiscountCode } from "@/lib/discount";
import { RedisUnavailableError } from "@/lib/redis";

// GET — check customer's daily quota status
export async function GET(request: NextRequest) {
  try {
    const auth = getAppProxyAuth(new URL(request.url).searchParams);
    if (!auth) {
      return NextResponse.json(
        { action: "ERROR", message: "Nicht authentifiziert." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const customerId = auth.customerId;
    const productId = searchParams.get("productId");

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
  let reservation: { customerId: string; productId: string } | null = null;

  try {
    const auth = getAppProxyAuth(new URL(request.url).searchParams);
    if (!auth) {
      return NextResponse.json(
        { action: "ERROR", message: "Nicht authentifiziert." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { amount } = body;
    const { customerId, shopDomain } = auth;
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

    const rawAmount = typeof amount === "number" || typeof amount === "string"
      ? Number(amount)
      : NaN;
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      return NextResponse.json(
        {
          action: "ERROR",
          message: "Ungültiger Betrag.",
        },
        { status: 400 }
      );
    }
    const offerAmount = Math.round(rawAmount * 100) / 100;

    const trustedDomain = shopDomain;

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
    reservation = { customerId, productId };

    // 2. Build pricing using shared logic in lib/pricing.ts
    const pricing = await getProductPricing(productId, variantId, trustedDomain);

    // 3. Evaluate offer against rules
    // Out of stock → DECLINE, but refund the reservation because no offer was
    // actually evaluated. The widget keeps the product retryable.
    if (!pricing.availableForSale) {
      await refundOffer(customerId, productId, true);
      reservation = null;
      return NextResponse.json({
        action: "DECLINE",
        message: "Dieser Artikel ist leider ausverkauft.",
        quotaRefunded: true,
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
      const pendingSaved = await setPendingCounter(
        customerId,
        productId,
        evaluation.counterPrice!
      );
      if (!pendingSaved) throw new RedisUnavailableError();
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
    if (reservation) {
      await refundOffer(reservation.customerId, reservation.productId, true);
      reservation = null;
    }
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

import { NextRequest, NextResponse } from "next/server";
import { stripGid, getAppProxyAuth } from "@/lib/shopify";
import { createDiscountCode } from "@/lib/discount";
import { refundOffer, consumePendingCounter, setPendingCounter } from "@/lib/rate-limit";
import { getProductPricing } from "@/lib/pricing";
import { RedisUnavailableError } from "@/lib/redis";

export async function POST(request: NextRequest) {
  try {
    const auth = getAppProxyAuth(new URL(request.url).searchParams);
    if (!auth) {
      return NextResponse.json(
        { action: "ERROR", message: "Nicht authentifiziert." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { counterPrice } = body;
    const { customerId, shopDomain } = auth;
    let { productId, variantId } = body;

    productId = stripGid(productId);
    variantId = stripGid(variantId);

    if (!customerId || !productId || !variantId || !counterPrice || !shopDomain) {
      return NextResponse.json(
        { action: "ERROR", message: "Pflichtfelder fehlen." },
        { status: 400 }
      );
    }

    const rawPrice = typeof counterPrice === "number" || typeof counterPrice === "string"
      ? Number(counterPrice)
      : NaN;
    const price = Number.isFinite(rawPrice) ? Math.round(rawPrice * 100) / 100 : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        { action: "ERROR", message: "Ungültiger Betrag." },
        { status: 400 }
      );
    }

    const trustedDomain = shopDomain;

    const pricing = await getProductPricing(productId, variantId, trustedDomain);
    if (!pricing.availableForSale) {
      return NextResponse.json(
        { action: "ERROR", message: "Dieser Artikel ist leider ausverkauft." },
        { status: 400 }
      );
    }

    if (Math.abs(price - pricing.counterPrice) >= 0.01) {
      return NextResponse.json(
        { action: "ERROR", message: "Das Gegenangebot ist nicht mehr gültig." },
        { status: 400 }
      );
    }

    // bug 10: require a real pending COUNTER (atomically consumed so two
    // concurrent accepts can't mint two codes from one counter)
    const hasPending = await consumePendingCounter(customerId, productId, price);
    if (!hasPending) {
      return NextResponse.json(
        { action: "ERROR", message: "Kein aktives Gegenangebot vorhanden." },
        { status: 400 }
      );
    }

    // A counter at the listed price needs no discount code, but is still a
    // valid accepted counter and must consume the pending offer.
    if (price >= pricing.salePrice) {
      await refundOffer(customerId, productId);
      return NextResponse.json({
        action: "ACCEPT_NO_CODE",
        finalPrice: pricing.salePrice,
        expiresIn: 30 * 60,
        message: "Gegenangebot angenommen. Kaufen Sie direkt zum Sale-Preis.",
      });
    }

    // Generate discount code via centralized library
    let discount;
    try {
      discount = await createDiscountCode({
        productId,
        variantId,
        customerId,
        shopDomain: trustedDomain,
        salePrice: pricing.salePrice,
        finalPrice: price,
      });
    } catch (e) {
      console.error("[Archive54] Counter accept discount failed:", e);
      // ponytail: pending counter was already consumed — restore it so retry works
      await setPendingCounter(customerId, productId, price);
      throw e;
    }

    if (!discount) {
      await setPendingCounter(customerId, productId, price);
      return NextResponse.json(
        { action: "ERROR", message: "Rabattcode konnte nicht erstellt werden." },
        { status: 500 }
      );
    }

    // Refund quota (Accepting a counter is free)
    await refundOffer(customerId, productId);

    return NextResponse.json({
      action: "ACCEPT",
      discountCode: discount.code,
      expiresIn: discount.expiresIn,
      finalPrice: price,
      message: `Super! Ihr Preis: ${price.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}. Rabattcode: ${discount.code}. Gültig für 30 Minuten.`,
    });
  } catch (error) {
    console.error("[Archive54] Counter accept error:", error);
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
      { action: "ERROR", message: "Ein interner Fehler ist aufgetreten." },
      { status: 500 }
    );
  }
}

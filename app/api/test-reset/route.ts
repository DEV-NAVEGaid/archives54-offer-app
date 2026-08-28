import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId");
    const secret = searchParams.get("secret");

    if (!secret || secret !== process.env.SHOPIFY_API_SECRET) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!customerId) {
      return NextResponse.json({ error: "customerId required" }, { status: 400 });
    }

    const today = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })
      .split("T")[0];

    // Delete all rate limit keys for this customer today
    const dailyKey = `rate:${customerId}:${today}`;
    const keysToDelete = [dailyKey];

    // Find and delete product-specific keys
    // Scan for rate:{customerId}:{today}:prod:*
    const pattern = `rate:${customerId}:${today}:prod:*`;
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(result[0]);
      if (result[1]) {
        for (const key of result[1]) {
          keysToDelete.push(key);
        }
      }
    } while (cursor !== 0);

    // Delete all found keys
    for (const key of keysToDelete) {
      await redis.del(key);
    }

    // Also delete widget state keys
    const statePattern = `widget_state:${customerId}:*`;
    cursor = 0;
    do {
      const result = await redis.scan(cursor, { match: statePattern, count: 100 });
      cursor = Number(result[0]);
      if (result[1]) {
        for (const key of result[1]) {
          await redis.del(key);
        }
      }
    } while (cursor !== 0);

    // Also clear all pricing cache keys
    const pricingPattern = 'pricing:*';
    cursor = 0;
    do {
      const result = await redis.scan(cursor, { match: pricingPattern, count: 100 });
      cursor = Number(result[0]);
      if (result[1]) {
        for (const key of result[1]) {
          await redis.del(key);
          keysToDelete.push(key);
        }
      }
    } while (cursor !== 0);

    return NextResponse.json({
      ok: true,
      message: `Rate limits + widget state + pricing cache reset for customer ${customerId}`,
      deletedKeys: keysToDelete,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}

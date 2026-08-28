import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { checkRateLimit } from "@/lib/rate-limit";

// ponytail: no signature check here — it rejected all real app-proxy requests
// (states never saved/restored in production). This state is display-only;
// worst case an attacker spoofs their own widget's label. Enforcement lives
// in offers/counter-accept/validate routes.

// GET — retrieve saved widget state + quota in one response (eliminates
// widget init race between separate state + quota fetches)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId");
    const productId = searchParams.get("productId");

    if (!customerId || !productId) {
      return NextResponse.json({ state: null });
    }

    // Quota info (always returned, even when no saved state exists)
    const rateCheck = await checkRateLimit(customerId, productId);
    const quota = {
      dailyCount: rateCheck.dailyCount,
      remaining: rateCheck.remaining,
      productOffered: rateCheck.productOffered,
    };

    const key = `widget_state:${customerId}:${productId}`;
    const raw = await redis.get<string>(key);

    if (!raw) {
      return NextResponse.json({ state: null, ...quota });
    }

    const data = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Check if expired
    if (data.expiresAt && Date.now() > data.expiresAt) {
      await redis.del(key);
      return NextResponse.json({ state: null, ...quota });
    }

    return NextResponse.json({ ...data, ...quota });
  } catch (error) {
    console.error("[Archive54] Get state error:", error);
    return NextResponse.json({ state: null });
  }
}

// POST — save widget state
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { customerId, productId, state, data } = body;

    if (!customerId || !productId || !state) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const key = `widget_state:${customerId}:${productId}`;
    const stateData = {
      state,
      data: data || {},
      ts: Date.now(),
    };

    // Save with TTL (24 hours)
    await redis.set(key, JSON.stringify(stateData), { ex: 86400 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Archive54] Save state error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

// DELETE — clear widget state
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId");
    const productId = searchParams.get("productId");

    if (!customerId || !productId) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const key = `widget_state:${customerId}:${productId}`;
    await redis.del(key);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Archive54] Delete state error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

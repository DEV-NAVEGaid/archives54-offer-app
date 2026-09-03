import { redis, withRedis } from "./redis";

const MAX_OFFERS_PER_DAY = 4;
const MAX_OFFERS_PER_PRODUCT = 1;

function getTodayKey(): string {
  // Use Berlin timezone for daily reset
  return new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })
    .split("T")[0];
}

// instant — the old toLocaleString-parse ran through the server's local tz
function getBerlinOffsetMs(t: number): number {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(t);
  // sv-SE yields "YYYY-MM-DD HH:mm:ss"; parse it as UTC to diff against epoch
  return Date.parse(s.replace(" ", "T") + "Z") - t;
}

function getTTLUntilMidnight(): number {
  const now = Date.now();
  const [y, m, d] = getTodayKey().split("-").map(Number);
  const nextUtcMidnight = Date.UTC(y, m - 1, d + 1);
  const berlinMidnight = nextUtcMidnight - getBerlinOffsetMs(nextUtcMidnight);
  return Math.max(1, Math.floor((berlinMidnight - now) / 1000));
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  dailyCount: number;
  productOffered: boolean;
  remaining: number;
}

export async function checkRateLimit(
  customerId: string,
  productId: string
): Promise<RateLimitResult> {
  const today = getTodayKey();

  // Check per-product limit
  const productKey = `rate:${customerId}:${today}:prod:${productId}`;
  const productOffered = (await redis.exists(productKey)) === 1;

  if (productOffered) {
    const dailyKey = `rate:${customerId}:${today}`;
    const dailyCount = ((await redis.get<number>(dailyKey)) || 0);
    return {
      allowed: false,
      reason: "Sie haben bereits ein Angebot für dieses Produkt abgegeben.",
      dailyCount,
      productOffered: true,
      remaining: Math.max(0, MAX_OFFERS_PER_DAY - dailyCount),
    };
  }

  // Check daily limit
  const dailyKey = `rate:${customerId}:${today}`;
  const dailyCount = (await redis.get<number>(dailyKey)) || 0;

  if (dailyCount >= MAX_OFFERS_PER_DAY) {
    return {
      allowed: false,
      reason:
        "Heute sind leider keine weiteren Angebote mehr möglich. Versuchen Sie es morgen wieder!",
      dailyCount,
      productOffered: false,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    dailyCount,
    productOffered: false,
    remaining: MAX_OFFERS_PER_DAY - dailyCount,
  };
}

export interface ReserveResult {
  reserved: boolean;
  reason?: string;
  dailyCount: number;
  remaining: number;
}

// window like checkRateLimit→recordOffer); daily limit uses incr-then-decr on
// overshoot which self-heals under concurrency
export async function reserveOffer(
  customerId: string,
  productId: string
): Promise<ReserveResult> {
  return withRedis(async () => {
    const today = getTodayKey();
    const ttl = getTTLUntilMidnight();

    // 1. Per-product: atomic SET with NX — fails if key already exists
    const productKey = `rate:${customerId}:${today}:prod:${productId}`;
    const productSet = await redis.set(productKey, 1, { ex: ttl, nx: true });
    if (productSet === null) {
      const dailyCount = (await redis.get<number>(`rate:${customerId}:${today}`)) || 0;
      return {
        reserved: false,
        reason: "Sie haben bereits ein Angebot für dieses Produkt abgegeben.",
        dailyCount,
        remaining: Math.max(0, MAX_OFFERS_PER_DAY - dailyCount),
      };
    }

    // 2. Daily: incr + expire in one pipeline
    const dailyKey = `rate:${customerId}:${today}`;
    const [count] = await redis
      .pipeline()
      .incr(dailyKey)
      .expire(dailyKey, ttl)
      .exec<[number, number]>();

    if (count > MAX_OFFERS_PER_DAY) {
      // Overshoot from a concurrent request — undo both reservations
      await redis.decr(dailyKey);
      await redis.del(productKey);
      return {
        reserved: false,
        reason:
          "Heute sind leider keine weiteren Angebote mehr möglich. Versuchen Sie es morgen wieder!",
        dailyCount: count - 1,
        remaining: 0,
      };
    }

    return {
      reserved: true,
      dailyCount: count,
      remaining: MAX_OFFERS_PER_DAY - count,
    };
  });
}

export async function getDailyUsage(
  customerId: string
): Promise<{ used: number; remaining: number }> {
  return withRedis(async () => {
    const today = getTodayKey();
    const dailyKey = `rate:${customerId}:${today}`;
    const used = (await redis.get<number>(dailyKey)) || 0;

    return {
      used,
      remaining: MAX_OFFERS_PER_DAY - used,
    };
  });
}

export async function refundOffer(
  customerId: string,
  productId: string,
  releaseProduct = false
): Promise<void> {
  try {
    const today = getTodayKey();

    const dailyKey = `rate:${customerId}:${today}`;
    const count = await redis.get<number>(dailyKey);
    if (count && count > 0) {
      await redis.decr(dailyKey);
    }

    // ponytail: releaseProduct=true also deletes the productKey — used when the
    // offer never actually happened (OOS). Default false keeps it blocked so
    // customers can't farm discount codes for the same product.
    if (releaseProduct) {
      await redis.del(`rate:${customerId}:${today}:prod:${productId}`);
    }

    // We DO NOT delete the productKey here by default.
    // Although the counter is 'free' (refunds daily limit),
    // we still want to enforce 'Max 1 offer/product/customer/day'
    // so they can't farm discount codes for the same product!
  } catch (e) {
    console.error("[Archive54] refundOffer failed (ignored):", e);
  }
}

// --- Pending counter offer (bug 10: counter-accept must require a real COUNTER) ---
// Stored when COUNTER is returned; consumed with a matched GETDEL on accept so
// concurrent accept calls can't mint two codes from one counter.

export async function setPendingCounter(
  customerId: string,
  productId: string,
  counterPrice: number
): Promise<boolean> {
  try {
    await redis.set(
      `counter:${customerId}:${productId}`,
      JSON.stringify({ counterPrice, expiresAt: Date.now() + 30 * 60 * 1000 }),
      { ex: 1800 }
    );
    return true;
  } catch (e) {
    console.error("[Archive54] setPendingCounter failed:", e);
    return false;
  }
}

// The final GETDEL is atomic, so two concurrent counter-accept calls cannot
// both consume the pending counter. Returns true only if a pending counter
// exists AND its price matches. A
// mismatched request must not consume the valid counter.
export async function consumePendingCounter(
  customerId: string,
  productId: string,
  counterPrice: number
): Promise<boolean> {
  return withRedis(async () => {
    const key = `counter:${customerId}:${productId}`;
    const raw = await redis.get<string>(key);
    if (!raw) return false;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (data.expiresAt && Date.now() > data.expiresAt) return false;
    if (Math.abs(counterPrice - data.counterPrice) >= 0.01) return false;
    return (await redis.getdel<string>(key)) !== null;
  });
}

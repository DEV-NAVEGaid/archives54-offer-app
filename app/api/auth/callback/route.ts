import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

// Verify Shopify OAuth callback HMAC: sort params (minus hmac) as key=value,
// HMAC-SHA256 with the app secret, timing-safe compare.
function verifyShopifyHmac(searchParams: URLSearchParams, secret: string): boolean {
  const hmac = searchParams.get("hmac");
  if (!hmac) return false;
  const params: string[] = [];
  for (const [k, v] of searchParams.entries()) {
    if (k !== "hmac") params.push(`${k}=${v}`);
  }
  params.sort();
  const message = params.join("&");
  const computed = createHmac("sha256", secret).update(message).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(hmac));
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");

  if (!code || !shop) {
    return NextResponse.json({ error: "Missing code or shop parameter" }, { status: 400 });
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in .env" }, { status: 500 });
  }

  // bug 9/12: reject forged callbacks without a valid Shopify HMAC
  if (!verifyShopifyHmac(searchParams, clientSecret)) {
    return NextResponse.json({ error: "Invalid HMAC — request not from Shopify." }, { status: 403 });
  }

  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Shopify returned ${res.status}: ${errorText}`);
    }

    const data = await res.json();

    // bug 12: never render the token in the browser — log to server only.
    // Copy it from the server logs (or Vercel runtime logs) into .env.
    console.log("[Archive54] OAuth success — SHOPIFY_ACCESS_TOKEN:", data.access_token);

    return new NextResponse(
      `<html><body style="font-family: sans-serif; padding: 40px;">
        <h1 style="color: #2c6e49;">Installation erfolgreich!</h1>
        <p>Das Zugriffstoken wurde im <b>Server-Log</b> protokolliert.</p>
        <p>Kopieren Sie es von dort und tragen Sie es in <b>.env</b> als <b>SHOPIFY_ACCESS_TOKEN</b> ein.</p>
        <p style="margin-top: 20px; color: #666;"><i>Aus Sicherheitsgründen wird das Token nicht im Browser angezeigt.</i></p>
      </body></html>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }
    );
  } catch (error) {
    console.error("Failed to exchange token:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to exchange token" }, { status: 500 });
  }
}

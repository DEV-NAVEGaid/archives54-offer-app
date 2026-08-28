import { NextRequest, NextResponse } from "next/server";
import { validateDiscountCode, markDiscountUsed } from "@/lib/discount";

// POST /api/discount/validate — validate a discount code
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { code, shopDomain } = body;

    if (!code || !shopDomain) {
      return NextResponse.json(
        { valid: false, message: "Code und Shop-Domain erforderlich." },
        { status: 400 }
      );
    }

    const result = await validateDiscountCode(code, shopDomain);
    if (result.valid) {
      await markDiscountUsed(code);
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Archive54] Validate error:", error);
    return NextResponse.json(
      { valid: false, message: "Fehler bei der Validierung." },
      { status: 500 }
    );
  }
}

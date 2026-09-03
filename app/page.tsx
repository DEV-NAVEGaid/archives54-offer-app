export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="w-full max-w-3xl px-6 py-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
          Archive 54
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Offer App — Rules &amp; Guide
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Price negotiation widget for Shopify. Rule-based, no manual approval.
        </p>

        <h2 className="mt-12 text-xl font-semibold text-black dark:text-zinc-50">
          1. Pricing Rules
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-zinc-700 dark:text-zinc-300">
          <li>
            <strong>Sale price</strong> = 54% off UVP, where UVP is the
            Shopify compare-at price. The negotiation floor is 60% off UVP;
            the counter is the midpoint between the sale price and floor.
          </li>
          <li>
            The variant metafield <code>archive54.min_price</code> can override
            the default floor when a valid value is configured.
          </li>
          <li>
            Prices are always verified server-side via the Shopify Admin API.
            Frontend prices are never trusted.
          </li>
        </ul>

        <h2 className="mt-12 text-xl font-semibold text-black dark:text-zinc-50">
          2. Offer Flow
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-zinc-700 dark:text-zinc-300">
          <li>
            <strong>Offer ≥ floor price</strong> → ACCEPT, discount code is
            generated immediately.
          </li>
          <li>
            <strong>Offer ≥ 85% of floor but below floor</strong> → COUNTER at
            the midpoint. Customer can accept or decline.
          </li>
          <li>
            <strong>Offer below the counter trigger</strong> → DECLINE.
          </li>
          <li>
            <strong>Offer ≥ sale price</strong> → buy at sale price, no code
            needed.
          </li>
        </ul>

        <h2 className="mt-12 text-xl font-semibold text-black dark:text-zinc-50">
          3. Discount Codes
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-zinc-700 dark:text-zinc-300">
          <li>
            Format{" "}
            <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/[.08]">
              ARCH54-XXXXXX
            </code>
            , fixed amount = sale price − agreed price.
          </li>
          <li>Valid 30 minutes, one usage, one customer, one product.</li>
          <li>
            Enforced by Shopify (expiry + usage limit); Redis only caches the
            server-side check.
          </li>
        </ul>

        <h2 className="mt-12 text-xl font-semibold text-black dark:text-zinc-50">
          4. Quota Rules
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-zinc-700 dark:text-zinc-300">
          <li>Max 4 offers per customer per day.</li>
          <li>1 offer per product per day (after submit: &quot;Bereits angefragt&quot;).</li>
          <li>Quota resets at midnight Berlin time.</li>
          <li>Accepting a counter-offer refunds the used quota slot.</li>
          <li>A pending counter expires after 30 minutes.</li>
        </ul>
      </main>
    </div>
  );
}

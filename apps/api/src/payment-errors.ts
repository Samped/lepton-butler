/** Strip emoji and noisy CLI decoration from user-facing payment errors. */
export function sanitizeCliMessage(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1F9FF}\u2600-\u27BF\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map Circle CLI / x402 failures to short, actionable copy (no emoji). */
export function formatPaymentError(raw: string): string {
  const text = sanitizeCliMessage(raw);

  if (/insufficient gateway balance/i.test(text)) {
    return "Insufficient Gateway USDC. Fund your payer wallet at faucet.circle.com (Arc testnet), then deposit to Gateway before running workflows.";
  }
  if (/could not reach the endpoint|failed during initial request|domexception.*aborted|operation was aborted due to timeout/i.test(text)) {
    return "Payment endpoint timed out. Confirm the API is running (npm run dev:api) and your network can reach Circle Gateway.";
  }
  if (/payment submitted but request failed/i.test(text)) {
    const server = text.match(/Server response:\s*([^\n]+)/i)?.[1]?.trim();
    if (server) {
      if (/agent disabled/i.test(server)) {
        return "Audit/bill agent blocked by policy (broker role disabled). Update Policy to enable bills agent, then retry.";
      }
      return `Payment settled but the agent service rejected the request: ${server}`;
    }
    return "Agent payment succeeded but the service returned an error. Retry once, or check API logs if it persists.";
  }
  if (/configure circle login|payer address not set|payer not configured/i.test(text)) {
    return "Payer wallet not configured. Log in via Payer and select an agent wallet.";
  }
  if (/no supported payment method|missing payment-required header|no payment options in 402/i.test(text)) {
    return "Agent paywall was misconfigured (invalid x402 402). Restart the API after deploy so execute routes use Circle Gateway middleware.";
  }

  const first =
    text
      .split(/Common causes:|Technical details:|Payment details saved/i)[0]
      ?.split("\n")
      .map((l) => l.replace(/^Error:\s*/i, "").trim())
      .find((l) => l.length > 0) ?? text;

  const clean = sanitizeCliMessage(first);
  if (clean.length > 200) return `${clean.slice(0, 197)}...`;
  return clean || "Payment failed";
}

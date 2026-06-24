/** Strip emoji from API / CLI errors shown in the dashboard. */
export function sanitizeUserMessage(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1F9FF}\u2600-\u27BF\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatWorkflowError(raw: string): string {
  const text = sanitizeUserMessage(raw);
  if (/insufficient gateway balance/i.test(text)) {
    return "Insufficient Gateway USDC. Fund your payer wallet at faucet.circle.com (Arc testnet), then deposit to Gateway.";
  }
  if (/cannot read properties of undefined \(reading 'ok'\)/i.test(text)) {
    return "Settlement response was incomplete. Retry the task; if it persists, restart the API (npm run dev) and confirm Circle payer is logged in.";
  }
  if (/payment endpoint timed out|gateway payment returned no result/i.test(text)) {
    return "A workflow step timed out. Retry once and keep the tab open — full theses target ~1 minute.";
  }
  if (/invalid response from|unexpected response from/i.test(text)) {
    if (/\/api\/(health|policy|ledger|agent\/status)/i.test(text)) {
      return "API is busy with a Butler run — this is normal. Check Library for your deliverable; the dashboard will refresh when the run finishes.";
    }
    return "Lost connection to the API during the Butler run. Check Library — the job may still finish in the background.";
  }
  if (/request timed out/i.test(text)) {
    if (/\/api\/(health|policy)/i.test(text)) {
      return "API is busy with a Butler run — health check timed out. Your task may still complete in Library.";
    }
    if (/butler|payer-agent/i.test(text)) {
      return "Butler is still processing (auctions + x402 can take 3–5 minutes). Check Library in a moment — your deliverable may already be there.";
    }
  }
  if (/signal is aborted/i.test(text)) {
    return "Request was cancelled or timed out. Keep this tab open while Butler runs (auctions can take 1–3 minutes).";
  }
  if (/OPENAI_API_KEY|openai api|agent intelligence/i.test(text)) {
    return "A specialist agent is not configured on this server. Contact your operator to enable research and report services.";
  }
  const short = text.split(/Common causes:|Technical details:/i)[0]?.trim() ?? text;
  return short.length > 220 ? `${short.slice(0, 217)}...` : short;
}

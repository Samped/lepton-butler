export interface X402ProbeResult {
  ok: boolean;
  priceUsdc?: string;
  network?: string;
  description?: string;
  x402Version?: number;
  error?: string;
  probedAt: number;
}

const USDC_DECIMALS = 6;

function microToUsdc(micro: string | number): string {
  const n = typeof micro === "string" ? BigInt(micro) : BigInt(Math.round(micro));
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

function parsePaymentRequiredHeader(header: string | null): Record<string, unknown> | null {
  if (!header?.trim()) return null;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(header) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function priceFromAccepts(accepts: unknown[]): { priceUsdc?: string; network?: string } {
  for (const item of accepts) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const network = typeof row.network === "string" ? row.network : undefined;
    const max =
      row.maxAmountRequired ??
      row.amountRequired ??
      row.maxAmount ??
      row.amount ??
      (row.extra && typeof row.extra === "object"
        ? (row.extra as Record<string, unknown>).maxAmountRequired
        : undefined);
    if (max != null) {
      const priceUsdc = microToUsdc(String(max));
      return { priceUsdc, network };
    }
    if (typeof row.price === "string" && row.price.startsWith("$")) {
      return { priceUsdc: row.price.slice(1), network };
    }
  }
  return {};
}

/** Probe an x402 endpoint without paying — parses HTTP 402 + PAYMENT-REQUIRED. */
export async function probeX402Url(url: string, timeoutMs = 15_000): Promise<X402ProbeResult> {
  const probedAt = Math.floor(Date.now() / 1000);
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "URL must be http(s)", probedAt };
    }
  } catch {
    return { ok: false, error: "Invalid URL", probedAt };
  }

  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    if (res.status === 402) {
      const paymentHeader = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const fromHeader = paymentHeader ? parsePaymentRequiredHeader(paymentHeader) : null;
      const payload = fromHeader ?? body;
      const accepts = Array.isArray(payload?.accepts) ? payload.accepts : [];
      const { priceUsdc, network } = priceFromAccepts(accepts);
      const resource =
        payload?.resource && typeof payload.resource === "object"
          ? (payload.resource as Record<string, unknown>)
          : null;
      const description = typeof resource?.description === "string" ? resource.description : undefined;
      const x402Version = typeof payload?.x402Version === "number" ? payload.x402Version : 2;

      if (!priceUsdc) {
        return { ok: false, error: "402 response missing price in accepts[]", probedAt };
      }

      return {
        ok: true,
        priceUsdc,
        network,
        description,
        x402Version,
        probedAt,
      };
    }

    if (res.ok) {
      return {
        ok: false,
        error: `Endpoint returned ${res.status} without x402 paywall`,
        probedAt,
      };
    }

    return { ok: false, error: `HTTP ${res.status}`, probedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Probe failed";
    return { ok: false, error: message, probedAt };
  }
}

export function appendBriefToServiceUrl(url: string, brief?: string): string {
  return appendServiceUrlParams(url, { brief });
}

export function appendServiceUrlParams(
  url: string,
  opts?: {
    brief?: string;
    initiator?: "user" | "system" | "cli";
    context?: string;
    contextId?: string;
    briefContextId?: string;
  }
): string {
  const u = new URL(url);
  if (opts?.brief?.trim()) u.searchParams.set("brief", opts.brief.trim());
  if (opts?.initiator) u.searchParams.set("butler_initiator", opts.initiator);
  if (opts?.briefContextId?.trim()) u.searchParams.set("briefContextId", opts.briefContextId.trim());
  if (opts?.contextId?.trim()) u.searchParams.set("contextId", opts.contextId.trim());
  else if (opts?.context?.trim()) u.searchParams.set("context", opts.context.trim().slice(0, 2000));
  return u.toString();
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferCategoryFromCapabilities,
  isAgentApproved,
  registerExternalAgents,
  registerEphemeralAgents,
  slugFromUrl,
  type RegistryAgent,
} from "@butler/core";
import { probeX402Url } from "./x402-probe.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DEFAULT_REGISTRY_PATH = resolve(ROOT, ".data/external-agents.json");
const SEED_REGISTRY_PATH = resolve(ROOT, "config/external-agents.seed.json");

export interface ExternalAgentPolicy {
  domainAllowlist: string[];
  maxPriceUsdc: number;
  baselineReputation: number;
  openDiscovery: boolean;
  requireX402Verified: boolean;
}

export interface RegistryFileEntry {
  id?: string;
  name: string;
  tagline?: string;
  category?: RegistryAgent["category"];
  serviceUrl: string;
  priceUsdc?: string;
  etaSeconds?: number;
  capabilities?: string[];
  enabled?: boolean;
  maxPriceUsdc?: string;
}

function parsePolicy(): ExternalAgentPolicy {
  const allowRaw = process.env.BUTLER_EXTERNAL_DOMAINS_ALLOWLIST?.trim();
  const domainAllowlist = allowRaw
    ? allowRaw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    domainAllowlist,
    maxPriceUsdc: Number(process.env.BUTLER_EXTERNAL_MAX_PRICE_USDC ?? "0.25") || 0.25,
    baselineReputation: Number(process.env.BUTLER_EXTERNAL_BASELINE_REPUTATION ?? "72") || 72,
    openDiscovery: process.env.BUTLER_OPEN_DISCOVERY !== "false",
    requireX402Verified: process.env.BUTLER_EXTERNAL_REQUIRE_X402 !== "false",
  };
}

export function getExternalAgentPolicy(): ExternalAgentPolicy {
  return parsePolicy();
}

export function isDomainAllowed(hostname: string, policy = parsePolicy()): boolean {
  const host = hostname.toLowerCase();
  if (policy.domainAllowlist.length === 0) return true;
  return policy.domainAllowlist.some(
    (d) => host === d || host.endsWith(`.${d}`)
  );
}

export function isPriceAllowed(priceUsdc: string, policy = parsePolicy()): boolean {
  return Number(priceUsdc) <= policy.maxPriceUsdc + 1e-9;
}

export function validateExternalAgent(agent: RegistryAgent, policy = parsePolicy()): string | null {
  if (!isAgentApproved(agent.id)) {
    return "Agent is not approved — approve it in Auctions → Agent network before payment";
  }
  if (!agent.serviceUrl?.startsWith("http")) return "serviceUrl must be absolute http(s) URL";
  let hostname: string;
  try {
    hostname = new URL(agent.serviceUrl).hostname;
  } catch {
    return "Invalid serviceUrl";
  }
  if (!isDomainAllowed(hostname, policy)) {
    return `Domain ${hostname} not in allowlist (set BUTLER_EXTERNAL_DOMAINS_ALLOWLIST)`;
  }
  if (!isPriceAllowed(agent.priceUsdc, policy)) {
    return `Price $${agent.priceUsdc} exceeds max $${policy.maxPriceUsdc}`;
  }
  if (policy.requireX402Verified && !agent.x402Verified) {
    return "Agent must pass x402 probe before payment";
  }
  return null;
}

function entryToAgent(entry: RegistryFileEntry, probe?: { priceUsdc?: string; network?: string }): RegistryAgent {
  let domain: string | undefined;
  try {
    domain = new URL(entry.serviceUrl).hostname;
  } catch {
    domain = undefined;
  }
  const id = entry.id ?? `ext-${slugFromUrl(entry.serviceUrl)}`;
  const capabilities = entry.capabilities ?? [];
  return {
    id,
    name: entry.name,
    tagline: entry.tagline ?? "External x402 agent on the open internet",
    category: entry.category ?? inferCategoryFromCapabilities(capabilities),
    servicePath: "",
    serviceUrl: entry.serviceUrl,
    priceUsdc: probe?.priceUsdc ?? entry.priceUsdc ?? "0.01",
    etaSeconds: entry.etaSeconds ?? 30,
    merchantId: `external:${id}`,
    policyAgent: "research",
    capabilities,
    origin: "external",
    domain,
    enabled: entry.enabled !== false,
    maxPriceUsdc: entry.maxPriceUsdc,
    x402Verified: true,
    probedAt: probe ? Math.floor(Date.now() / 1000) : undefined,
    network: probe?.network,
  };
}

function loadRegistryFile(path: string): RegistryFileEntry[] {
  if (!existsSync(path)) {
    if (existsSync(SEED_REGISTRY_PATH)) {
      try {
        const seed = JSON.parse(readFileSync(SEED_REGISTRY_PATH, "utf8"));
        const entries = Array.isArray(seed) ? (seed as RegistryFileEntry[]) : [];
        if (entries.length > 0) {
          saveRegistryFile(path, entries);
          return entries;
        }
      } catch {
        /* ignore bad seed */
      }
    }
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as RegistryFileEntry[]) : [];
  } catch {
    return [];
  }
}

function saveRegistryFile(path: string, entries: RegistryFileEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

export function loadExternalAgentRegistry(opts?: {
  registryPath?: string;
  probeOnLoad?: boolean;
}): { agents: RegistryAgent[]; policy: ExternalAgentPolicy } {
  const policy = parsePolicy();
  const registryPath = opts?.registryPath ?? DEFAULT_REGISTRY_PATH;
  const entries = loadRegistryFile(registryPath);
  const envUrls = (process.env.BUTLER_EXTERNAL_AGENT_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const merged: RegistryFileEntry[] = [...entries];
  for (const url of envUrls) {
    if (!merged.some((e) => e.serviceUrl === url)) {
      merged.push({
        name: `Discovered ${slugFromUrl(url)}`,
        serviceUrl: url,
        capabilities: ["x402"],
      });
    }
  }

  const agents: RegistryAgent[] = [];
  for (const entry of merged) {
    const agent = entryToAgent(entry);
    const err = validateExternalAgent({ ...agent, x402Verified: true }, { ...policy, requireX402Verified: false });
    if (err && policy.domainAllowlist.length > 0) continue;
    agents.push(agent);
  }

  registerExternalAgents(agents);
  return { agents, policy };
}

export async function probeAndRegisterUrl(
  url: string,
  opts?: { name?: string; category?: RegistryAgent["category"]; save?: boolean; registryPath?: string }
): Promise<{ agent: RegistryAgent | null; probe: Awaited<ReturnType<typeof probeX402Url>>; error?: string }> {
  const policy = parsePolicy();
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { agent: null, probe: { ok: false, error: "Invalid URL", probedAt: Math.floor(Date.now() / 1000) }, error: "Invalid URL" };
  }
  if (!isDomainAllowed(hostname, policy)) {
    return {
      agent: null,
      probe: { ok: false, error: "Domain not allowlisted", probedAt: Math.floor(Date.now() / 1000) },
      error: `Domain ${hostname} not in allowlist`,
    };
  }

  const probe = await probeX402Url(url);
  if (!probe.ok || !probe.priceUsdc) {
    return { agent: null, probe, error: probe.error ?? "x402 probe failed" };
  }
  if (!isPriceAllowed(probe.priceUsdc, policy)) {
    return {
      agent: null,
      probe,
      error: `Price $${probe.priceUsdc} exceeds max $${policy.maxPriceUsdc}`,
    };
  }

  const entry: RegistryFileEntry = {
    id: `ext-${slugFromUrl(url)}`,
    name: opts?.name ?? probe.description ?? `Agent @ ${hostname}`,
    tagline: probe.description ?? "Verified x402 agent",
    category: opts?.category,
    serviceUrl: url,
    priceUsdc: probe.priceUsdc,
    capabilities: ["x402"],
    enabled: true,
  };
  const agent = entryToAgent(entry, { priceUsdc: probe.priceUsdc, network: probe.network });
  agent.x402Verified = true;
  agent.probedAt = probe.probedAt;

  if (opts?.save !== false) {
    const registryPath = opts?.registryPath ?? DEFAULT_REGISTRY_PATH;
    const entries = loadRegistryFile(registryPath);
    const idx = entries.findIndex((e) => e.serviceUrl === url);
    const row: RegistryFileEntry = {
      id: agent.id,
      name: agent.name,
      tagline: agent.tagline,
      category: agent.category,
      serviceUrl: url,
      priceUsdc: agent.priceUsdc,
      etaSeconds: agent.etaSeconds,
      capabilities: agent.capabilities,
      enabled: true,
    };
    if (idx >= 0) entries[idx] = row;
    else entries.push(row);
    saveRegistryFile(registryPath, entries);
    const { agents } = loadExternalAgentRegistry({ registryPath, probeOnLoad: false });
    registerExternalAgents(agents);
  }

  return { agent, probe };
}

export async function discoverOpenAgents(
  urls: string[],
  opts?: { ephemeral?: boolean }
): Promise<RegistryAgent[]> {
  const policy = parsePolicy();
  if (!policy.openDiscovery) return [];

  const discovered: RegistryAgent[] = [];
  for (const url of urls) {
    const { agent, error } = await probeAndRegisterUrl(url, { save: false });
    if (agent && !error) discovered.push(agent);
  }

  if (opts?.ephemeral && discovered.length > 0) {
    const approved = discovered.filter((a) => isAgentApproved(a.id));
    if (approved.length > 0) registerEphemeralAgents(approved);
  }

  return discovered.filter((a) => isAgentApproved(a.id));
}

export function agentToRegistryEntry(agent: RegistryAgent): RegistryFileEntry {
  return {
    id: agent.id,
    name: agent.name,
    tagline: agent.tagline,
    category: agent.category,
    serviceUrl: agent.serviceUrl!,
    priceUsdc: agent.priceUsdc,
    etaSeconds: agent.etaSeconds,
    capabilities: agent.capabilities,
    enabled: agent.enabled !== false,
    maxPriceUsdc: agent.maxPriceUsdc,
  };
}

export function removeExternalAgent(serviceUrl: string, registryPath = DEFAULT_REGISTRY_PATH): boolean {
  const entries = loadRegistryFile(registryPath).filter((e) => e.serviceUrl !== serviceUrl);
  if (entries.length === loadRegistryFile(registryPath).length) return false;
  saveRegistryFile(registryPath, entries);
  loadExternalAgentRegistry({ registryPath });
  return true;
}

export function getRegistryPath(): string {
  return process.env.BUTLER_EXTERNAL_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

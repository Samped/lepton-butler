import { useCallback, useEffect, useState } from "react";
import {
  formatUsdc,
  getAgentStatus,
  getHealth,
  getLedger,
  getPolicy,
  resetPolicy,
  runMarketplaceWorkflow as apiRunMarketplaceWorkflow,
  shortAddr,
  toggleAgent,
  toggleMerchant,
  type AgentStatus,
  type Health,
  type Policy,
  type SpendRecord,
} from "./api.ts";
import {
  AgentIcon,
  BudgetRing,
  EmptyState,
  MetricChip,
  Panel,
  StatusDot,
  Toggle,
} from "./components.tsx";
import {
  IconActivity,
  IconAgent,
  IconLibrary,
  IconMarketplace,
  IconPolicy,
  IconRefresh,
  IconTrace,
} from "./icons.tsx";
import { PaymentTrace } from "./trace/PaymentTrace.tsx";
import { StackStatusPanel } from "./trace/StackStatus.tsx";
import { MarketplaceView } from "./marketplace/MarketplaceView.tsx";
import { AgentChatView } from "./agent/AgentChatView.tsx";
import { DeliverablesView } from "./deliverables/DeliverablesView.tsx";
import { CircleLoginPanel } from "./circle/CircleLoginPanel.tsx";
import { formatWorkflowError } from "./format.ts";

type Tab = "agent" | "library" | "marketplace" | "policy" | "activity" | "trace";
type ActivityScope = "all" | "mine";

const SERVICE_LABELS: Record<string, string> = {
  "research-summary": "News / summary",
  "research-papers": "Research agent",
  "price-feed": "Market / price feed",
  "utility-quote": "Report / bill agent",
  "subscription-check": "Subscription agent",
};

const NAV: { id: Tab; label: string; Icon: typeof IconMarketplace }[] = [
  { id: "agent", label: "Agent", Icon: IconAgent },
  { id: "library", label: "Library", Icon: IconLibrary },
  { id: "marketplace", label: "Auctions", Icon: IconMarketplace },
  { id: "policy", label: "Policy", Icon: IconPolicy },
  { id: "activity", label: "Activity", Icon: IconActivity },
  { id: "trace", label: "Trace", Icon: IconTrace },
];

export function App() {
  const [tab, setTab] = useState<Tab>("agent");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [ledger, setLedger] = useState<SpendRecord[]>([]);
  const [remaining, setRemaining] = useState("0");
  const [health, setHealth] = useState<Health | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [traceSettlementId, setTraceSettlementId] = useState("");
  const [libraryJobId, setLibraryJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityScope, setActivityScope] = useState<ActivityScope>("all");
  const [activityRecords, setActivityRecords] = useState<SpendRecord[]>([]);
  const [ledgerTotalCount, setLedgerTotalCount] = useState(0);
  const [activityPayerAddresses, setActivityPayerAddresses] = useState<string[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [butlerBusy, setButlerBusy] = useState(false);

  const loadActivityLedger = useCallback(async (scope: ActivityScope) => {
    setActivityLoading(true);
    try {
      const [ledgerRes, statusRes] = await Promise.allSettled([getLedger(scope), getAgentStatus()]);
      if (ledgerRes.status === "fulfilled") {
        setActivityRecords(ledgerRes.value.records);
        setRemaining(ledgerRes.value.remainingDailyUsdc);
        setLedgerTotalCount(ledgerRes.value.totalCount ?? ledgerRes.value.records.length);
        if (ledgerRes.value.activityPayerAddresses?.length) {
          setActivityPayerAddresses(ledgerRes.value.activityPayerAddresses);
        }
        if (scope === "all") setLedger(ledgerRes.value.records);
      }
      if (statusRes.status === "fulfilled") {
        setAgentStatus(statusRes.value);
        if (statusRes.value.activityPayerAddresses?.length) {
          setActivityPayerAddresses(statusRes.value.activityPayerAddresses);
        }
      }
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    const failed: string[] = [];
    const pick = <T,>(r: PromiseSettledResult<T>, label: string): T | null => {
      if (r.status === "fulfilled") return r.value;
      if (!opts?.quiet) {
        failed.push(`${label}: ${formatWorkflowError(r.reason instanceof Error ? r.reason.message : "failed")}`);
      }
      return null;
    };

    const [h, p] = await Promise.allSettled([getHealth(), getPolicy()]);
    const healthRes = pick(h, "health");
    const policyRes = pick(p, "policy");

    if (healthRes) setHealth(healthRes);
    if (policyRes) setPolicy(policyRes);

    if (!healthRes && !policyRes) {
      if (!opts?.quiet) {
        setError(failed.join(" · ") || "Cannot reach API — run npm run dev:api");
      }
      setLoading(false);
      return;
    }

    if (!opts?.quiet) {
      setError(failed.length > 0 ? failed.join(" · ") : null);
    } else if (failed.length === 0) {
      setError(null);
    }
    setLoading(false);

    const [l, as] = await Promise.allSettled([getLedger(), getAgentStatus()]);
    const ledgerRes = pick(l, "ledger");
    if (ledgerRes) {
      setLedger(ledgerRes.records);
      setRemaining(ledgerRes.remainingDailyUsdc);
      setLedgerTotalCount(ledgerRes.totalCount ?? ledgerRes.records.length);
      if (ledgerRes.activityPayerAddresses?.length) {
        setActivityPayerAddresses(ledgerRes.activityPayerAddresses);
      }
    }
    const asRes = pick(as, "agent/status");
    if (asRes) {
      setAgentStatus(asRes);
      if (asRes.activityPayerAddresses?.length) setActivityPayerAddresses(asRes.activityPayerAddresses);
    }
    if (!opts?.quiet && failed.length > 0) setError(failed.join(" · "));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => void refresh({ quiet: butlerBusy }), 15_000);
    return () => clearInterval(id);
  }, [refresh, butlerBusy]);

  useEffect(() => {
    if (tab !== "activity") return;
    void loadActivityLedger(activityScope);
  }, [tab, activityScope, loadActivityLedger]);

  useEffect(() => {
    if (tab === "activity" && activityScope === "all") {
      setActivityRecords(ledger);
    }
  }, [ledger, tab, activityScope]);

  const handleRunWorkflow = async (etfId: string, brief?: string) => {
    if (agentStatus && !agentStatus.canRun) {
      setWorkflowMessage(agentStatus.reason ?? "Configure a Circle payer wallet first");
      return;
    }
    setWorkflowRunning(true);
    setWorkflowMessage(null);
    try {
      const result = await apiRunMarketplaceWorkflow(etfId, brief);
      const orch = result.orchestration as {
        steps?: { ok: boolean; error?: string }[];
        totalUsdc?: string;
        mode?: string;
      };
      const steps = (orch.steps ?? []).filter((s): s is { ok: boolean; error?: string } => !!s);
      const ok = steps.filter((s) => s.ok).length;
      const total = steps.length;
      const firstErr = steps.find((s) => !s.ok)?.error;
      if (ok === total && total > 0) {
        setWorkflowMessage(
          `Workflow complete: ${ok}/${total} agents paid, $${orch.totalUsdc ?? "?"} USDC (${orch.mode})`
        );
      } else {
        setWorkflowMessage(
          firstErr
            ? `Payment failed (${ok}/${total} paid): ${formatWorkflowError(firstErr)}`
            : `Workflow incomplete: ${ok}/${total} agents paid`
        );
      }
      await refresh();
    } catch (e) {
      setWorkflowMessage(e instanceof Error ? e.message : "Workflow failed");
    } finally {
      setWorkflowRunning(false);
    }
  };

  const merchantLabel = (merchantId: string) =>
    policy?.merchants.find((m) => m.id === merchantId)?.label ?? SERVICE_LABELS[merchantId] ?? merchantId;

  const primaryPayerLabel =
    agentStatus?.circleExecutorAddress ?? agentStatus?.executorAddress ?? activityPayerAddresses[0] ?? "";

  const canFilterMine =
    activityPayerAddresses.length > 0 ||
    !!agentStatus?.circleExecutorAddress ||
    !!agentStatus?.executorAddress ||
    !!agentStatus?.canRun;

  const activityCountLabel =
    activityScope === "mine"
      ? `${activityRecords.length} yours · ${ledgerTotalCount || ledger.length} total on Butler`
      : `${activityRecords.length} payments`;

  const live = health?.mode !== "dev";
  const dailyLimit = policy ? Number(policy.dailyLimitUsdc) : 0;
  const spentToday = dailyLimit > 0 ? dailyLimit - Number(remaining) : 0;

  if (loading) {
    return (
      <div className="app-shell">
        <div className="splash">
          <div className="splash-logo">
            <img src="/logo.png" alt="" className="splash-mark" width={44} height={44} />
            Butler
          </div>
          <div className="splash-spinner" />
        </div>
      </div>
    );
  }

  if (error && !policy && !health) {
    return (
      <div className="app-shell">
        <div className="error-screen">
          <h1>Cannot connect</h1>
          <p>{error}</p>
          <code>npm run dev:api</code>
        </div>
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="app-shell">
        <div className="error-screen">
          <h1>Policy unavailable</h1>
          <p>{error ?? "Could not load Butler policy from the API."}</p>
          <button type="button" className="btn accent" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const activeNav = NAV.find((n) => n.id === tab)!;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo.png" alt="" className="brand-mark" width={28} height={28} />
          <div>
            <strong>Butler</strong>
            <span>Agentic hub</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-meta">
            <StatusDot live={live} />
            <span className="chain-tag">Arc · x402</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <nav className="topbar-crumb" aria-label="Breadcrumb">
              <span className="topbar-crumb-root">Butler</span>
              <span className="topbar-crumb-sep" aria-hidden>/</span>
              <span className="topbar-crumb-current">{activeNav.label}</span>
            </nav>
            {health?.seller && (
              <span className="topbar-meta">
                Seller <code>{shortAddr(health.seller)}</code>
              </span>
            )}
          </div>

          <div className="topbar-right">
            <div className="toolbar">
              <MetricChip
                label="Gateway"
                value={
                  agentStatus?.gatewayBalanceUsdc != null
                    ? `$${formatUsdc(agentStatus.gatewayBalanceUsdc)}`
                    : "—"
                }
                variant={Number(agentStatus?.gatewayBalanceUsdc ?? 0) === 0 ? "warning" : "default"}
                accent
              />
              <CircleLoginPanel variant="toolbar" onReady={refresh} />
              <MetricChip label="Mode" value={live ? "Live" : "Dev"} variant={live ? "success" : "default"} />
            </div>

            <span className="toolbar-sep" aria-hidden />

            <div className="toolbar-actions">
              <button
                type="button"
                className="btn icon-btn"
                onClick={() => refresh()}
                title="Refresh"
                aria-label="Refresh"
              >
                <IconRefresh size={15} />
              </button>
              {tab === "policy" && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    const p = await resetPolicy();
                    setPolicy(p);
                    await refresh();
                  }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="main-inner">
          {workflowMessage && tab === "marketplace" && (
            <div
              className={`inline-alert ${
                workflowMessage.startsWith("Workflow complete") ? "success" : ""
              }`}
            >
              {workflowMessage}
            </div>
          )}

          {agentStatus && !agentStatus.canRun && (tab === "agent" || tab === "marketplace") && agentStatus.reason && (
            <div className="inline-alert info">
              <strong>Payer required</strong> — {agentStatus.reason}
            </div>
          )}

          {agentStatus?.gatewayBalanceUsdc === "0" && (tab === "agent" || tab === "marketplace") && (
            <div className="inline-alert info">
              <strong>Fund payer</strong> — Gateway USDC balance is zero. Add testnet USDC at{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                faucet.circle.com
              </a>{" "}
              (Arc testnet), run <code>circle wallet fund --chain ARC-TESTNET</code>, then{" "}
              <code>circle gateway deposit --method direct</code> before running workflows.
            </div>
          )}

          {butlerBusy && (tab === "agent" || tab === "marketplace") && (
            <div className="inline-alert info">
              <strong>Butler is running</strong> — auctions and x402 payments can take several minutes. Keep this tab
              open; your deliverable will appear in Library when finished.
            </div>
          )}

          {error && !butlerBusy && (
            <div className="inline-alert">
              <strong>Partial load</strong> — {error}
            </div>
          )}

          {tab === "agent" && (
            <AgentChatView
              canRun={agentStatus?.canRun ?? false}
              payerReason={agentStatus?.reason}
              onTaskComplete={refresh}
              onButlerBusyChange={setButlerBusy}
              onViewDeliverable={(jobId) => {
                setLibraryJobId(jobId);
                setTab("library");
              }}
            />
          )}

          {tab === "library" && (
            <DeliverablesView selectedId={libraryJobId} onSelectId={setLibraryJobId} />
          )}

          {tab === "marketplace" && (
            <MarketplaceView
              onRunWorkflow={handleRunWorkflow}
              workflowRunning={workflowRunning}
              onViewDeliverable={(jobId) => {
                setLibraryJobId(jobId);
                setTab("library");
              }}
            />
          )}

          {tab === "policy" && (
            <div className="policy-view">
              <div className="policy-strip">
                <BudgetRing spent={spentToday} total={dailyLimit} compact />
                <div className="policy-strip-copy">
                  <span className="policy-strip-value">${formatUsdc(remaining)}</span>
                  <span className="policy-strip-label">
                    remaining · ${formatUsdc(policy.dailyLimitUsdc)} daily · ${formatUsdc(policy.weeklyLimitUsdc)} weekly
                  </span>
                </div>
              </div>

              <Panel title="Infrastructure" desc="Circle CLI · x402 · Arc trace" className="marketplace-section">
                <StackStatusPanel embedded />
              </Panel>

              <div className="card-grid">
                <Panel title="Buyer agents" desc="Orchestrators that pay worker agents">
                  {policy.agents.map((agent) => (
                    <article key={agent.role} className={`entity-card ${agent.enabled ? "" : "off"}`}>
                      <div className="entity-head">
                        <AgentIcon role={agent.role} />
                        <div>
                          <h3 className="capitalize">{agent.role}</h3>
                          <span className="muted">{agent.categories.join(" · ")}</span>
                        </div>
                        <Toggle
                          label={`Toggle ${agent.role}`}
                          checked={agent.enabled}
                          onChange={async (v) => setPolicy(await toggleAgent(agent.role, v, policy))}
                        />
                      </div>
                      <div className="entity-metric">
                        <span>Daily limit</span>
                        <strong>${formatUsdc(agent.dailyLimitUsdc)}</strong>
                      </div>
                    </article>
                  ))}
                </Panel>

                <Panel title="x402 merchants" desc="Legacy routes — marketplace agents preferred">
                  {policy.merchants.map((m) => (
                    <article key={m.id} className={`entity-card merchant ${m.enabled ? "" : "off"}`}>
                      <div className="entity-head">
                        <span className="price-badge">${formatUsdc(m.priceUsdc ?? "0")}</span>
                        <div>
                          <h3>{m.label}</h3>
                          <span className="muted">{m.category}</span>
                        </div>
                        <Toggle
                          label={`Toggle ${m.id}`}
                          checked={m.enabled}
                          onChange={async (v) => setPolicy(await toggleMerchant(m.id, v, policy))}
                        />
                      </div>
                      {m.target && <code className="endpoint">{m.target}</code>}
                    </article>
                  ))}
                </Panel>
              </div>
            </div>
          )}

          {tab === "activity" && (
            <Panel
              title={activityScope === "mine" ? "Your payments" : "Payment ledger"}
              desc={
                activityScope === "mine"
                  ? primaryPayerLabel
                    ? `Agent & Auctions only · wallet ${shortAddr(primaryPayerLabel)} · ${activityCountLabel}`
                    : `Agent & Auctions payments only · ${activityCountLabel}`
                  : `All x402 settlements on this Butler instance · ${activityCountLabel}`
              }
              className={activityScope === "mine" ? "activity-panel-mine" : ""}
              action={
                <div className="panel-head-actions">
                  <div className="activity-scope-toggle" role="tablist" aria-label="Activity scope">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activityScope === "all"}
                      className={`activity-scope-btn ${activityScope === "all" ? "active" : ""}`}
                      onClick={() => setActivityScope("all")}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activityScope === "mine"}
                      className={`activity-scope-btn ${activityScope === "mine" ? "active" : ""}`}
                      onClick={() => setActivityScope("mine")}
                      disabled={!canFilterMine}
                      title={
                        canFilterMine
                          ? "Show only your payments"
                          : "Log in with Circle to filter your activity"
                      }
                    >
                      Mine
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => void loadActivityLedger(activityScope)}
                    aria-label="Refresh ledger"
                  >
                    <IconRefresh size={15} />
                  </button>
                </div>
              }
            >
              {activityLoading ? (
                <div className="activity-loading muted">Loading payments…</div>
              ) : activityRecords.length === 0 ? (
                <EmptyState
                  title={activityScope === "mine" ? "No Agent or Auctions payments yet" : "No payments yet"}
                  body={
                    activityScope === "mine"
                      ? canFilterMine
                        ? "Mine shows tasks you run from the Agent tab or Auctions. Dev probes, CLI runs, and older history stay under All."
                        : "Log in with Circle (Payer) to see activity tied to your wallet."
                      : "Run a task in Agent after logging in with Circle."
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="ledger">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Agent</th>
                        <th>Service</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Settlement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activityRecords.map((r) => (
                        <tr key={r.id} className={r.status === "blocked" ? "dim" : ""}>
                          <td>{new Date(r.at * 1000).toLocaleString()}</td>
                          <td className="capitalize">{r.agent}</td>
                          <td>{merchantLabel(r.merchantId)}</td>
                          <td className="mono">${formatUsdc(r.amountUsdc)}</td>
                          <td>
                            <span className={`pill ${r.status}`}>{r.status}</span>
                          </td>
                          <td className="mono dim-cell">
                            {r.settlementId ? (
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => {
                                  setTraceSettlementId(r.settlementId!);
                                  setTab("trace");
                                }}
                              >
                                {shortAddr(r.settlementId)}
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {tab === "trace" && (
            <PaymentTrace
              initialId={traceSettlementId || ledger.find((r) => r.settlementId)?.settlementId || ""}
              sellerAddress={health?.seller ?? agentStatus?.sellerAddress}
            />
          )}
        </div>
      </main>
    </div>
  );
}

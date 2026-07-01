import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatUsdc,
  getUserPreferences,
  saveUserPreferences,
  updatePolicy,
  type AgentBudget,
  type AuctionMode,
  type Policy,
  type QualityTier,
  type UserUsagePreferences,
} from "../api.ts";
import { AgentIcon, Badge, BudgetRing, Panel, Toggle } from "../components.tsx";
import { IconCheck, IconClose, IconEdit } from "../icons.tsx";
import { StackStatusPanel } from "../trace/StackStatus.tsx";

type PolicyTab = "usage" | "budget" | "agents" | "merchants";

const TABS: { id: PolicyTab; label: string; desc: string }[] = [
  { id: "usage", label: "Your usage", desc: "How you want Butler to work for you" },
  { id: "budget", label: "Spend limits", desc: "Daily caps and policy expiry" },
  { id: "agents", label: "Buyer agents", desc: "Per-role budgets" },
  { id: "merchants", label: "Merchants", desc: "Allowlisted x402 routes" },
];

const QUALITY_OPTIONS: { id: QualityTier; label: string; sub: string }[] = [
  { id: "brief", label: "Brief", sub: "Fast headlines" },
  { id: "standard", label: "Standard", sub: "Best-fit agent" },
  { id: "full", label: "Full report", sub: "Multi-agent ETF" },
];

const CATEGORIES = [
  { value: "research", label: "Research" },
  { value: "reporting", label: "Report" },
  { value: "market-data", label: "Market data" },
  { value: "news", label: "News" },
  { value: "sentiment", label: "Sentiment" },
  { value: "audit", label: "Audit" },
  { value: "bills", label: "Bills" },
];

const BUDGET_PRESETS = [
  { id: "light", label: "Light", daily: "10", weekly: "50", hint: "A few tasks per day" },
  { id: "standard", label: "Standard", daily: "25", weekly: "100", hint: "Regular agent use" },
  { id: "power", label: "Power user", daily: "50", weekly: "250", hint: "Heavy research runs" },
] as const;

interface EditSnapshot {
  prefs: UserUsagePreferences;
  dailyLimit: string;
  weeklyLimit: string;
  expiresOn: string;
  agentLimits: Record<string, string>;
  agentEnabled: Record<string, boolean>;
  merchantEnabled: Record<string, boolean>;
}

function expiryDateInput(validUntil: number): string {
  return new Date(validUntil * 1000).toISOString().slice(0, 10);
}

function expiryFromDateInput(value: string): number {
  const ms = Date.parse(`${value}T23:59:59Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000) + 86400 * 30;
}

function categoryLabel(value: string | undefined): string {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value ?? "Research";
}

function qualityLabel(value: QualityTier | undefined): string {
  return QUALITY_OPTIONS.find((q) => q.id === value)?.label ?? "Standard";
}

function auctionLabel(value: AuctionMode | undefined): string {
  return value === "etf" ? "ETF pipeline — multi-agent" : "Single agent — fastest";
}

function PolicyRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | undefined;
  multiline?: boolean;
}) {
  const empty = !value?.trim();
  return (
    <div className={`policy-row ${multiline ? "policy-row--multiline" : ""}`}>
      <span className="policy-row-label">{label}</span>
      {empty ? (
        <span className="policy-row-empty">Not set</span>
      ) : multiline ? (
        <p className="policy-row-value policy-row-value--block">{value}</p>
      ) : (
        <span className="policy-row-value">{value}</span>
      )}
    </div>
  );
}

function SectionToolbar({
  editing,
  saving,
  onEdit,
  onCancel,
  onSave,
  saveLabel = "Save changes",
}: {
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  if (editing) {
    return (
      <div className="policy-section-toolbar">
        <button type="button" className="btn ghost sm" disabled={saving} onClick={onCancel}>
          <IconClose size={14} />
          Cancel
        </button>
        <button type="button" className="btn primary sm" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="btn ghost sm policy-edit-btn" onClick={onEdit}>
      <IconEdit size={14} />
      Edit
    </button>
  );
}

export function PolicyView({
  policy,
  onPolicyChange,
  remaining,
  spentToday,
  dailyLimit,
  payerLoggedIn,
}: {
  policy: Policy;
  onPolicyChange: (policy: Policy) => void;
  remaining: string;
  spentToday: number;
  dailyLimit: number;
  payerLoggedIn: boolean;
}) {
  const [tab, setTab] = useState<PolicyTab>("usage");
  const [editing, setEditing] = useState<PolicyTab | null>(null);
  const [snapshot, setSnapshot] = useState<EditSnapshot | null>(null);

  const [prefs, setPrefs] = useState<UserUsagePreferences>({
    defaultQualityTier: "standard",
    defaultCategory: "research",
    defaultMaxBudgetUsdc: "0.10",
    defaultAuctionMode: "single",
  });
  const [dailyLimitInput, setDailyLimitInput] = useState(policy.dailyLimitUsdc);
  const [weeklyLimitInput, setWeeklyLimitInput] = useState(policy.weeklyLimitUsdc);
  const [expiresOn, setExpiresOn] = useState(expiryDateInput(policy.validUntil));
  const [agentLimits, setAgentLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(policy.agents.map((a) => [a.role, a.dailyLimitUsdc]))
  );
  const [agentEnabled, setAgentEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(policy.agents.map((a) => [a.role, a.enabled]))
  );
  const [merchantEnabled, setMerchantEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(policy.merchants.map((m) => [m.id, m.enabled]))
  );

  const [preset, setPreset] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const makeSnapshot = useCallback((): EditSnapshot => ({
    prefs: { ...prefs },
    dailyLimit: dailyLimitInput,
    weeklyLimit: weeklyLimitInput,
    expiresOn,
    agentLimits: { ...agentLimits },
    agentEnabled: { ...agentEnabled },
    merchantEnabled: { ...merchantEnabled },
  }), [prefs, dailyLimitInput, weeklyLimitInput, expiresOn, agentLimits, agentEnabled, merchantEnabled]);

  const restoreSnapshot = useCallback((s: EditSnapshot) => {
    setPrefs(s.prefs);
    setDailyLimitInput(s.dailyLimit);
    setWeeklyLimitInput(s.weeklyLimit);
    setExpiresOn(s.expiresOn);
    setAgentLimits(s.agentLimits);
    setAgentEnabled(s.agentEnabled);
    setMerchantEnabled(s.merchantEnabled);
    setPreset(null);
  }, []);

  useEffect(() => {
    void getUserPreferences().then((p) => {
      setPrefs((prev) => ({ ...prev, ...p }));
      setPrefsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (editing) return;
    setDailyLimitInput(policy.dailyLimitUsdc);
    setWeeklyLimitInput(policy.weeklyLimitUsdc);
    setExpiresOn(expiryDateInput(policy.validUntil));
    setAgentLimits(Object.fromEntries(policy.agents.map((a) => [a.role, a.dailyLimitUsdc])));
    setAgentEnabled(Object.fromEntries(policy.agents.map((a) => [a.role, a.enabled])));
    setMerchantEnabled(Object.fromEntries(policy.merchants.map((m) => [m.id, m.enabled])));
  }, [policy, editing]);

  const spentPct = useMemo(() => {
    if (dailyLimit <= 0) return 0;
    return Math.min(100, (spentToday / dailyLimit) * 100);
  }, [spentToday, dailyLimit]);

  const usageConfigured = Boolean(
    prefs.displayName?.trim() || prefs.focusAreas?.trim() || prefs.customInstructions?.trim()
  );

  const startEdit = (section: PolicyTab) => {
    if (editing && editing !== section) {
      if (snapshot) restoreSnapshot(snapshot);
    }
    setSnapshot(makeSnapshot());
    setEditing(section);
    setError(null);
    setMessage(null);
  };

  const cancelEdit = () => {
    if (snapshot) restoreSnapshot(snapshot);
    setEditing(null);
    setSnapshot(null);
    setError(null);
  };

  const switchTab = (next: PolicyTab) => {
    if (editing && editing !== next) cancelEdit();
    setTab(next);
  };

  const applyPreset = (id: (typeof BUDGET_PRESETS)[number]["id"]) => {
    const row = BUDGET_PRESETS.find((p) => p.id === id);
    if (!row) return;
    setPreset(id);
    setDailyLimitInput(row.daily);
    setWeeklyLimitInput(row.weekly);
  };

  const saveUsage = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveUserPreferences(prefs);
      setPrefs(saved);
      setEditing(null);
      setSnapshot(null);
      setMessage("Usage profile saved. Agent defaults update on your next task.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save usage profile");
    } finally {
      setSaving(false);
    }
  };

  const saveBudget = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const agents: AgentBudget[] = policy.agents.map((a) => ({
        ...a,
        dailyLimitUsdc: agentLimits[a.role]?.trim() || a.dailyLimitUsdc,
        enabled: agentEnabled[a.role] ?? a.enabled,
      }));
      const next = await updatePolicy({
        dailyLimitUsdc: dailyLimitInput.trim(),
        weeklyLimitUsdc: weeklyLimitInput.trim(),
        validUntil: expiryFromDateInput(expiresOn),
        agents,
      });
      onPolicyChange(next);
      setEditing(null);
      setSnapshot(null);
      setPreset(null);
      setMessage("Spend limits saved. Enforced on every x402 payment.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save spend limits");
    } finally {
      setSaving(false);
    }
  };

  const saveAgents = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const agents: AgentBudget[] = policy.agents.map((a) => ({
        ...a,
        dailyLimitUsdc: agentLimits[a.role]?.trim() || a.dailyLimitUsdc,
        enabled: agentEnabled[a.role] ?? a.enabled,
      }));
      const next = await updatePolicy({ agents });
      onPolicyChange(next);
      setEditing(null);
      setSnapshot(null);
      setMessage("Buyer agent settings saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save agent settings");
    } finally {
      setSaving(false);
    }
  };

  const saveMerchants = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const merchants = policy.merchants.map((m) => ({
        ...m,
        enabled: merchantEnabled[m.id] ?? m.enabled,
      }));
      const next = await updatePolicy({ merchants });
      onPolicyChange(next);
      setEditing(null);
      setSnapshot(null);
      setMessage("Merchant allowlist saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save merchants");
    } finally {
      setSaving(false);
    }
  };

  const isEditing = (section: PolicyTab) => editing === section;

  return (
    <div className={`policy-page ${editing ? "policy-page--editing" : ""}`}>
      <header className="policy-hero">
        <div className="policy-hero-main">
          <div className="policy-hero-topline">
            <p className="policy-eyebrow">Spend policy</p>
            <div className="policy-status-chips">
              {usageConfigured && (
                <Badge variant="success">
                  <IconCheck size={10} /> Usage set
                </Badge>
              )}
              <Badge variant="default">Cap ${formatUsdc(policy.dailyLimitUsdc)}/day</Badge>
            </div>
          </div>
          <h1 className="policy-title">
            {prefs.displayName?.trim() ? prefs.displayName : "Configure your Butler"}
          </h1>
          <p className="policy-subtitle">
            Review your settings below. Click Edit on any section to change it, then save.
            {payerLoggedIn
              ? " Your usage profile is tied to your Circle session."
              : " Sign in with Circle to persist a personal usage profile."}
          </p>
          {message && <p className="policy-toast policy-toast--ok">{message}</p>}
          {error && <p className="policy-toast policy-toast--err">{error}</p>}
        </div>
        <div className="policy-hero-stats">
          <BudgetRing spent={spentToday} total={dailyLimit} />
          <div className="policy-hero-metrics">
            <div className="policy-metric">
              <span className="policy-metric-label">Remaining today</span>
              <span className="policy-metric-value">${formatUsdc(remaining)}</span>
            </div>
            <div className="policy-metric">
              <span className="policy-metric-label">Daily cap</span>
              <span className="policy-metric-value">${formatUsdc(policy.dailyLimitUsdc)}</span>
            </div>
            <div className="policy-metric">
              <span className="policy-metric-label">Used today</span>
              <span className="policy-metric-value">{spentPct.toFixed(0)}%</span>
            </div>
          </div>
        </div>
      </header>

      <nav className="policy-tabs" aria-label="Policy sections">
        {TABS.map(({ id, label, desc }) => (
          <button
            key={id}
            type="button"
            className={`policy-tab ${tab === id ? "active" : ""} ${editing === id ? "editing" : ""}`}
            onClick={() => switchTab(id)}
            title={desc}
          >
            {label}
            {editing === id && <span className="policy-tab-dot" aria-hidden />}
          </button>
        ))}
      </nav>

      {tab === "usage" && (
        <div className="policy-tab-panel">
          <Panel
            title="About you"
            desc={
              isEditing("usage")
                ? "Editing — tell Butler what you're working on."
                : "How Butler shapes Agent tasks for you."
            }
            className={isEditing("usage") ? "policy-panel--editing" : ""}
            action={
              <SectionToolbar
                editing={isEditing("usage")}
                saving={saving}
                onEdit={() => startEdit("usage")}
                onCancel={cancelEdit}
                onSave={() => void saveUsage()}
                saveLabel="Save profile"
              />
            }
          >
            {isEditing("usage") ? (
              <div className="policy-form-stack">
                <label className="policy-field">
                  <span className="policy-field-label">Display name</span>
                  <input
                    className="field-input"
                    type="text"
                    placeholder="e.g. Sam — macro research"
                    value={prefs.displayName ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, displayName: e.target.value }))}
                    autoFocus
                  />
                </label>
                <label className="policy-field">
                  <span className="policy-field-label">What are you using Butler for?</span>
                  <textarea
                    className="field-input policy-textarea"
                    rows={3}
                    placeholder="e.g. Daily crypto research, contract audits before deploy…"
                    value={prefs.focusAreas ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, focusAreas: e.target.value }))}
                  />
                </label>
                <label className="policy-field">
                  <span className="policy-field-label">Standing instructions for every task</span>
                  <textarea
                    className="field-input policy-textarea"
                    rows={4}
                    placeholder="e.g. Always cite on-chain data. Prefer concise bullet points."
                    value={prefs.customInstructions ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, customInstructions: e.target.value }))}
                  />
                </label>
              </div>
            ) : (
              <div className="policy-view-grid">
                <PolicyRow label="Display name" value={prefs.displayName} />
                <PolicyRow label="Focus areas" value={prefs.focusAreas} multiline />
                <PolicyRow label="Standing instructions" value={prefs.customInstructions} multiline />
              </div>
            )}
          </Panel>

          <Panel
            title="Default task settings"
            desc="Pre-fills the Agent tab — override per task anytime."
            className={isEditing("usage") ? "policy-panel--editing" : ""}
          >
            {isEditing("usage") ? (
              <>
                <div className="mp-create-section">
                  <span className="mp-create-section-label">Output quality</span>
                  <div className="mp-create-quality" role="radiogroup" aria-label="Default quality">
                    {QUALITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={prefs.defaultQualityTier === opt.id}
                        className={`mp-create-quality-btn ${prefs.defaultQualityTier === opt.id ? "active" : ""}`}
                        onClick={() =>
                          setPrefs((p) => ({
                            ...p,
                            defaultQualityTier: opt.id,
                            defaultAuctionMode: opt.id === "full" ? "etf" : p.defaultAuctionMode ?? "single",
                            defaultMaxBudgetUsdc:
                              opt.id === "full" ? p.defaultMaxBudgetUsdc || "0.15" : p.defaultMaxBudgetUsdc,
                          }))
                        }
                      >
                        <span className="mp-create-quality-label">{opt.label}</span>
                        <span className="mp-create-quality-sub">{opt.sub}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="policy-form-grid policy-form-grid--wide">
                  <label className="policy-field">
                    <span className="policy-field-label">Default category</span>
                    <select
                      className="field-input mp-create-select"
                      value={prefs.defaultCategory ?? "research"}
                      onChange={(e) => setPrefs((p) => ({ ...p, defaultCategory: e.target.value }))}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="policy-field">
                    <span className="policy-field-label">Max budget per task (USDC)</span>
                    <input
                      className="field-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.10"
                      value={prefs.defaultMaxBudgetUsdc ?? ""}
                      onChange={(e) => setPrefs((p) => ({ ...p, defaultMaxBudgetUsdc: e.target.value }))}
                    />
                  </label>
                  <label className="policy-field">
                    <span className="policy-field-label">Auction mode</span>
                    <select
                      className="field-input mp-create-select"
                      value={prefs.defaultAuctionMode ?? "single"}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, defaultAuctionMode: e.target.value as AuctionMode }))
                      }
                    >
                      <option value="single">Single agent — fastest</option>
                      <option value="etf">ETF pipeline — multi-agent</option>
                    </select>
                  </label>
                </div>
              </>
            ) : (
              <div className="policy-view-grid policy-view-grid--cols">
                <PolicyRow label="Quality" value={qualityLabel(prefs.defaultQualityTier)} />
                <PolicyRow label="Category" value={categoryLabel(prefs.defaultCategory)} />
                <PolicyRow
                  label="Max per task"
                  value={prefs.defaultMaxBudgetUsdc ? `$${formatUsdc(prefs.defaultMaxBudgetUsdc)}` : undefined}
                />
                <PolicyRow label="Auction" value={auctionLabel(prefs.defaultAuctionMode)} />
              </div>
            )}
          </Panel>

          {!prefsLoaded && !isEditing("usage") && (
            <p className="muted small policy-form-hint">Loading your saved profile…</p>
          )}
        </div>
      )}

      {tab === "budget" && (
        <div className="policy-tab-panel">
          <Panel
            title="Spend limits"
            desc={
              isEditing("budget")
                ? "Editing — daily cap is enforced at payment time on Arc testnet."
                : "Current caps for this Butler instance."
            }
            className={isEditing("budget") ? "policy-panel--editing" : ""}
            action={
              <SectionToolbar
                editing={isEditing("budget")}
                saving={saving}
                onEdit={() => startEdit("budget")}
                onCancel={cancelEdit}
                onSave={() => void saveBudget()}
                saveLabel="Save limits"
              />
            }
          >
            <div className="policy-spend-bar" aria-hidden>
              <div className="policy-spend-bar-fill" style={{ width: `${spentPct}%` }} />
            </div>
            <p className="muted small policy-form-hint">
              ${formatUsdc(String(spentToday))} spent of ${formatUsdc(policy.dailyLimitUsdc)} today
            </p>

            {isEditing("budget") ? (
              <>
                <div className="policy-preset-row">
                  {BUDGET_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`policy-preset-card ${preset === p.id ? "active" : ""}`}
                      onClick={() => applyPreset(p.id)}
                    >
                      <span className="policy-preset-label">{p.label}</span>
                      <span className="policy-preset-value">${p.daily}/day</span>
                      <span className="policy-preset-hint">{p.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="policy-form-grid">
                  <label className="policy-field">
                    <span className="policy-field-label">Daily spend cap (USDC)</span>
                    <input
                      className="field-input"
                      type="text"
                      inputMode="decimal"
                      value={dailyLimitInput}
                      onChange={(e) => {
                        setPreset(null);
                        setDailyLimitInput(e.target.value);
                      }}
                      autoFocus
                    />
                  </label>
                  <label className="policy-field">
                    <span className="policy-field-label">Weekly planning cap (USDC)</span>
                    <input
                      className="field-input"
                      type="text"
                      inputMode="decimal"
                      value={weeklyLimitInput}
                      onChange={(e) => {
                        setPreset(null);
                        setWeeklyLimitInput(e.target.value);
                      }}
                    />
                  </label>
                  <label className="policy-field">
                    <span className="policy-field-label">Policy valid until</span>
                    <input
                      className="field-input"
                      type="date"
                      value={expiresOn}
                      onChange={(e) => setExpiresOn(e.target.value)}
                    />
                  </label>
                </div>
              </>
            ) : (
              <div className="policy-view-grid policy-view-grid--cols">
                <PolicyRow label="Daily cap" value={`$${formatUsdc(dailyLimitInput)}`} />
                <PolicyRow label="Weekly cap" value={`$${formatUsdc(weeklyLimitInput)}`} />
                <PolicyRow label="Valid until" value={expiresOn} />
              </div>
            )}
          </Panel>

          <p className="muted small policy-instance-note">
            Spend limits apply to this Butler server instance. On getbutler.xyz, all users share the same cap unless
            you run a dedicated VM.
          </p>
        </div>
      )}

      {tab === "agents" && (
        <div className="policy-tab-panel">
          <Panel
            title="Buyer agent budgets"
            desc={
              isEditing("agents")
                ? "Editing — per-role daily sub-caps and enablement."
                : "Orchestrators that pay marketplace workers."
            }
            className={isEditing("agents") ? "policy-panel--editing" : ""}
            action={
              <SectionToolbar
                editing={isEditing("agents")}
                saving={saving}
                onEdit={() => startEdit("agents")}
                onCancel={cancelEdit}
                onSave={() => void saveAgents()}
                saveLabel="Save agents"
              />
            }
          >
            <div className="policy-table-wrap">
              <table className="policy-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Categories</th>
                    <th>Daily limit</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {policy.agents.map((agent) => {
                    const enabled = agentEnabled[agent.role] ?? agent.enabled;
                    return (
                      <tr key={agent.role} className={enabled ? "" : "dim"}>
                        <td>
                          <div className="policy-table-agent">
                            <AgentIcon role={agent.role} />
                            <span className="capitalize">{agent.role}</span>
                          </div>
                        </td>
                        <td className="muted">{agent.categories.join(", ")}</td>
                        <td>
                          {isEditing("agents") ? (
                            <input
                              className="field-input policy-table-input"
                              type="text"
                              inputMode="decimal"
                              value={agentLimits[agent.role] ?? agent.dailyLimitUsdc}
                              onChange={(e) =>
                                setAgentLimits((prev) => ({ ...prev, [agent.role]: e.target.value }))
                              }
                              aria-label={`Daily limit for ${agent.role}`}
                            />
                          ) : (
                            <span className="policy-row-value mono">${formatUsdc(agentLimits[agent.role] ?? agent.dailyLimitUsdc)}</span>
                          )}
                        </td>
                        <td>
                          {isEditing("agents") ? (
                            <Toggle
                              label={`Toggle ${agent.role}`}
                              checked={enabled}
                              onChange={(v) => setAgentEnabled((prev) => ({ ...prev, [agent.role]: v }))}
                            />
                          ) : (
                            <Badge variant={enabled ? "success" : "muted"}>{enabled ? "Enabled" : "Off"}</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {tab === "merchants" && (
        <div className="policy-tab-panel">
          <Panel
            title="x402 merchant allowlist"
            desc={
              isEditing("merchants")
                ? "Editing — enable or disable legacy API routes."
                : "Legacy routes — marketplace agents are preferred for new tasks."
            }
            className={isEditing("merchants") ? "policy-panel--editing" : ""}
            action={
              <SectionToolbar
                editing={isEditing("merchants")}
                saving={saving}
                onEdit={() => startEdit("merchants")}
                onCancel={cancelEdit}
                onSave={() => void saveMerchants()}
                saveLabel="Save merchants"
              />
            }
          >
            <div className="policy-table-wrap">
              <table className="policy-table">
                <thead>
                  <tr>
                    <th>Merchant</th>
                    <th>Category</th>
                    <th>Price</th>
                    <th>Route</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {policy.merchants.map((m) => {
                    const enabled = merchantEnabled[m.id] ?? m.enabled;
                    return (
                      <tr key={m.id} className={enabled ? "" : "dim"}>
                        <td>{m.label}</td>
                        <td className="muted">{m.category}</td>
                        <td className="mono">${formatUsdc(m.priceUsdc ?? "0")}</td>
                        <td>
                          {m.target ? <code className="policy-route">{m.target}</code> : "—"}
                        </td>
                        <td>
                          {isEditing("merchants") ? (
                            <Toggle
                              label={`Toggle ${m.id}`}
                              checked={enabled}
                              onChange={(v) => setMerchantEnabled((prev) => ({ ...prev, [m.id]: v }))}
                            />
                          ) : (
                            <Badge variant={enabled ? "success" : "muted"}>{enabled ? "Allowed" : "Blocked"}</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      <Panel title="Infrastructure" desc="Lepton stack — ARC CLI, Circle CLI, Arc 101 trace" className="policy-infra-panel">
        <StackStatusPanel embedded />
      </Panel>

      {editing && (
        <footer className="policy-save-bar">
          <div className="policy-save-bar-copy">
            <span className="policy-editing-label">Editing {TABS.find((t) => t.id === editing)?.label}</span>
            <span className="muted small">Save to apply, or cancel to discard changes.</span>
          </div>
          <div className="policy-save-bar-actions">
            <button type="button" className="btn ghost" disabled={saving} onClick={cancelEdit}>
              Cancel
            </button>
            <button
              type="button"
              className="btn accent"
              disabled={saving || (editing === "usage" && !prefsLoaded)}
              onClick={() => {
                if (editing === "usage") void saveUsage();
                else if (editing === "budget") void saveBudget();
                else if (editing === "agents") void saveAgents();
                else if (editing === "merchants") void saveMerchants();
              }}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

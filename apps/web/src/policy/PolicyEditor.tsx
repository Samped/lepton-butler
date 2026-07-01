import { useEffect, useState } from "react";
import { formatUsdc, updatePolicy, type AgentBudget, type Policy } from "../api.ts";
import { AgentIcon, Panel, Toggle } from "../components.tsx";

function expiryDateInput(validUntil: number): string {
  return new Date(validUntil * 1000).toISOString().slice(0, 10);
}

function expiryFromDateInput(value: string): number {
  const ms = Date.parse(`${value}T23:59:59Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000) + 86400;
}

export function PolicyEditor({
  policy,
  onChange,
}: {
  policy: Policy;
  onChange: (policy: Policy) => void;
}) {
  const [dailyLimit, setDailyLimit] = useState(policy.dailyLimitUsdc);
  const [weeklyLimit, setWeeklyLimit] = useState(policy.weeklyLimitUsdc);
  const [expiresOn, setExpiresOn] = useState(expiryDateInput(policy.validUntil));
  const [agentLimits, setAgentLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(policy.agents.map((a) => [a.role, a.dailyLimitUsdc]))
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDailyLimit(policy.dailyLimitUsdc);
    setWeeklyLimit(policy.weeklyLimitUsdc);
    setExpiresOn(expiryDateInput(policy.validUntil));
    setAgentLimits(Object.fromEntries(policy.agents.map((a) => [a.role, a.dailyLimitUsdc])));
  }, [policy]);

  const saveCaps = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const agents: AgentBudget[] = policy.agents.map((a) => ({
        ...a,
        dailyLimitUsdc: agentLimits[a.role]?.trim() || a.dailyLimitUsdc,
      }));
      const next = await updatePolicy({
        dailyLimitUsdc: dailyLimit.trim(),
        weeklyLimitUsdc: weeklyLimit.trim(),
        validUntil: expiryFromDateInput(expiresOn),
        agents,
      });
      onChange(next);
      setMessage("Policy saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save policy");
    } finally {
      setSaving(false);
    }
  };

  const toggleAgent = async (role: string, enabled: boolean) => {
    setError(null);
    try {
      const agents = policy.agents.map((a) => (a.role === role ? { ...a, enabled } : a));
      onChange(await updatePolicy({ agents }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update agent");
    }
  };

  const toggleMerchant = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      const merchants = policy.merchants.map((m) => (m.id === id ? { ...m, enabled } : m));
      onChange(await updatePolicy({ merchants }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update merchant");
    }
  };

  return (
    <div className="policy-view">
      <Panel title="Spend caps" desc="Limits apply to this Butler instance — enforced on every x402 payment.">
        <div className="policy-form-grid">
          <label className="policy-field">
            <span className="policy-field-label">Daily cap (USDC)</span>
            <input
              className="field-input"
              type="text"
              inputMode="decimal"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              aria-label="Daily spend cap in USDC"
            />
          </label>
          <label className="policy-field">
            <span className="policy-field-label">Weekly cap (USDC)</span>
            <input
              className="field-input"
              type="text"
              inputMode="decimal"
              value={weeklyLimit}
              onChange={(e) => setWeeklyLimit(e.target.value)}
              aria-label="Weekly spend cap in USDC"
            />
          </label>
          <label className="policy-field">
            <span className="policy-field-label">Policy expires</span>
            <input
              className="field-input"
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-label="Policy expiry date"
            />
          </label>
        </div>
        <p className="muted small policy-form-hint">
          Weekly cap is shown for planning; daily cap is enforced at payment time. Agent limits cannot exceed the daily
          cap.
        </p>
        <div className="policy-form-actions">
          <button type="button" className="btn primary sm" disabled={saving} onClick={() => void saveCaps()}>
            {saving ? "Saving…" : "Save limits"}
          </button>
          {message && <span className="policy-form-ok">{message}</span>}
          {error && <span className="policy-form-err">{error}</span>}
        </div>
      </Panel>

      <div className="card-grid">
        <Panel title="Buyer agents" desc="Orchestrators that pay worker agents — set per-role daily limits.">
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
                  onChange={(v) => void toggleAgent(agent.role, v)}
                />
              </div>
              <label className="policy-field policy-field--inline">
                <span className="policy-field-label">Daily limit (USDC)</span>
                <input
                  className="field-input"
                  type="text"
                  inputMode="decimal"
                  value={agentLimits[agent.role] ?? agent.dailyLimitUsdc}
                  onChange={(e) =>
                    setAgentLimits((prev) => ({
                      ...prev,
                      [agent.role]: e.target.value,
                    }))
                  }
                  aria-label={`Daily limit for ${agent.role} agent`}
                />
              </label>
            </article>
          ))}
        </Panel>

        <Panel title="x402 merchants" desc="Legacy routes — enable or disable allowlisted merchants.">
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
                  onChange={(v) => void toggleMerchant(m.id, v)}
                />
              </div>
              {m.target && <code className="endpoint">{m.target}</code>}
            </article>
          ))}
        </Panel>
      </div>
    </div>
  );
}

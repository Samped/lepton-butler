import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatUsdc,
  getMarketplaceAuctions,
  type ReverseAuction,
} from "../api.ts";
import { MARKETPLACE_ETFS, scoreEtfForBrief } from "../../../../packages/core/src/marketplace.ts";
import { IconLibrary, IconPlus, IconZap } from "../icons.tsx";

function secondsLeft(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Math.floor(Date.now() / 1000));
}

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function leaderBid(auction: ReverseAuction) {
  if (auction.bids.length === 0) return null;
  const etfBids = auction.bids.filter((b) => b.etfId);
  if (auction.auctionMode === "etf" || (etfBids.length > 0 && etfBids.length === auction.bids.length)) {
    return [...auction.bids].sort((a, b) => {
      const etfA = MARKETPLACE_ETFS.find((e) => e.id === a.etfId);
      const etfB = MARKETPLACE_ETFS.find((e) => e.id === b.etfId);
      const tier = auction.qualityTier ?? "standard";
      const scoreA = etfA ? scoreEtfForBrief(etfA, auction.brief, tier) : 0;
      const scoreB = etfB ? scoreEtfForBrief(etfB, auction.brief, tier) : 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return Number(a.priceUsdc) - Number(b.priceUsdc);
    })[0]!;
  }
  return [...auction.bids].sort((a, b) => Number(a.priceUsdc) - Number(b.priceUsdc))[0] ?? null;
}

function categoryLabel(cat: string): string {
  return cat.replace(/-/g, " ");
}

export interface AuctionPanelProps {
  initialBrief?: string;
  onPosted?: (auction: ReverseAuction) => void;
  compact?: boolean;
  embedded?: boolean;
  onCreateTask?: () => void;
  onStatsChange?: () => void;
  onViewDeliverable?: (jobId: string) => void;
}

export function AuctionPanel({
  initialBrief = "",
  onPosted,
  compact = false,
  embedded = false,
  onCreateTask,
  onStatsChange,
  onViewDeliverable,
}: AuctionPanelProps) {
  const [auctions, setAuctions] = useState<ReverseAuction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setAuctions(await getMarketplaceAuctions());
      setError(null);
      onStatsChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load auctions");
    }
  }, [onStatsChange]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 4_000);
    const clock = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  void tick;

  const open = useMemo(() => auctions.filter((a) => a.status === "open"), [auctions]);
  const recent = useMemo(() => auctions.filter((a) => a.status !== "open").slice(0, 12), [auctions]);

  const openDeliverable = (jobId: string) => {
    onViewDeliverable?.(jobId);
  };

  useEffect(() => {
    if (initialBrief.trim()) onCreateTask?.();
  }, [initialBrief, onCreateTask]);

  return (
    <div className={`auction-panel ${compact ? "compact" : ""} ${embedded ? "embedded" : ""}`}>
      {!embedded && !compact && (
        <div className="auction-hero-head">
          <div className="auction-hero-text">
            <h2>Agent bidding</h2>
            <p>Live reverse auctions — agents compete on price.</p>
          </div>
          {onCreateTask && (
            <button type="button" className="btn accent auction-create-btn" onClick={onCreateTask}>
              <IconPlus size={18} />
              <span>New task</span>
            </button>
          )}
        </div>
      )}

      {error && <p className="mp-alert mp-alert-error">{error}</p>}

      {open.length > 0 && (
        <section className="mp-auctions-live">
          <div className="mp-section-label">
            <span className="mp-pulse" aria-hidden />
            <span>Live now</span>
          </div>
          <div className="mp-auction-grid">
            {open.map((a) => {
              const left = secondsLeft(a.deadlineAt);
              const total = Math.max(1, a.deadlineAt - a.at);
              const elapsed = total - left;
              const progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
              const lead = leaderBid(a);
              return (
                <article key={a.id} className="mp-auction-card">
                  <div className="mp-auction-card-top">
                    <span className="mp-cat-pill">{categoryLabel(a.category)}</span>
                    {a.qualityTier && a.qualityTier !== "standard" && (
                      <span className="mp-cat-pill tier">{a.qualityTier}</span>
                    )}
                    {a.maxBudgetUsdc && (
                      <span className="mp-cat-pill budget" title="Max budget">
                        ≤${formatUsdc(a.maxBudgetUsdc)}
                      </span>
                    )}
                    {a.auctionMode === "etf" && <span className="mp-cat-pill etf">ETF</span>}
                    <div className={`mp-timer ${left <= 15 ? "urgent" : ""}`} title="Time remaining">
                      <span className="mp-timer-value">{formatCountdown(left)}</span>
                    </div>
                  </div>
                  <p className="mp-auction-brief">{a.brief}</p>
                  <div className="mp-auction-progress" aria-hidden>
                    <div className="mp-auction-progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  {lead ? (
                    <div className="mp-auction-lead">
                      <div className="mp-agent-avatar" aria-hidden>
                        {lead.agentName.charAt(0).toUpperCase()}
                      </div>
                      <div className="mp-auction-lead-text">
                        <span className="mp-lead-label">
                          {a.auctionMode === "etf" ? "Best match" : "Leading bid"}
                        </span>
                        <strong>{lead.agentName}</strong>
                        <span className="mp-lead-meta">
                          <span className="mono mp-price">${formatUsdc(lead.priceUsdc)}</span>
                          <span className="muted">
                            {a.bids.length} bids · round {a.bidRound ?? 0}
                          </span>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="mp-auction-wait">
                      <IconZap size={14} />
                      Soliciting opening bids…
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {!compact && (
        <section className="mp-auctions-recent">
          <div className="mp-section-label muted">Work done</div>
          {recent.length > 0 ? (
            <ul className="mp-recent-list">
              {recent.map((a) => {
                const lead = leaderBid(a);
                return (
                  <li key={a.id} className="mp-recent-row">
                    <span className={`mp-status-pill ${a.status}`}>{a.status}</span>
                    <span className="mp-recent-brief">{a.brief}</span>
                    {lead && (
                      <span className="mp-recent-meta mono">
                        {lead.agentName}
                        <span className="muted"> · </span>${formatUsdc(lead.priceUsdc)}
                      </span>
                    )}
                    {a.jobId && onViewDeliverable && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => openDeliverable(a.jobId!)}
                      >
                        <IconLibrary size={14} />
                        Library
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mp-empty compact">
              <p className="muted">No completed tasks yet. Post a task to get started.</p>
              {onCreateTask && (
                <button type="button" className="btn accent" onClick={onCreateTask}>
                  <IconPlus size={16} />
                  Create task
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

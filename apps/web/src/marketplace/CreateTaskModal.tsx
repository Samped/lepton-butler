import { useEffect, useState } from "react";
import {
  createMarketplaceAuction,
  formatUsdc,
  getButlerReadiness,
  runButler,
  type AuctionMode,
  type ButlerResult,
  type QualityTier,
  type ReverseAuction,
} from "../api.ts";
import { formatWorkflowError } from "../format.ts";
import { IconPlus, IconZap } from "../icons.tsx";

export interface CreateTaskModalProps {
  open: boolean;
  initialBrief?: string;
  onClose: () => void;
  onPosted?: (auction: ReverseAuction) => void;
  onButlerComplete?: (result: ButlerResult) => void;
}

type SubmitMode = "bids" | "butler";

const QUALITY_OPTIONS: { id: QualityTier; label: string; sub: string }[] = [
  { id: "brief", label: "Brief", sub: "Headlines & quotes" },
  { id: "standard", label: "Standard", sub: "Best fit agent" },
  { id: "full", label: "Full report", sub: "Multi-agent pipeline" },
];

const CATEGORIES = [
  { value: "research", label: "Research" },
  { value: "reporting", label: "Report" },
  { value: "market-data", label: "Market" },
  { value: "news", label: "News" },
  { value: "sentiment", label: "Sentiment" },
  { value: "audit", label: "Audit" },
  { value: "bills", label: "Bills" },
];

export function CreateTaskModal({ open, initialBrief = "", onClose, onPosted, onButlerComplete }: CreateTaskModalProps) {
  const [brief, setBrief] = useState("");
  const [category, setCategory] = useState("research");
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const [maxBudgetUsdc, setMaxBudgetUsdc] = useState("");
  const [auctionMode, setAuctionMode] = useState<AuctionMode>("single");
  const [mode, setMode] = useState<SubmitMode>("butler");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [butlerReady, setButlerReady] = useState<boolean | null>(null);
  const [butlerReason, setButlerReason] = useState<string | undefined>();
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initialBrief.trim()) setBrief(initialBrief);
    void getButlerReadiness()
      .then((s) => {
        setButlerReady(s.canRun);
        setButlerReason(s.reason);
      })
      .catch(() => {
        setButlerReady(false);
        setButlerReason("Could not check Butler status");
      });
  }, [open, initialBrief]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (qualityTier === "full") {
      setAuctionMode("etf");
      setMaxBudgetUsdc((prev) => prev || "0.15");
    } else if (qualityTier === "brief") {
      setAuctionMode("single");
    }
  }, [qualityTier]);

  if (!open) return null;

  const taskOptions = {
    qualityTier,
    maxBudgetUsdc: maxBudgetUsdc.trim() || undefined,
    auctionMode,
  };

  const handleSubmit = async () => {
    const text = brief.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    setProgress(null);

    try {
      if (mode === "bids") {
        const auction = await createMarketplaceAuction({
          brief: text,
          category,
          minReputation: 70,
          ttlSeconds: 90,
          autoAward: true,
          ...taskOptions,
        });
        setBrief("");
        onPosted?.(auction);
        onClose();
        return;
      }

      if (!butlerReady) {
        setError(butlerReason ?? "Configure Circle payer before running Butler");
        return;
      }

      setProgress("Discovering agents, running auction, settling…");
      const result = await runButler({
        brief: text,
        category,
        strategy: "auction",
        ttlSeconds: 60,
        ...taskOptions,
      });
      setProgress(null);
      if (!result?.ok) {
        setError(result?.error ?? "Butler could not complete the request");
        return;
      }
      setBrief("");
      onButlerComplete?.(result);
      onClose();
    } catch (e) {
      setError(formatWorkflowError(e instanceof Error ? e.message : "Failed to create task"));
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  };

  const submitLabel =
    submitting
      ? mode === "butler"
        ? "Settling…"
        : "Posting…"
      : mode === "butler"
        ? "Run Butler"
        : "Post auction";

  return (
    <div className="modal-backdrop mp-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-sheet mp-modal mp-create-modal"
        role="dialog"
        aria-labelledby="create-task-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mp-create-header">
          <div className="mp-create-header-text">
            <p className="mp-create-eyebrow">Auctions</p>
            <h2 id="create-task-title">Create task</h2>
          </div>
          <button type="button" className="mp-create-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="mp-create-body">
          <div className="mp-create-segment" role="tablist" aria-label="Submission mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "butler"}
              className={`mp-create-segment-btn ${mode === "butler" ? "active" : ""}`}
              onClick={() => setMode("butler")}
            >
              <IconZap size={15} />
              <span>Butler</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "bids"}
              className={`mp-create-segment-btn ${mode === "bids" ? "active" : ""}`}
              onClick={() => setMode("bids")}
            >
              <IconPlus size={15} />
              <span>Auction only</span>
            </button>
          </div>
          <p className="mp-create-mode-hint">
            {mode === "butler"
              ? "Autonomous discover → bid → pay → deliver to Library"
              : "Post an RFP and watch agents compete — award manually"}
          </p>

          <div className="mp-create-field mp-create-field-primary">
            <label className="mp-create-label" htmlFor="task-brief">
              What do you need?
            </label>
            <textarea
              id="task-brief"
              className="mp-create-textarea"
              rows={3}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Full investment research report on TSLA with executive summary and citations…"
              autoFocus
            />
          </div>

          <div className="mp-create-section">
            <span className="mp-create-section-label">Output quality</span>
            <div className="mp-create-quality" role="radiogroup" aria-label="Quality tier">
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={qualityTier === opt.id}
                  className={`mp-create-quality-btn ${qualityTier === opt.id ? "active" : ""}`}
                  onClick={() => setQualityTier(opt.id)}
                >
                  <span className="mp-create-quality-label">{opt.label}</span>
                  <span className="mp-create-quality-sub">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mp-create-section">
            <span className="mp-create-section-label">Parameters</span>
            <div className="mp-create-params">
              <div className="mp-create-field">
                <label className="mp-create-label sm" htmlFor="task-category">
                  Category
                </label>
                <div className="mp-create-select-wrap">
                  <select
                    id="task-category"
                    className="mp-create-select"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mp-create-field">
                <label className="mp-create-label sm" htmlFor="task-budget">
                  Max budget
                </label>
                <div className="mp-create-input-prefix">
                  <span className="mp-create-prefix">$</span>
                  <input
                    id="task-budget"
                    type="number"
                    min="0"
                    step="0.001"
                    className="mp-create-input"
                    placeholder="0.10"
                    value={maxBudgetUsdc}
                    onChange={(e) => setMaxBudgetUsdc(e.target.value)}
                  />
                  <span className="mp-create-suffix">USDC</span>
                </div>
              </div>

              <div className="mp-create-field mp-create-field-wide">
                <label className="mp-create-label sm" htmlFor="task-delivery">
                  Delivery
                </label>
                <div className="mp-create-delivery">
                  <button
                    type="button"
                    className={`mp-create-delivery-btn ${auctionMode === "single" ? "active" : ""}`}
                    disabled={qualityTier === "full"}
                    onClick={() => setAuctionMode("single")}
                  >
                    Single agent
                  </button>
                  <button
                    type="button"
                    className={`mp-create-delivery-btn ${auctionMode === "etf" ? "active" : ""}`}
                    disabled={qualityTier === "full"}
                    onClick={() => setAuctionMode("etf")}
                  >
                    Multi-agent ETF
                  </button>
                </div>
                {qualityTier === "full" && (
                  <p className="mp-create-field-note">Full tier runs the investment research pipeline.</p>
                )}
              </div>
            </div>
          </div>

          {mode === "butler" && butlerReady === false && butlerReason && (
            <div className="mp-create-banner warn">
              <span className="mp-create-banner-dot" />
              {butlerReason}
            </div>
          )}
          {progress && (
            <div className="mp-create-banner progress">
              <span className="mp-create-spinner" aria-hidden />
              {progress}
            </div>
          )}
          {error && (
            <div className="mp-create-banner error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="mp-create-footer">
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn accent mp-create-submit"
            disabled={submitting || !brief.trim() || (mode === "butler" && butlerReady !== true)}
            onClick={() => void handleSubmit()}
          >
            {mode === "butler" && !submitting && <IconZap size={16} />}
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function CreateTaskFab({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="mp-fab" onClick={onClick} aria-label="Create task">
      <IconPlus size={22} />
    </button>
  );
}

export interface TaskCompletionToastState {
  ok: boolean;
  title: string;
  brief: string;
  jobId?: string;
  summary?: string;
  meta?: string;
  error?: string;
  pending?: boolean;
}

export function butlerResultToToast(result: ButlerResult): TaskCompletionToastState {
  const winner = result?.phases?.find((p) => p.winner)?.winner;
  return {
    ok: result?.ok ?? false,
    title: result?.ok ? "Task complete" : "Task failed",
    brief: result?.brief ?? "",
    jobId: result?.jobId,
    summary: result?.summary,
    meta: winner ? `${winner.agentName} · $${formatUsdc(winner.priceUsdc)}` : undefined,
    error: result?.error,
  };
}

export function TaskCompletionToast({
  toast,
  onViewLibrary,
  onDismiss,
}: {
  toast: TaskCompletionToastState;
  onViewLibrary?: (jobId: string) => void;
  onDismiss?: () => void;
}) {
  return (
    <div className={`mp-toast ${toast.ok ? "success" : toast.pending ? "pending" : "error"}`} role="status">
      <div className="mp-toast-head">
        <span className="mp-toast-icon">{toast.pending ? "…" : toast.ok ? "✓" : "!"}</span>
        <div>
          <strong>{toast.title}</strong>
          <span className="muted mp-toast-brief">{toast.brief}</span>
          {toast.meta && <span className="muted">{toast.meta}</span>}
        </div>
        {onDismiss && (
          <button type="button" className="btn ghost sm mp-toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      {toast.error && <p className="mp-toast-error">{toast.error}</p>}
      {toast.summary && !toast.pending && (
        <p className="mp-toast-summary">
          {toast.summary.length > 240 ? `${toast.summary.slice(0, 240)}…` : toast.summary}
        </p>
      )}
      {toast.ok && toast.jobId && onViewLibrary && (
        <div className="mp-toast-actions">
          <button type="button" className="btn accent sm" onClick={() => onViewLibrary(toast.jobId!)}>
            View in Library
          </button>
        </div>
      )}
    </div>
  );
}

/** @deprecated Use butlerResultToToast */
export const payerResultToToast = butlerResultToToast;

export function ButlerToast({
  result,
  onDismiss,
  onViewLibrary,
}: {
  result: ButlerResult;
  onDismiss?: () => void;
  onViewLibrary?: (jobId: string) => void;
}) {
  return (
    <TaskCompletionToast toast={butlerResultToToast(result)} onDismiss={onDismiss} onViewLibrary={onViewLibrary} />
  );
}

/** @deprecated Use ButlerToast */
export const PayerAgentToast = ButlerToast;

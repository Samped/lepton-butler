import { useCallback, useEffect, useRef, useState } from "react";
import { resolveExpressBrief, resolveDeepWorkRouting } from "../brief-intent.ts";
import {
  formatUsdc,
  getAgentPlannerStatus,
  getMarketplaceDeliverables,
  runButler,
  type AuctionMode,
  type ButlerResult,
  type QualityTier,
} from "../api.ts";
import { butlerResultToToast, TaskCompletionToast, type TaskCompletionToastState } from "../marketplace/CreateTaskModal.tsx";
import { formatWorkflowError } from "../format.ts";
import { IconPlus, IconSend } from "../icons.tsx";

const MAX_ATTACH_BYTES = 48_000;
const ACCEPTED_EXTENSIONS = ".sol,.vy,.txt,.md,.json";

interface AttachedDocument {
  name: string;
  content: string;
}

function isSolidityFile(name: string, content: string): boolean {
  return /\.sol$/i.test(name) || /pragma\s+solidity/i.test(content);
}

function composeTask(input: string, attachment: AttachedDocument | null): string {
  const text = input.trim();
  if (!attachment) return text;
  const fileBlock = `// File: ${attachment.name}\n${attachment.content.trim()}`;
  if (text) return `${fileBlock}\n\n${text}`;
  return `${fileBlock}\n\nAudit this contract for security vulnerabilities.`;
}

type ChatRole = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  meta?: string;
  deliverableId?: string;
  error?: boolean;
  success?: boolean;
}

const STARTERS = [
  "Research a stock and create an investment report",
  "Audit my Solidity contract for vulnerabilities",
  "Research BTC on-chain flows and DeFi exposure",
  "Macro outlook: Fed rates, CPI, and market impact",
];

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

const QUALITY_LABEL: Record<QualityTier, string> = {
  brief: "Brief",
  standard: "Standard",
  full: "Full report",
};

export function AgentChatView({
  canRun,
  payerReason,
  onTaskComplete,
  onButlerBusyChange,
  onViewDeliverable,
}: {
  canRun: boolean;
  payerReason?: string;
  onTaskComplete?: () => void;
  onButlerBusyChange?: (busy: boolean) => void;
  onViewDeliverable?: (jobId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Describe what you need. I'll discover agents, run a competitive auction, and settle the best bid automatically — full BTC theses deliver in about a minute.",
    },
  ]);
  const [input, setInput] = useState("");
  const [category, setCategory] = useState("research");
  const [qualityTier, setQualityTier] = useState<QualityTier>("full");
  const [maxBudgetUsdc, setMaxBudgetUsdc] = useState("0.25");
  const [auctionMode, setAuctionMode] = useState<AuctionMode>("etf");
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plannerAi, setPlannerAi] = useState(false);
  const [completionToast, setCompletionToast] = useState<TaskCompletionToastState | null>(null);
  const [attachment, setAttachment] = useState<AttachedDocument | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getAgentPlannerStatus().then((p) => setPlannerAi(p.enabled));
  }, []);

  useEffect(() => {
    if (qualityTier === "full") {
      setAuctionMode("etf");
      setMaxBudgetUsdc((prev) => prev || "0.25");
    } else if (qualityTier === "brief") {
      setAuctionMode("single");
    }
  }, [qualityTier]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const pushMessage = useCallback((msg: Omit<ChatMessage, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: crypto.randomUUID() }]);
  }, []);

  useEffect(() => {
    onButlerBusyChange?.(busy);
  }, [busy, onButlerBusyChange]);

  const handleAttachFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_ATTACH_BYTES) {
      pushMessage({
        role: "assistant",
        content: `“${file.name}” is too large (${Math.round(file.size / 1024)} KB). Attach files up to ${Math.round(MAX_ATTACH_BYTES / 1024)} KB.`,
        error: true,
      });
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim()) {
        pushMessage({ role: "assistant", content: "That file appears to be empty.", error: true });
        return;
      }
      setAttachment({ name: file.name, content });
      if (isSolidityFile(file.name, content)) {
        setCategory("audit");
        setQualityTier("standard");
        setAuctionMode("single");
        if (!input.trim()) {
          setInput("Audit this contract for reentrancy, access control, and other vulnerabilities.");
        }
      }
    } catch {
      pushMessage({ role: "assistant", content: "Could not read that file.", error: true });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    const task = composeTask(input, attachment);
    if (!task || busy) return;

    if (!canRun) {
      pushMessage({
        role: "assistant",
        content: payerReason ?? "Log in with Circle (Payer) and fund Gateway USDC before running tasks.",
        error: true,
      });
      return;
    }

    setInput("");
    setAttachment(null);
    const userPreview = attachment
      ? [attachment.name, input.trim()].filter(Boolean).join(" — ")
      : task;
    pushMessage({ role: "user", content: userPreview });
    setBusy(true);
    setCompletionToast(null);

    const express = resolveExpressBrief(task);
    const deepWork = resolveDeepWorkRouting(task);
    const effectiveTier = express ? ("brief" as QualityTier) : deepWork ? deepWork.qualityTier : qualityTier;
    const taskOptions = {
      qualityTier: effectiveTier,
      maxBudgetUsdc: maxBudgetUsdc.trim() || undefined,
      auctionMode: express ? ("single" as AuctionMode) : deepWork ? deepWork.auctionMode : auctionMode,
    };

    try {
      const result = await runButler({
        brief: task,
        category: express?.category ?? category,
        strategy: "auction",
        ttlSeconds: effectiveTier === "full" ? 25 : effectiveTier === "brief" ? 8 : 12,
        ...taskOptions,
      });

      if (!result) {
        pushMessage({
          role: "assistant",
          content: "No response from Butler. Retry the task; if it persists, restart the API (npm run dev).",
          error: true,
        });
        return;
      }

      const toast = butlerResultToToast(result);
      const discover = result.phases?.find((p) => p.phase === "discover");
      const negotiate = result.phases?.find((p) => p.phase === "negotiate");
      const settle = result.phases?.find((p) => p.phase === "settle");
      const winner = settle?.winner ?? negotiate?.winner ?? result.phases?.find((p) => p.winner)?.winner;
      const bidCount = negotiate?.bids ?? result.auction?.bids?.length;

      if (result?.ok) {
        setCompletionToast(toast);
        pushMessage({
          role: "assistant",
          content: [
            winner
              ? `✓ Task complete — ${winner.agentName} delivered for $${formatUsdc(winner.priceUsdc)} USDC.`
              : "✓ Task complete — deliverable saved to Library.",
            result.summary ? `\n${result.summary}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          deliverableId: result.jobId,
          meta: [
            `${QUALITY_LABEL[effectiveTier]} · ${taskOptions.auctionMode === "etf" ? "ETF pipeline" : "Fast settle"}`,
            toast.meta,
            bidCount != null ? `${bidCount} bids` : discover?.message,
            result.mode ? `Paid via ${result.mode}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          success: true,
        });
      } else {
        pushMessage({
          role: "assistant",
          content: result.summary
            ? `${result.error ?? "Workflow stopped before all agents finished."}\n\nPartial deliverable:\n${result.summary}`
            : result.error ?? toast.error ?? "Butler could not complete the request.",
          error: !result.summary,
          deliverableId: result.jobId,
          meta: negotiate?.message ?? discover?.message,
        });
      }
      onTaskComplete?.();
    } catch (e) {
      const errMsg = formatWorkflowError(e instanceof Error ? e.message : "Task failed");
      let recovered: { jobId?: string; summary?: string } | null = null;
      if (/timed out|aborted|cancelled/i.test(errMsg)) {
        try {
          const list = await getMarketplaceDeliverables();
          const match = list.find((j) => (j.brief ?? "").includes(task.slice(0, 40)) || task.includes((j.brief ?? "").slice(0, 40)));
          if (match?.summary) recovered = { jobId: match.id, summary: match.summary };
        } catch {
          /* ignore */
        }
      }
      if (recovered?.summary) {
        setCompletionToast({
          ok: true,
          title: "Task complete",
          brief: task,
          jobId: recovered.jobId,
          summary: recovered.summary,
        });
      }
      pushMessage({
        role: "assistant",
        content: recovered?.summary
          ? `${errMsg}\n\nYour deliverable finished in the background:\n${recovered.summary}`
          : errMsg,
        error: !recovered,
        deliverableId: recovered?.jobId,
        success: !!recovered,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-chat">
      <div className="agent-chat-toolbar">
        <div className="agent-toolbar-status">
          <span className="agent-status-chip accent" title="Default auction settings">
            {QUALITY_LABEL[qualityTier]}
          </span>
          <span className="agent-status-chip" title="Agents compete; best ETF match wins">
            Bid auction
          </span>
          {auctionMode === "etf" && (
            <span className="agent-status-chip" title="Multi-agent workflow">
              ETF pipeline
            </span>
          )}
          {maxBudgetUsdc.trim() && (
            <span className="agent-status-chip muted-chip" title="Maximum spend">
              ≤ ${formatUsdc(maxBudgetUsdc)} USDC
            </span>
          )}
        </div>
        <div className="agent-toolbar-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setConfigOpen((v) => !v)}
            aria-expanded={configOpen}
          >
            {configOpen ? "Hide config" : "Configure agent"}
          </button>
          <span
            className={`agent-planner-chip ${plannerAi ? "on" : ""}`}
            title={plannerAi ? "OpenAI category routing active" : "Keyword routing (set OPENAI_API_KEY on API)"}
          >
            {plannerAi ? "AI routing" : "Keyword routing"}
          </span>
        </div>
      </div>

      {configOpen && (
        <div className="agent-config-panel">
          <p className="agent-config-hint">
            Adjust how agents bid on your task. Defaults favor the fullest multi-agent answer.
          </p>

          <div className="mp-create-section agent-config-section">
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

          <div className="mp-create-section agent-config-section">
            <span className="mp-create-section-label">Auction parameters</span>
            <div className="mp-create-params">
              <div className="mp-create-field">
                <label className="mp-create-label sm" htmlFor="agent-category">
                  Category
                </label>
                <div className="mp-create-select-wrap">
                  <select
                    id="agent-category"
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
                <label className="mp-create-label sm" htmlFor="agent-budget">
                  Max budget
                </label>
                <div className="mp-create-input-prefix">
                  <span className="mp-create-prefix">$</span>
                  <input
                    id="agent-budget"
                    type="number"
                    min="0"
                    step="0.001"
                    className="mp-create-input"
                    placeholder="0.25"
                    value={maxBudgetUsdc}
                    onChange={(e) => setMaxBudgetUsdc(e.target.value)}
                  />
                  <span className="mp-create-suffix">USDC</span>
                </div>
              </div>

              <div className="mp-create-field mp-create-field-wide">
                <label className="mp-create-label sm">Delivery</label>
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
                  <p className="mp-create-field-note">Full tier always runs the multi-agent research pipeline.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="agent-chat-messages" ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""} ${msg.success ? "success" : ""}`}>
            <div className="chat-bubble-body">{msg.content}</div>
            {msg.meta && <div className="chat-bubble-meta">{msg.meta}</div>}
            {msg.deliverableId && onViewDeliverable && (
              <button
                type="button"
                className="btn ghost sm chat-library-link"
                onClick={() => onViewDeliverable(msg.deliverableId!)}
              >
                Open in Library →
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-bubble assistant">
            <div className="chat-bubble-body chat-typing">
              <span className="chat-typing-label">
                {qualityTier === "full"
                  ? "Running pipeline — paying agent via x402…"
                  : "Paying agent and building deliverable…"}
              </span>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {completionToast && (
        <div className="agent-toast-wrap">
          <TaskCompletionToast
            toast={completionToast}
            onViewLibrary={onViewDeliverable}
            onDismiss={() => setCompletionToast(null)}
          />
        </div>
      )}

      {messages.length <= 1 && (
        <div className="agent-starters">
          {STARTERS.map((s) => (
            <button key={s} type="button" className="agent-starter-chip" onClick={() => setInput(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="agent-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="agent-attach-input"
          accept={ACCEPTED_EXTENSIONS}
          aria-hidden
          tabIndex={-1}
          onChange={(e) => void handleAttachFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="btn ghost sm agent-attach-btn"
          disabled={busy}
          aria-label="Attach document for audit"
          title="Attach .sol or text file"
          onClick={() => fileInputRef.current?.click()}
        >
          <IconPlus size={18} />
        </button>
        <div className="agent-composer-field">
          {attachment && (
            <div className="agent-attach-chip-row">
              <span className="agent-attach-chip">
                <span className="agent-attach-chip-name" title={attachment.name}>
                  {attachment.name}
                </span>
                <button
                  type="button"
                  className="agent-attach-chip-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => setAttachment(null)}
                >
                  ×
                </button>
              </span>
            </div>
          )}
          <textarea
            className="agent-chat-input"
            rows={1}
            placeholder={
              attachment
                ? "Optional instructions for the audit…"
                : "What should Butler research for you?"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          className="btn primary agent-send-btn"
          disabled={busy || !composeTask(input, attachment).trim()}
          aria-label="Send"
        >
          <IconSend size={16} />
        </button>
      </form>
    </div>
  );
}

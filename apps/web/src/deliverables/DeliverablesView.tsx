/** Library — completed agent deliverables and exports. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUsdc, getMarketplaceDeliverable, getMarketplaceDeliverables, type MarketplaceDeliverable } from "../api.ts";
import { IconCheck, IconChevronLeft, IconChevronRight, IconDownload, IconLibrary, IconRefresh, IconSearch } from "../icons.tsx";
import { LibraryDocumentBody } from "./LibraryDocumentBody.tsx";
import { resolveDeliverablePayload } from "./payload.ts";
import { combineWorkflowResult } from "./combine.ts";
import { downloadText, slugify } from "./format.ts";
import { formatWorkflowError } from "../format.ts";
import { useIsMobile } from "../use-mobile.ts";
import { PaperDocument, serializePaperForExport } from "./PaperDocument.tsx";
import { exportPaperPdf } from "./pdfExport.ts";
import { formatRelativeTime, strategyLabel } from "./utils.ts";
import { auditPaperTitle, isAuditDeliverable } from "./audit.ts";
import { billPaperTitle, isBillDeliverable } from "./bill.ts";
import { isIntelPayload } from "./defi-agents.tsx";

export function DeliverablesView({
  selectedId,
  onSelectId,
  refreshKey = 0,
}: {
  selectedId?: string | null;
  onSelectId?: (id: string | null) => void;
  /** Increment from App refresh to reload the list. */
  refreshKey?: number;
}) {
  const [items, setItems] = useState<MarketplaceDeliverable[]>([]);
  const [selected, setSelected] = useState<MarketplaceDeliverable | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const paperRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobile();
  const mobileDetail = isMobile && !!selected;

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getMarketplaceDeliverables();
      setItems(list);
      return list;
    } catch (e) {
      setError(formatWorkflowError(e instanceof Error ? e.message : "Failed to load deliverables"));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList, refreshKey]);

  useEffect(() => {
    if (!selectedId) return;
    const found = items.find((j) => j.id === selectedId);
    if (found) {
      setSelected(found);
      return;
    }
    void getMarketplaceDeliverable(selectedId)
      .then((job) => setSelected(job))
      .catch(() => undefined);
  }, [selectedId, items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (j) =>
        (j.brief ?? "").toLowerCase().includes(q) ||
        (j.summary ?? "").toLowerCase().includes(q) ||
        j.steps.some((s) => s.label.toLowerCase().includes(q))
    );
  }, [items, query]);

  const listTitle = (job: MarketplaceDeliverable) => {
    const merged = combineWorkflowResult(job.steps) ?? undefined;
    if (isAuditDeliverable(job)) return auditPaperTitle(job, merged);
    if (isBillDeliverable(job)) return billPaperTitle(job, merged);
    const brief = job.brief?.trim();
    if (!brief) return "Auction task";
    return brief.length > 72 ? `${brief.slice(0, 72)}…` : brief;
  };

  const pick = (job: MarketplaceDeliverable) => {
    setCopied(false);
    onSelectId?.(job.id);
    void getMarketplaceDeliverable(job.id)
      .then((full) => setSelected(full))
      .catch(() => setSelected(job));
  };

  const clearSelection = () => {
    setSelected(null);
    onSelectId?.(null);
    setCopied(false);
  };

  const refresh = async () => {
    const list = await loadList();
    if (selected?.id) {
      const found = list.find((j) => j.id === selected.id);
      if (found) setSelected(found);
    }
  };

  const doneSteps = (selected?.steps ?? []).filter((s) => s.status === "done" && s.output != null);
  const structuredPayload = useMemo(
    () => resolveDeliverablePayload(selected),
    [selected]
  );
  const displaySummary = useMemo(() => {
    if (!selected) return "";
    if (structuredPayload && isIntelPayload(structuredPayload)) {
      return typeof structuredPayload.summary === "string" ? structuredPayload.summary : selected.brief ?? "";
    }
    if (selected.summary?.trim() && !selected.summary.trim().startsWith("{")) {
      return selected.summary.trim();
    }
    const merged = doneSteps.length > 0 ? combineWorkflowResult(doneSteps) : null;
    if (merged) {
      return [
        merged.report && typeof (merged.report as Record<string, unknown>).title === "string"
          ? String((merged.report as Record<string, unknown>).title)
          : selected.brief,
        typeof merged.executiveSummary === "string" ? String(merged.executiveSummary) : "",
        typeof (merged.report as Record<string, unknown> | undefined)?.summary === "string"
          ? String((merged.report as Record<string, unknown>).summary)
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    return "";
  }, [selected, doneSteps, structuredPayload]);
  const totalSpent = useMemo(
    () => items.reduce((sum, j) => sum + (Number(j.totalUsdc) || 0), 0),
    [items]
  );

  const handleDownloadPdf = () => {
    if (!selected || !paperRef.current) return;
    setExportingPdf(true);
    try {
      const name = slugify(selected.brief ?? selected.id);
      const html = serializePaperForExport(paperRef.current);
      exportPaperPdf(html, name);
    } finally {
      setTimeout(() => setExportingPdf(false), 800);
    }
  };

  const handleDownloadTxt = () => {
    if (!selected) return;
    const name = slugify(selected.brief ?? selected.id);
    const header = [
      selected.brief ?? "Butler deliverable",
      `Completed ${new Date(selected.at * 1000).toLocaleString()}`,
      `Paid $${formatUsdc(selected.totalUsdc)} USDC`,
      selected.plan?.reason ?? "",
      "",
    ].join("\n");
    downloadText(`${name}.txt`, `${header}${displaySummary || selected.summary || ""}`);
  };

  const handleDownloadJson = () => {
    if (!selected) return;
    const name = slugify(selected.brief ?? selected.id);
    downloadText(`${name}.json`, JSON.stringify(selected, null, 2), "application/json;charset=utf-8");
  };

  const handleCopy = async () => {
    const text = displaySummary || selected?.summary;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const docActions = selected ? (
    <>
      <button
        type="button"
        className="btn primary sm library-action-primary"
        onClick={handleDownloadPdf}
        disabled={exportingPdf}
      >
        <IconDownload size={14} />
        {exportingPdf ? "Preparing…" : "PDF"}
      </button>
      {displaySummary && (
        <button type="button" className="btn ghost sm" onClick={() => void handleCopy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <button type="button" className="btn ghost sm" onClick={handleDownloadTxt}>
        TXT
      </button>
      <button type="button" className="btn ghost sm" onClick={handleDownloadJson}>
        JSON
      </button>
    </>
  ) : null;

  return (
    <div
      className={`library-shell ${isMobile ? "library-shell--mobile" : ""} ${mobileDetail ? "library-shell--detail" : ""}`}
    >
      {!mobileDetail && (
      <header className="library-topbar">
        <div className="library-topbar-intro">
          <h1 className="library-title">Library</h1>
          <p className="library-subtitle">Your completed agent deliverables</p>
        </div>
        <div className="library-topbar-stats">
          <div className="library-stat-chip">
            <span className="library-stat-value">{items.length}</span>
            <span className="library-stat-label">docs</span>
          </div>
          <div className="library-stat-chip accent">
            <span className="library-stat-value">${formatUsdc(String(totalSpent))}</span>
            <span className="library-stat-label">spent</span>
          </div>
        </div>
      </header>
      )}

      <div className="library-workspace">
        <aside className={`library-sidebar ${mobileDetail ? "library-pane--hidden" : ""}`}>
          <div className="library-sidebar-tools">
            <label className="library-search">
              <IconSearch size={15} />
              <input
                type="search"
                placeholder="Search deliverables…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search deliverables"
              />
            </label>
            <button
              type="button"
              className="btn ghost sm library-icon-btn"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Refresh library"
            >
              <IconRefresh size={15} />
            </button>
          </div>

          {error && <p className="library-error">{error}</p>}

          {loading && items.length === 0 ? (
            <div className="library-skeleton-list" aria-hidden>
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="library-skeleton-item" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="library-sidebar-empty">
              <IconLibrary size={28} />
              <p>{query ? "No matches" : "No deliverables yet"}</p>
              <span className="muted">
                {query
                  ? "Try another search"
                  : "Completed tasks appear here after payment. Run a brief in Agent — full BTC theses target ~1 minute."}
              </span>
            </div>
          ) : (
            <ul className="library-list" role="listbox" aria-label="Deliverables">
              {filtered.map((job) => {
                const active = selected?.id === job.id;
                const strategy = strategyLabel(job.plan?.strategy);
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`library-list-item ${active ? "active" : ""}`}
                      onClick={() => pick(job)}
                    >
                      <div className="library-list-item-top">
                        <span className={`library-type-badge ${job.plan?.strategy ?? "direct"}`}>{strategy}</span>
                        <span className="library-list-time">{formatRelativeTime(job.at)}</span>
                      </div>
                      <p className="library-list-title">{listTitle(job)}</p>
                      <div className="library-list-item-foot">
                        <span className="library-list-price">${formatUsdc(job.totalUsdc)}</span>
                        <span className="library-list-agents">
                          {job.steps.filter((s) => s.status === "done").length || job.steps.length} agent
                          {(job.steps.filter((s) => s.status === "done").length || job.steps.length) === 1 ? "" : "s"}
                        </span>
                        {isMobile && <IconChevronRight size={16} className="library-list-chevron" aria-hidden />}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main
          className={`library-document ${isMobile && !selected ? "library-pane--hidden" : ""}`}
          aria-live="polite"
        >
          {!selected ? (
            !isMobile ? (
            <div className="library-placeholder">
              <div className="library-placeholder-icon">
                <IconLibrary size={32} />
              </div>
              <h2>Select a deliverable</h2>
              <p>Choose a completed task from the list to read the full report, research, or agent output.</p>
            </div>
            ) : null
          ) : (
            <>
              {mobileDetail && (
                <header className="library-mobile-nav">
                  <button
                    type="button"
                    className="library-mobile-back"
                    onClick={clearSelection}
                    aria-label="Back to library list"
                  >
                    <IconChevronLeft size={18} />
                    <span>Library</span>
                  </button>
                  <span className={`library-type-badge ${selected.plan?.strategy ?? "direct"}`}>
                    {strategyLabel(selected.plan?.strategy)}
                  </span>
                </header>
              )}

              <header className={`library-doc-toolbar ${mobileDetail ? "library-doc-toolbar--mobile" : ""}`}>
                <div className="library-doc-toolbar-main">
                  {!mobileDetail && (
                  <div className="library-doc-badges">
                    <span className={`library-type-badge lg ${selected.plan?.strategy ?? "direct"}`}>
                      {strategyLabel(selected.plan?.strategy)}
                    </span>
                    <span className="library-doc-paid">
                      <IconCheck size={12} /> Paid
                    </span>
                  </div>
                  )}
                  <p className="library-doc-toolbar-title">
                    {listTitle(selected)}
                  </p>
                  {mobileDetail && (
                    <p className="library-doc-toolbar-meta">
                      <span className="library-doc-paid inline">
                        <IconCheck size={12} /> Paid ${formatUsdc(selected.totalUsdc)}
                      </span>
                      <span className="library-doc-meta-dot" aria-hidden />
                      <span>{formatRelativeTime(selected.at)}</span>
                    </p>
                  )}
                </div>
                {!mobileDetail && (
                <div className="library-doc-actions">
                  {docActions}
                </div>
                )}
              </header>

              <div className="library-paper-canvas">
                <PaperDocument job={selected} ref={paperRef} payload={structuredPayload}>
                  <LibraryDocumentBody job={selected} />
                </PaperDocument>
              </div>

              {mobileDetail && docActions && (
                <footer className="library-mobile-actions">{docActions}</footer>
              )}

              {selected.steps.some((s) => s.settlementId) && (
                <footer className="library-doc-footer">
                  <details className="library-settlements">
                    <summary>Payment trace ({selected.steps.filter((s) => s.settlementId).length})</summary>
                    <table className="library-settlements-table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Amount</th>
                          <th>Settlement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.steps
                          .filter((s) => s.settlementId)
                          .map((s) => (
                            <tr key={s.agentId}>
                              <td>{s.label}</td>
                              <td className="mono">${formatUsdc(s.priceUsdc)}</td>
                              <td className="mono dim-cell">{s.settlementId}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </details>
                </footer>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

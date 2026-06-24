/** Library — completed agent deliverables and exports. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUsdc, getMarketplaceDeliverable, getMarketplaceDeliverables, type MarketplaceDeliverable } from "../api.ts";
import { IconCheck, IconDownload, IconLibrary, IconRefresh, IconSearch } from "../icons.tsx";
import { DeliverableSummary, CombinedDeliverableBody } from "./DeliverableContent.tsx";
import { combineWorkflowResult } from "./combine.ts";
import { formatWorkflowError } from "../format.ts";
import { PaperDocument, serializePaperForExport } from "./PaperDocument.tsx";
import { exportPaperPdf } from "./pdfExport.ts";
import { formatRelativeTime, strategyLabel } from "./utils.ts";
import { auditPaperTitle, isAuditDeliverable } from "./audit.ts";
import { billPaperTitle, isBillDeliverable } from "./bill.ts";

export function DeliverablesView({
  selectedId,
  onSelectId,
}: {
  selectedId?: string | null;
  onSelectId?: (id: string | null) => void;
}) {
  const [items, setItems] = useState<MarketplaceDeliverable[]>([]);
  const [selected, setSelected] = useState<MarketplaceDeliverable | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const paperRef = useRef<HTMLElement>(null);

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
  }, [loadList]);

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
    setSelected(job);
    onSelectId?.(job.id);
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
  const displaySummary = useMemo(() => {
    if (!selected) return "";
    if (selected.summary?.trim()) return selected.summary;
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
  }, [selected, doneSteps]);
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

  return (
    <div className="library-shell">
      <header className="library-topbar">
        <div className="library-topbar-intro">
          <h1 className="library-title">Library</h1>
          <p className="library-subtitle">Deliverables from paid agent work</p>
        </div>
        <div className="library-topbar-stats">
          <div className="library-stat">
            <span className="library-stat-value">{items.length}</span>
            <span className="library-stat-label">Documents</span>
          </div>
          <div className="library-stat">
            <span className="library-stat-value">${formatUsdc(String(totalSpent))}</span>
            <span className="library-stat-label">Total spent</span>
          </div>
        </div>
      </header>

      <div className="library-workspace">
        <aside className="library-sidebar">
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
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main className="library-document" aria-live="polite">
          {!selected ? (
            <div className="library-placeholder">
              <div className="library-placeholder-icon">
                <IconLibrary size={32} />
              </div>
              <h2>Select a deliverable</h2>
              <p>Choose a completed task from the list to read the full report, research, or agent output.</p>
            </div>
          ) : (
            <>
              <header className="library-doc-toolbar">
                <div className="library-doc-toolbar-main">
                  <div className="library-doc-badges">
                    <span className={`library-type-badge lg ${selected.plan?.strategy ?? "direct"}`}>
                      {strategyLabel(selected.plan?.strategy)}
                    </span>
                    {selected.plan?.router === "openai" && <span className="library-type-badge lg ai">AI routed</span>}
                    <span className="library-doc-paid">
                      <IconCheck size={12} /> Paid
                    </span>
                  </div>
                  <p className="library-doc-toolbar-title">
                    {selected ? listTitle(selected) : "Deliverable"}
                  </p>
                </div>
                <div className="library-doc-actions">
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={handleDownloadPdf}
                    disabled={exportingPdf}
                  >
                    <IconDownload size={14} />
                    {exportingPdf ? "Preparing…" : "Download PDF"}
                  </button>
                  {displaySummary && (
                    <button type="button" className="btn ghost sm" onClick={() => void handleCopy()}>
                      {copied ? "Copied" : "Copy text"}
                    </button>
                  )}
                  <button type="button" className="btn ghost sm" onClick={handleDownloadTxt}>
                    TXT
                  </button>
                  <button type="button" className="btn ghost sm" onClick={handleDownloadJson}>
                    JSON
                  </button>
                </div>
              </header>

              <div className="library-paper-canvas">
                <PaperDocument job={selected} ref={paperRef}>
                  {doneSteps.length > 0 ? (
                    <CombinedDeliverableBody steps={doneSteps} brief={selected.brief} />
                  ) : selected.summary ? (
                    <DeliverableSummary text={selected.summary} />
                  ) : (
                    <p className="paper-prose paper-empty">No structured output was stored for this job.</p>
                  )}
                </PaperDocument>
              </div>

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

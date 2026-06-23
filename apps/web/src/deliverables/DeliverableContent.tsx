import type { CSSProperties, ReactNode } from "react";
import { AGENT_COLORS, agentInitials } from "./utils.ts";
import { unwrapAgentPayload } from "./format.ts";
import { combineWorkflowResult } from "./combine.ts";

function ReportBlock({ data }: { data: Record<string, unknown> }) {
  const report = data.report as Record<string, unknown> | undefined;
  if (!report) return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">
        {typeof report.title === "string" ? report.title : "Investment Report"}
      </h2>
      {(report.rating != null || report.target != null) && (
        <p className="paper-inline-meta">
          {typeof report.rating === "string" && <span>Rating: {report.rating}</span>}
          {typeof report.target === "string" && <span>Target: {report.target}</span>}
          {typeof report.generatedAt === "string" && (
            <span>
              {new Date(report.generatedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          )}
        </p>
      )}
      {typeof report.summary === "string" && <p className="paper-prose">{report.summary}</p>}
    </section>
  );
}

function HeadlinesBlock({ data }: { data: Record<string, unknown> }) {
  const headlines = data.headlines;
  if (!Array.isArray(headlines)) return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">
        Headlines{data.ticker ? ` — ${String(data.ticker)}` : ""}
      </h2>
      <ol className="paper-numbered-list">
        {headlines.map((h, i) => {
          const row = h as Record<string, unknown>;
          return (
            <li key={i}>
              <strong>{String(row.title ?? "Headline")}</strong>
              {row.source ? <span className="paper-ref-meta"> — {String(row.source)}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function MarketBlock({ data }: { data: Record<string, unknown> }) {
  if (typeof data.symbol !== "string" || data.price == null) return null;
  const change = Number(data.change24h);
  const positive = !Number.isNaN(change) && change >= 0;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Market Snapshot</h2>
      <div className="paper-stat-grid">
        <div className="paper-stat">
          <span className="paper-stat-label">Symbol</span>
          <span className="paper-stat-value">{data.symbol}</span>
        </div>
        <div className="paper-stat">
          <span className="paper-stat-label">Price</span>
          <span className="paper-stat-value">${String(data.price)}</span>
        </div>
        <div className="paper-stat">
          <span className="paper-stat-label">24h Change</span>
          <span className={`paper-stat-value ${positive ? "up" : "down"}`}>
            {positive ? "+" : ""}
            {String(data.change24h ?? "?")}%
          </span>
        </div>
        <div className="paper-stat">
          <span className="paper-stat-label">Volume</span>
          <span className="paper-stat-value">{String(data.volume ?? "—")}</span>
        </div>
      </div>
    </section>
  );
}

function ResearchBlock({ data }: { data: Record<string, unknown> }) {
  const papers = data.papers;
  if (!Array.isArray(papers)) return null;
  const isFull = data.type === "research" || typeof data.executiveSummary === "string";
  const focus = data.focus ? String(data.focus) : null;

  return (
    <>
      {isFull && typeof data.executiveSummary === "string" && (
        <section className="paper-section">
          <h2 className="paper-section-title">
            {focus ? `1. Executive Summary — ${focus}` : "1. Executive Summary"}
          </h2>
          <p className="paper-prose">{data.executiveSummary}</p>
        </section>
      )}

      {isFull && Array.isArray(data.keyFindings) && data.keyFindings.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-section-title">2. Key Findings</h2>
          <ol className="paper-numbered-list">
            {(data.keyFindings as string[]).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>
        </section>
      )}

      <section className="paper-section">
        <h2 className="paper-section-title">
          {isFull ? "3. References" : "References"} ({papers.length})
        </h2>
        <div className="paper-refs">
          {papers.map((p, i) => {
            const row = p as Record<string, unknown>;
            return (
              <article key={i} className="paper-ref">
                <p className="paper-ref-title">
                  [{i + 1}] {String(row.title ?? "Paper")}
                </p>
                <p className="paper-ref-meta">
                  {[row.authors, row.venue, row.year].filter(Boolean).join(". ")}
                  {row.citationCount != null ? ` · ${String(row.citationCount)} citations` : ""}
                  {row.relevance != null
                    ? ` · Relevance: ${Math.round(Number(row.relevance) * 100)}%`
                    : ""}
                </p>
                {typeof row.abstract === "string" && (
                  <p className="paper-ref-abstract">{row.abstract}</p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {isFull && Array.isArray(data.risks) && data.risks.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-section-title">4. Risk Assessment</h2>
          <ul className="paper-bullet-list">
            {(data.risks as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {isFull && typeof data.methodology === "string" && (
        <section className="paper-section paper-methodology">
          <h2 className="paper-section-title">Methodology</h2>
          <p className="paper-prose paper-prose-muted">{data.methodology}</p>
        </section>
      )}
    </>
  );
}

function SentimentBlock({ data }: { data: Record<string, unknown> }) {
  if (typeof data.score !== "number" || typeof data.label !== "string") return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Sentiment Analysis</h2>
      <p className="paper-prose">
        <strong>{data.label}</strong> (score {data.score}
        {data.sources != null ? `, based on ${String(data.sources)} sources` : ""})
      </p>
    </section>
  );
}

function AuditBlock({ data }: { data: Record<string, unknown> }) {
  if (typeof data.contract !== "string") return null;
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Security Audit</h2>
      <p className="paper-inline-meta mono">{data.contract}</p>
      {data.riskLevel != null && (
        <p className="paper-prose">
          <strong>Risk level:</strong> {String(data.riskLevel)}
        </p>
      )}
      {findings.length > 0 && (
        <ol className="paper-numbered-list">
          {findings.map((f, i) => (
            <li key={i}>{typeof f === "object" ? JSON.stringify(f) : String(f)}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ChartBlock({ data }: { data: Record<string, unknown> }) {
  if (typeof data.pattern !== "string") return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Technical Analysis</h2>
      <table className="paper-table">
        <tbody>
          <tr>
            <th>Pattern</th>
            <td>{data.pattern}</td>
          </tr>
          <tr>
            <th>Support</th>
            <td>{String(data.support)}</td>
          </tr>
          <tr>
            <th>Resistance</th>
            <td>{String(data.resistance)}</td>
          </tr>
          <tr>
            <th>RSI</th>
            <td>{String(data.rsi)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function renderPayload(data: Record<string, unknown>) {
  const blocks: ReactNode[] = [];
  if (data.report && typeof data.report === "object") blocks.push(<ReportBlock key="report" data={data} />);
  if (Array.isArray(data.headlines)) blocks.push(<HeadlinesBlock key="headlines" data={data} />);
  if (typeof data.symbol === "string" && data.price != null) blocks.push(<MarketBlock key="market" data={data} />);
  if (Array.isArray(data.papers)) blocks.push(<ResearchBlock key="research" data={data} />);
  if (typeof data.score === "number" && typeof data.label === "string")
    blocks.push(<SentimentBlock key="sentiment" data={data} />);
  if (typeof data.contract === "string") blocks.push(<AuditBlock key="audit" data={data} />);
  if (typeof data.pattern === "string") blocks.push(<ChartBlock key="chart" data={data} />);
  return blocks.length > 0 ? blocks : null;
}

/** One unified document from all agent step outputs (no per-agent section headers). */
export function CombinedDeliverableBody({ steps }: { steps: { output?: unknown }[] }) {
  const merged = combineWorkflowResult(steps);
  if (!merged) {
    return <p className="paper-prose paper-empty">No structured output was stored for this job.</p>;
  }

  const blocks: ReactNode[] = [];
  if (typeof merged.symbol === "string" && merged.price != null) {
    blocks.push(<MarketBlock key="market" data={merged} />);
  }
  if (Array.isArray(merged.headlines)) blocks.push(<HeadlinesBlock key="headlines" data={merged} />);
  if (typeof merged.score === "number" && typeof merged.label === "string") {
    blocks.push(<SentimentBlock key="sentiment" data={merged} />);
  }
  if (Array.isArray(merged.papers)) blocks.push(<ResearchBlock key="research" data={merged} />);
  if (typeof merged.pattern === "string") blocks.push(<ChartBlock key="chart" data={merged} />);
  if (merged.report && typeof merged.report === "object") blocks.push(<ReportBlock key="report" data={merged} />);
  if (typeof merged.contract === "string") blocks.push(<AuditBlock key="audit" data={merged} />);

  return (
    <div className="paper-sections paper-unified">
      {blocks.length > 0 ? blocks : <pre className="paper-raw">{JSON.stringify(merged, null, 2)}</pre>}
    </div>
  );
}

export function DeliverableStepContent({
  label,
  agentId,
  output,
  index,
  total,
}: {
  label: string;
  agentId?: string;
  output: unknown;
  index: number;
  total: number;
}) {
  const data = unwrapAgentPayload(output);
  const color = (agentId && AGENT_COLORS[agentId]) || "#71717a";

  const body = !data ? (
    <pre className="paper-raw">{JSON.stringify(output, null, 2)}</pre>
  ) : (
    renderPayload(data) ?? <pre className="paper-raw">{JSON.stringify(data, null, 2)}</pre>
  );

  return (
    <section className="paper-agent-section">
      <header className="paper-agent-head">
        <span className="lib-step-avatar" style={{ "--step-color": color } as CSSProperties} data-export-hide>
          {agentInitials(label)}
        </span>
        <div>
          <p className="paper-step-label">
            Section {index + 1} of {total}
          </p>
          <h2 className="paper-agent-title">{label}</h2>
        </div>
      </header>
      <div className="paper-agent-body">{body}</div>
    </section>
  );
}

export function DeliverableSummary({ text }: { text: string }) {
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Summary</h2>
      <div className="paper-prose paper-summary-text">{text}</div>
    </section>
  );
}

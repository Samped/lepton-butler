import type { CSSProperties, ReactNode } from "react";
import { AGENT_COLORS, agentInitials } from "./utils.ts";
import { unwrapAgentPayload } from "./format.ts";
import { combineWorkflowResult } from "./combine.ts";
import {
  auditSeverityClass,
  contractNameFromSource,
  resolveAuditContractSource,
} from "./audit.ts";
import {
  billRequestText,
  formatBillCurrency,
  formatBillDueDate,
  isUtilityBillPayload,
} from "./bill.ts";

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
        Top Headlines{data.topic ? ` — ${String(data.topic)}` : data.ticker ? ` — ${String(data.ticker)}` : ""}
      </h2>
      <ol className="paper-numbered-list">
        {headlines.map((h, i) => {
          const row = h as Record<string, unknown>;
          const url = typeof row.url === "string" ? row.url : null;
          return (
            <li key={i}>
              <strong>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {String(row.title ?? "Headline")}
                  </a>
                ) : (
                  String(row.title ?? "Headline")
                )}
              </strong>
              {row.source ? <span className="paper-ref-meta"> — {String(row.source)}</span> : null}
              {row.publishedAt ? (
                <span className="paper-ref-meta"> · {new Date(String(row.publishedAt)).toLocaleString()}</span>
              ) : null}
              {typeof row.traderImpact === "string" && (
                <p className="paper-prose" style={{ marginTop: "0.35rem" }}>
                  {row.traderImpact}
                </p>
              )}
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

      {isFull && Array.isArray(data.limitations) && data.limitations.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-section-title">4. Limitations</h2>
          <ul className="paper-bullet-list">
            {(data.limitations as string[]).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      )}

      {isFull && Array.isArray(data.risks) && data.risks.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-section-title">{Array.isArray(data.limitations) && data.limitations.length > 0 ? "5" : "4"}. Risk Assessment</h2>
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

function AuditContractPanel({ source }: { source: string }) {
  const name = contractNameFromSource(source);
  return (
    <div className="audit-contract-panel">
      <div className="audit-contract-panel-head">
        <h3 className="audit-contract-panel-title">Contract under review</h3>
        {name ? <span className="audit-contract-name">{name}</span> : null}
      </div>
      <div className="audit-contract-scroll" tabIndex={0} aria-label="Solidity source code">
        <pre className="audit-contract-code">{source}</pre>
      </div>
    </div>
  );
}

function AuditBlock({
  data,
  contractSource,
}: {
  data: Record<string, unknown>;
  contractSource?: string | null;
}) {
  if (data.type !== "audit" && typeof data.contract !== "string" && !Array.isArray(data.findings)) return null;
  const findings = Array.isArray(data.findings) ? (data.findings as Record<string, unknown>[]) : [];
  const contractName = typeof data.contract === "string" ? data.contract : "Smart contract";
  const source = contractSource ?? resolveAuditContractSource(undefined, data);

  return (
    <section className="paper-section audit-deliverable">
      {source ? <AuditContractPanel source={source} /> : null}

      <div className="audit-results">
        <h2 className="paper-section-title">Findings — {contractName}</h2>
        {typeof data.summary === "string" && (
          <p className="paper-prose audit-executive-summary">{data.summary}</p>
        )}
        {data.riskLevel != null && (
          <p className="paper-prose audit-risk-level">
            <strong>Overall risk:</strong> {String(data.riskLevel)}
          </p>
        )}
        {findings.length > 0 && (
          <ol className="audit-findings-list">
            {findings.map((f, i) => (
              <li key={i} className="audit-finding">
                {f.severity ? (
                  <span className={`audit-severity ${auditSeverityClass(f.severity)}`}>
                    {String(f.severity).toUpperCase()}
                  </span>
                ) : null}
                <div className="audit-finding-body">
                  <p className="audit-finding-title">{String(f.title ?? "Finding")}</p>
                  {f.detail ? <p className="audit-finding-detail">{String(f.detail)}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function OnchainBlock({ data }: { data: Record<string, unknown> }) {
  if (data.type !== "onchain" && !Array.isArray(data.signals)) return null;
  const market = data.marketContext as Record<string, unknown> | undefined;
  const signals = Array.isArray(data.signals) ? (data.signals as Record<string, unknown>[]) : [];

  return (
    <section className="paper-section">
      <h2 className="paper-section-title">On-Chain Analysis{data.asset ? ` — ${String(data.asset)}` : ""}</h2>
      {market?.price != null && (
        <p className="paper-inline-meta">
          Spot ${String(market.price)} ({String(market.change24h ?? "?")}% 24h)
        </p>
      )}
      {typeof data.summary === "string" && <p className="paper-prose">{data.summary}</p>}
      {typeof data.exchangeFlows === "string" && (
        <>
          <h3 className="paper-section-subtitle">Exchange flows</h3>
          <p className="paper-prose">{data.exchangeFlows}</p>
        </>
      )}
      {typeof data.whaleActivity === "string" && (
        <>
          <h3 className="paper-section-subtitle">Whale activity</h3>
          <p className="paper-prose">{data.whaleActivity}</p>
        </>
      )}
      {typeof data.networkActivity === "string" && (
        <>
          <h3 className="paper-section-subtitle">Network activity</h3>
          <p className="paper-prose">{data.networkActivity}</p>
        </>
      )}
      {typeof data.holderTrends === "string" && (
        <>
          <h3 className="paper-section-subtitle">Holder trends</h3>
          <p className="paper-prose">{data.holderTrends}</p>
        </>
      )}
      {typeof data.outlook7d === "string" && (
        <>
          <h3 className="paper-section-subtitle">7-day outlook</h3>
          <p className="paper-prose">{data.outlook7d}</p>
        </>
      )}
      {signals.length > 0 && (
        <>
          <h3 className="paper-section-subtitle">Signals</h3>
          <ul className="paper-bullet-list">
            {signals.map((s, i) => (
              <li key={i}>
                <strong>{String(s.label ?? "Signal")}</strong> ({String(s.direction ?? "neutral")}):{" "}
                {String(s.detail ?? "")}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function BillRequestPanel({ text }: { text: string }) {
  return (
    <div className="bill-request-panel">
      <div className="bill-request-panel-head">
        <h3 className="bill-request-panel-title">Your request</h3>
      </div>
      <div className="bill-request-scroll" tabIndex={0} aria-label="Bill quote request">
        <p className="bill-request-text">{text}</p>
      </div>
    </div>
  );
}

function BillBlock({
  data,
  requestText,
}: {
  data: Record<string, unknown>;
  requestText?: string | null;
}) {
  if (!isUtilityBillPayload(data)) return null;

  const provider = String(data.provider ?? "Utility provider");
  const amountDue = formatBillCurrency(data.amountDue);
  const dueDate = formatBillDueDate(data.dueDate);
  const lineItems = Array.isArray(data.lineItems) ? (data.lineItems as Record<string, unknown>[]) : [];
  const request = requestText ?? billRequestText(undefined, data);

  return (
    <section className="paper-section bill-deliverable">
      {request ? <BillRequestPanel text={request} /> : null}

      <div className="bill-quote-card">
        <header className="bill-quote-header">
          <div>
            <p className="bill-quote-label">Estimated bill</p>
            <h2 className="bill-quote-provider">{provider}</h2>
          </div>
          <div className="bill-quote-amount-block">
            <span className="bill-quote-amount">{amountDue}</span>
            <span className="bill-quote-due">Due {dueDate}</span>
          </div>
        </header>

        {lineItems.length > 0 && (
          <div className="bill-line-items">
            <h3 className="bill-line-items-title">Line items</h3>
            <table className="bill-line-items-table">
              <thead>
                <tr>
                  <th scope="col">Charge</th>
                  <th scope="col" className="bill-col-amount">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, i) => (
                  <tr key={i}>
                    <td>{String(item.label ?? "Charge")}</td>
                    <td className="bill-col-amount">{formatBillCurrency(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total due</th>
                  <td className="bill-col-amount bill-total">{amountDue}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {typeof data.notes === "string" && data.notes.trim() && (
          <footer className="bill-quote-notes">
            <p className="bill-notes-label">Notes & assumptions</p>
            <p className="bill-notes-text">{data.notes}</p>
          </footer>
        )}
      </div>
    </section>
  );
}

function ChartBlock({ data }: { data: Record<string, unknown> }) {
  if (typeof data.pattern !== "string" && data.type !== "technical-analysis") return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">
        Technical Analysis{data.symbol ? ` — ${String(data.symbol)}` : ""}
      </h2>
      {typeof data.summary === "string" && <p className="paper-prose">{data.summary}</p>}
      <table className="paper-table">
        <tbody>
          {data.bias ? (
            <tr>
              <th>Bias</th>
              <td>{String(data.bias)}</td>
            </tr>
          ) : null}
          <tr>
            <th>Pattern</th>
            <td>{String(data.pattern ?? "—")}</td>
          </tr>
          <tr>
            <th>Support</th>
            <td>{data.support != null ? `$${data.support}` : "—"}</td>
          </tr>
          <tr>
            <th>Resistance</th>
            <td>{data.resistance != null ? `$${data.resistance}` : "—"}</td>
          </tr>
          <tr>
            <th>RSI</th>
            <td>{String(data.rsi ?? "—")}</td>
          </tr>
        </tbody>
      </table>
      {Array.isArray(data.keyLevels) && data.keyLevels.length > 0 && (
        <>
          <h3 className="paper-section-subtitle">Key levels</h3>
          <ul className="paper-bullet-list">
            {(data.keyLevels as string[]).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      )}
      {Array.isArray(data.catalysts) && data.catalysts.length > 0 && (
        <>
          <h3 className="paper-section-subtitle">Catalysts</h3>
          <ul className="paper-bullet-list">
            {(data.catalysts as string[]).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function renderPayload(data: Record<string, unknown>) {
  const blocks: ReactNode[] = [];
  if (data.report && typeof data.report === "object") blocks.push(<ReportBlock key="report" data={data} />);
  if (Array.isArray(data.headlines)) blocks.push(<HeadlinesBlock key="headlines" data={data} />);
  if (data.type === "onchain" || Array.isArray(data.signals)) {
    blocks.push(<OnchainBlock key="onchain" data={data} />);
  } else if (typeof data.symbol === "string" && data.price != null) {
    blocks.push(<MarketBlock key="market" data={data} />);
  }
  if (Array.isArray(data.papers)) blocks.push(<ResearchBlock key="research" data={data} />);
  if (typeof data.score === "number" && typeof data.label === "string")
    blocks.push(<SentimentBlock key="sentiment" data={data} />);
  if (typeof data.contract === "string" || data.type === "audit" || Array.isArray(data.findings)) {
    blocks.push(<AuditBlock key="audit" data={data} contractSource={resolveAuditContractSource(undefined, data)} />);
  }
  if (isUtilityBillPayload(data)) {
    blocks.push(<BillBlock key="bill" data={data} requestText={billRequestText(undefined, data)} />);
  }
  if (data.type === "technical-analysis" || (typeof data.pattern === "string" && !Array.isArray(data.papers))) {
    blocks.push(<ChartBlock key="chart" data={data} />);
  }
  return blocks.length > 0 ? blocks : null;
}

function MacroBlock({ data }: { data: Record<string, unknown> }) {
  if (data.type !== "macro" && typeof data.fedOutlook !== "string") return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">Macro Outlook</h2>
      {typeof data.summary === "string" && <p className="paper-prose">{data.summary}</p>}
      {typeof data.fedOutlook === "string" && (
        <p className="paper-prose">
          <strong>Fed:</strong> {data.fedOutlook}
        </p>
      )}
    </section>
  );
}

function DefiBlock({ data }: { data: Record<string, unknown> }) {
  if (data.type !== "defi" && !Array.isArray(data.topProtocols)) return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">DeFi Context</h2>
      {typeof data.summary === "string" && <p className="paper-prose">{data.summary}</p>}
    </section>
  );
}

function RiskBlock({ data }: { data: Record<string, unknown> }) {
  if (data.type !== "risk" && typeof data.riskScore !== "number") return null;
  return (
    <section className="paper-section">
      <h2 className="paper-section-title">
        Risk Assessment{data.riskLabel ? ` — ${String(data.riskLabel)}` : ""}
      </h2>
      {typeof data.summary === "string" && <p className="paper-prose">{data.summary}</p>}
    </section>
  );
}

/** One unified document from all agent step outputs (no per-agent section headers). */
export function CombinedDeliverableBody({
  steps,
  brief,
}: {
  steps: { output?: unknown }[];
  brief?: string;
}) {
  const merged = combineWorkflowResult(steps);
  if (!merged) {
    return <p className="paper-prose paper-empty">No structured output was stored for this job.</p>;
  }

  const contractSource = resolveAuditContractSource(brief, merged);
  const billRequest = billRequestText(brief, merged);

  const onchain = merged.onchain as Record<string, unknown> | undefined;
  const defi = merged.defi as Record<string, unknown> | undefined;
  const macro = merged.macro as Record<string, unknown> | undefined;
  const risk = merged.risk as Record<string, unknown> | undefined;
  const chartData =
    merged.pattern != null || merged.type === "technical-analysis"
      ? merged
      : null;

  const blocks: ReactNode[] = [];
  if (merged.report && typeof merged.report === "object") blocks.push(<ReportBlock key="report" data={merged} />);
  if (typeof merged.symbol === "string" && merged.price != null) {
    blocks.push(<MarketBlock key="market" data={merged} />);
  }
  if (Array.isArray(merged.headlines)) blocks.push(<HeadlinesBlock key="headlines" data={merged} />);
  if (typeof merged.score === "number" && typeof merged.label === "string") {
    blocks.push(<SentimentBlock key="sentiment" data={merged} />);
  }
  if (onchain) blocks.push(<OnchainBlock key="onchain" data={onchain} />);
  if (chartData) blocks.push(<ChartBlock key="chart" data={chartData} />);
  if (defi) blocks.push(<DefiBlock key="defi" data={defi} />);
  if (macro) blocks.push(<MacroBlock key="macro" data={macro} />);
  if (Array.isArray(merged.papers)) blocks.push(<ResearchBlock key="research" data={merged} />);
  if (risk) blocks.push(<RiskBlock key="risk" data={risk} />);
  if (typeof merged.contract === "string" || merged.type === "audit" || Array.isArray(merged.findings)) {
    blocks.push(<AuditBlock key="audit" data={merged} contractSource={contractSource} />);
  }
  if (isUtilityBillPayload(merged)) {
    blocks.push(<BillBlock key="bill" data={merged} requestText={billRequest} />);
  }

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

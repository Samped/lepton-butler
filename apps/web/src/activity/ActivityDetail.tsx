import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  decodeBatch,
  formatUsdc,
  getBatchTx,
  getSettlement,
  shortAddr,
  type BatchDecode,
  type BatchTxResult,
  type SpendRecord,
} from "../api.ts";
import { AgentIcon } from "../components.tsx";
import { IconClose } from "../icons.tsx";

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="activity-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

export function ActivityDetail({
  record,
  serviceLabel,
  sellerAddress,
  isMobile,
  onClose,
  onOpenTrace,
}: {
  record: SpendRecord;
  serviceLabel: string;
  sellerAddress?: string;
  isMobile: boolean;
  onClose: () => void;
  onOpenTrace: (settlementId: string) => void;
}) {
  const [settlement, setSettlement] = useState<unknown>(null);
  const [batch, setBatch] = useState<BatchTxResult | null>(null);
  const [decoded, setDecoded] = useState<BatchDecode | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const traceId = record.settlementId ?? record.txHash;

  const runTrace = useCallback(async () => {
    const id = traceId?.trim();
    if (!id) return;
    setTraceLoading(true);
    setTraceError(null);
    setSettlement(null);
    setBatch(null);
    setDecoded(null);
    try {
      if (id.startsWith("0x") && id.length >= 66) {
        const d = await decodeBatch(id);
        setDecoded(d);
        setBatch({ batchTx: id, status: "on-chain" });
        setSettlement({ type: "on-chain", txHash: id });
        return;
      }
      const s = await getSettlement(id);
      setSettlement(s);
      const b = await getBatchTx(id);
      setBatch(b);
      if (b.batchTx) {
        setDecoded(await decodeBatch(b.batchTx));
      }
    } catch (e) {
      setTraceError(e instanceof Error ? e.message : "Trace failed");
    } finally {
      setTraceLoading(false);
    }
  }, [traceId]);

  useEffect(() => {
    if (traceId) void runTrace();
  }, [traceId, runTrace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sellerDelta = decoded?.entries.find(
    (e) => sellerAddress && e.address.toLowerCase() === sellerAddress.toLowerCase()
  );

  const body = (
    <>
      <header className="activity-detail-head">
        <div className="activity-detail-title">
          <AgentIcon role={record.agent} />
          <div>
            <h2>{serviceLabel}</h2>
            <p className="muted small">{new Date(record.at * 1000).toLocaleString()}</p>
          </div>
        </div>
        <button type="button" className="activity-detail-close" onClick={onClose} aria-label="Close">
          <IconClose size={18} />
        </button>
      </header>

      <div className="activity-detail-body">
        <dl className="activity-detail-grid">
          <DetailRow label="Amount">
            <strong className="activity-detail-amount">${formatUsdc(record.amountUsdc)} USDC</strong>
          </DetailRow>
          <DetailRow label="Status">
            <span className={`pill ${record.status}`}>{record.status}</span>
          </DetailRow>
          <DetailRow label="Agent">
            <span className="capitalize">{record.agent}</span>
          </DetailRow>
          <DetailRow label="Category">
            <span className="capitalize">{record.category}</span>
          </DetailRow>
          <DetailRow label="Merchant ID">
            <code>{record.merchantId}</code>
          </DetailRow>
          <DetailRow label="Initiator">
            {record.initiator ?? "—"}
          </DetailRow>
          {record.payerAddress && (
            <DetailRow label="Payer">
              <code title={record.payerAddress}>{record.payerAddress}</code>
              <button type="button" className="link-btn sm" onClick={() => copyText(record.payerAddress!)}>
                Copy
              </button>
            </DetailRow>
          )}
          {record.executorAddress && (
            <DetailRow label="Executor">
              <code title={record.executorAddress}>{record.executorAddress}</code>
              <button type="button" className="link-btn sm" onClick={() => copyText(record.executorAddress!)}>
                Copy
              </button>
            </DetailRow>
          )}
          {record.settlementId && (
            <DetailRow label="Settlement ID">
              <code className="activity-detail-mono" title={record.settlementId}>
                {record.settlementId}
              </code>
              <button type="button" className="link-btn sm" onClick={() => copyText(record.settlementId!)}>
                Copy
              </button>
            </DetailRow>
          )}
          {record.txHash && (
            <DetailRow label="Tx hash">
              <code title={record.txHash}>{record.txHash}</code>
              <a
                href={`https://testnet.arcscan.app/tx/${record.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="link-btn sm"
              >
                Arcscan
              </a>
            </DetailRow>
          )}
          {record.reason && (
            <DetailRow label="Reason">
              <span className="activity-detail-reason">{record.reason}</span>
            </DetailRow>
          )}
          <DetailRow label="Record ID">
            <code className="muted small">{record.id}</code>
          </DetailRow>
        </dl>

        {traceId && (
          <section className="activity-detail-trace">
            <div className="activity-detail-trace-head">
              <h3>On-chain trace</h3>
              <div className="activity-detail-trace-actions">
                <button type="button" className="btn ghost sm" disabled={traceLoading} onClick={() => void runTrace()}>
                  {traceLoading ? "Loading…" : "Refresh"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => onOpenTrace(traceId)}
                >
                  Open Trace tab
                </button>
              </div>
            </div>

            {traceLoading && <p className="muted small">Fetching Gateway settlement and batch tx…</p>}
            {traceError && <p className="activity-detail-error">{traceError}</p>}

            {batch?.batchTx && (
              <div className="activity-detail-batch">
                <span className="muted small">Batch tx</span>
                <code>{shortAddr(batch.batchTx)}</code>
                <a
                  href={`https://testnet.arcscan.app/tx/${batch.batchTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn ghost sm"
                >
                  View on Arcscan
                </a>
              </div>
            )}

            {decoded && (
              <div className="activity-detail-decode">
                <span className="muted small">USDC movements · block {decoded.blockNumber}</span>
                <table className="trace-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Δ USDC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decoded.entries.map((e) => (
                      <tr key={e.address}>
                        <td>
                          <code>{shortAddr(e.address)}</code>
                        </td>
                        <td className={Number(e.usdc) >= 0 ? "positive" : "negative"}>{e.usdc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sellerAddress && (
                  <p className="trace-seller muted small">
                    Seller {shortAddr(sellerAddress)}:{" "}
                    {sellerDelta ? (
                      <strong>+{sellerDelta.usdc} USDC</strong>
                    ) : (
                      "not in this batch"
                    )}
                  </p>
                )}
              </div>
            )}

            {settlement != null && !traceLoading && (
              <details className="trace-details">
                <summary>Gateway settlement (raw)</summary>
                <pre>{JSON.stringify(settlement, null, 2)}</pre>
              </details>
            )}
          </section>
        )}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <button type="button" className="activity-detail-backdrop" aria-label="Close" onClick={onClose} />
        <div className="activity-detail-sheet" role="dialog" aria-label="Payment details">
          <div className="activity-detail-handle" aria-hidden />
          {body}
        </div>
      </>
    );
  }

  return (
    <div className="activity-detail-modal" role="dialog" aria-label="Payment details">
      <button type="button" className="activity-detail-backdrop" aria-label="Close" onClick={onClose} />
      <div className="activity-detail-card">{body}</div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { decodeBatch, getBatchTx, getSettlement, type BatchDecode, type BatchTxResult } from "../api.ts";
import { Panel } from "../components.tsx";

const STEPS = [
  { id: 1, title: "x402 payment", desc: "Agent pays merchant; Gateway records settlement" },
  { id: 2, title: "Settlement status", desc: "Query Circle Gateway transfer" },
  { id: 3, title: "Batch transaction", desc: "Resolve on-chain Arc batch tx" },
  { id: 4, title: "Decode batch", desc: "USDC balance deltas per address" },
  { id: 5, title: "Seller receipt", desc: "Confirm seller received USDC" },
  { id: 6, title: "On-chain proof", desc: "Explorer link + block number" },
] as const;

export function PaymentTrace({ initialId = "", sellerAddress }: { initialId?: string; sellerAddress?: string }) {
  const [settlementId, setSettlementId] = useState(initialId);
  const [step, setStep] = useState(0);
  const [settlement, setSettlement] = useState<unknown>(null);
  const [batch, setBatch] = useState<BatchTxResult | null>(null);
  const [decoded, setDecoded] = useState<BatchDecode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialId) setSettlementId(initialId);
  }, [initialId]);

  const runTrace = useCallback(async () => {
    const id = settlementId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setStep(1);
    setSettlement(null);
    setBatch(null);
    setDecoded(null);
    try {
      // Direct on-chain tx hashes (0x…) skip Gateway settlement lookup.
      if (id.startsWith("0x") && id.length >= 66) {
        const d = await decodeBatch(id);
        setDecoded(d);
        setBatch({ batchTx: id, status: "on-chain" });
        setSettlement({ type: "on-chain", txHash: id });
        setStep(6);
        return;
      }

      const s = await getSettlement(id);
      setSettlement(s);
      setStep(2);

      const b = await getBatchTx(id);
      setBatch(b);
      setStep(3);

      if (b.batchTx) {
        const d = await decodeBatch(b.batchTx);
        setDecoded(d);
        setStep(6);
      } else {
        setStep(3);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trace failed");
    } finally {
      setLoading(false);
    }
  }, [settlementId]);

  const sellerDelta = decoded?.entries.find(
    (e) => sellerAddress && e.address.toLowerCase() === sellerAddress.toLowerCase()
  );

  return (
    <div className="trace-panel">
      <Panel title="Arc 101 payment trace" desc="circle-agent compatible — settlement → batch tx → decode">
        <p className="muted trace-intro">
          Paste a settlement ID from the Activity ledger after running the agent. Butler calls the same Gateway + decode
          APIs as the{" "}
          <a href="https://github.com/the-canteen-dev/circle-agent" target="_blank" rel="noreferrer">
            circle-agent
          </a>{" "}
          Arc 101 companion.
        </p>

        <div className="trace-input-row">
          <input
            type="text"
            className="trace-input"
            placeholder="Settlement UUID from ledger"
            value={settlementId}
            onChange={(e) => setSettlementId(e.target.value)}
          />
          <button type="button" className="btn primary" disabled={loading || !settlementId.trim()} onClick={runTrace}>
            {loading ? "Tracing…" : "Trace payment"}
          </button>
        </div>

        {error && <div className="trace-error">{error}</div>}

        <ol className="trace-steps">
          {STEPS.map((s) => (
            <li key={s.id} className={`trace-step ${step >= s.id ? "done" : ""} ${step === s.id ? "current" : ""}`}>
              <span className="trace-step-num">{s.id}</span>
              <div>
                <strong>{s.title}</strong>
                <span className="muted">{s.desc}</span>
              </div>
            </li>
          ))}
        </ol>

        {settlement != null && (
          <details className="trace-details" open>
            <summary>Settlement (Gateway)</summary>
            <pre>{JSON.stringify(settlement, null, 2)}</pre>
          </details>
        )}

        {batch && (
          <details className="trace-details" open={!!batch.batchTx}>
            <summary>Batch tx</summary>
            <pre>{JSON.stringify(batch, null, 2)}</pre>
            {batch.batchTx && (
              <a
                href={`https://testnet.arcscan.app/tx/${batch.batchTx}`}
                target="_blank"
                rel="noreferrer"
                className="trace-explorer"
              >
                View on Arcscan
              </a>
            )}
          </details>
        )}

        {decoded && (
          <details className="trace-details" open>
            <summary>Decoded USDC movements (block {decoded.blockNumber})</summary>
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
                      <code>{e.address}</code>
                    </td>
                    <td className={Number(e.usdc) >= 0 ? "positive" : "negative"}>{e.usdc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sellerAddress && (
              <p className="trace-seller">
                Seller {sellerAddress}:{" "}
                {sellerDelta ? (
                  <strong>+{sellerDelta.usdc} USDC</strong>
                ) : (
                  <span className="muted">not in this batch (check settlement status)</span>
                )}
              </p>
            )}
          </details>
        )}
      </Panel>
    </div>
  );
}

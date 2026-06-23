import { useEffect, useState } from "react";
import { getStackStatus, type StackStatus } from "../api.ts";
import { IconCheck } from "../icons.tsx";

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`stack-check ${ok ? "ok" : "missing"}`}>
      <span className="stack-icon">{ok ? <IconCheck size={10} /> : "·"}</span>
      {label}
    </div>
  );
}

export function StackStatusPanel({ embedded = false }: { embedded?: boolean }) {
  const [stack, setStack] = useState<StackStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getStackStatus()
      .then(setStack)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, []);

  if (err) return null;

  if (!stack) {
    return <p className="muted">Checking infrastructure…</p>;
  }

  const arcOk = stack.arcCanteen.installed;
  const circleInstalled = stack.circleCli.installed;
  const circleLoggedIn = stack.circleCli.loggedIn ?? false;
  const traceOk = stack.circleAgent.traceApi;
  const marketOk = stack.butler.marketplace;

  const content = (
    <>
      <div className="stack-grid">
        <Check ok={circleInstalled} label={`Circle CLI${stack.circleCli.version ? ` v${stack.circleCli.version}` : ""}`} />
        <Check ok={circleLoggedIn} label="Payer session" />
        <Check ok={traceOk} label="Arc 101 trace" />
        <Check ok={marketOk} label="Marketplace API" />
        <Check ok={arcOk} label={`ARC RPC${stack.arcCanteen.rpcUrl ? " linked" : ""}`} />
      </div>
      {circleInstalled && !circleLoggedIn && (
        <p className="muted stack-hint">Use <strong>Payer</strong> in the top bar to log in with Circle.</p>
      )}
      {!circleInstalled && (
        <p className="muted stack-hint">
          Run <code>npm run circle:install</code> on the API server.
        </p>
      )}
      {!embedded && (
        <p className="muted stack-doc">
          <a href="https://developers.circle.com/agent-stack/circle-cli" target="_blank" rel="noreferrer">
            Circle CLI
          </a>
          {" · "}
          <a href="https://github.com/the-canteen-dev/circle-agent" target="_blank" rel="noreferrer">
            circle-agent
          </a>
        </p>
      )}
    </>
  );

  if (embedded) return content;

  return content;
}

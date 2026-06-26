import { useCallback, useEffect, useRef, useState } from "react";
import {
  circleLoginInit,
  circleLoginVerify,
  circleLogout,
  getCircleStatus,
  getCircleWallets,
  setCircleExecutor,
  shortAddr,
  type CircleAgentWallet,
  type CircleStatus,
} from "../api.ts";
import { IconChevronDown, IconWallet } from "../icons.tsx";

type Step = "email" | "otp";

const SESSION_KEY = "butler.circleLogin";
const SESSION_TTL_MS = 15 * 60 * 1000;

type SavedSession = {
  requestId?: string;
  email?: string;
  otpPrefix?: string;
  hint?: string;
  savedAt?: number;
};

function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedSession;
    if (!data.savedAt || Date.now() - data.savedAt > SESSION_TTL_MS) {
      clearSession();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveSession(data: { requestId: string; email: string; otpPrefix?: string; hint?: string }) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function shortEmail(value: string): string {
  if (value.length <= 22) return value;
  const at = value.indexOf("@");
  if (at < 0) return `${value.slice(0, 18)}…`;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 10) return value;
  return `${local.slice(0, 8)}…${domain}`;
}

export function CircleLoginPanel({
  onReady,
  variant = "toolbar",
}: {
  onReady?: () => void;
  variant?: "sidebar" | "toolbar";
}) {
  const saved = loadSession();
  const [status, setStatus] = useState<CircleStatus | null>(null);
  const [email, setEmail] = useState(saved?.email ?? "");
  const [requestId, setRequestId] = useState<string | null>(saved?.requestId ?? null);
  const [otpPrefix, setOtpPrefix] = useState<string | null>(saved?.otpPrefix ?? null);
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<Step>(saved?.requestId ? "otp" : "email");
  const [wallets, setWallets] = useState<CircleAgentWallet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(saved?.hint ?? null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getCircleStatus();
      setStatus(s);
      if (s.loggedIn) {
        clearSession();
        const w = await getCircleWallets().catch(() => null);
        if (w) setWallets(w.wallets);
      }
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (step === "otp" || busy) return;
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, step, busy]);

  const goToEmail = () => {
    setStep("email");
    setRequestId(null);
    setOtp("");
    setOtpPrefix(null);
    setHint(null);
    clearSession();
  };

  const handleSendOtp = async () => {
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setError(null);
    setOpen(true);
    const watchdog = window.setTimeout(() => {
      setBusy(false);
      setError("Sending timed out. Tap Send login code to try again.");
    }, 40_000);
    try {
      const res = await circleLoginInit(email);
      if (!res?.requestId) {
        throw new Error("Code may have been sent, but the session ID was missing. Click Resend code.");
      }
      setRequestId(res.requestId);
      setOtpPrefix(res.otpPrefix ?? null);
      setHint(res.hint ?? null);
      setOtp("");
      setStep("otp");
      saveSession({
        requestId: res.requestId,
        email,
        otpPrefix: res.otpPrefix,
        hint: res.hint,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send OTP";
      setError(msg);
      setStep("email");
    } finally {
      window.clearTimeout(watchdog);
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!requestId || busy) {
      setError("Session expired. Click Resend code.");
      setStep("otp");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await circleLoginVerify(requestId, otp, email);
      const loggedInEmail = res.email ?? email;
      setWallets(res.wallets ?? []);
      setStatus((prev) => ({
        installed: prev?.installed ?? true,
        runnable: prev?.runnable ?? true,
        loggedIn: true,
        testnet: prev?.testnet ?? true,
        version: prev?.version ?? null,
        chain: prev?.chain ?? "ARC",
        email: loggedInEmail,
        executorAddress: res.executorAddress ?? prev?.executorAddress ?? null,
      }));
      clearSession();
      setStep("email");
      setOtp("");
      setOpen(false);
      await refresh();
      onReady?.();
    } catch (e) {
      const err = e as Error & { needsNewCode?: boolean };
      const msg =
        err.name === "AbortError"
          ? "Verify timed out. Circle may still be processing — refresh the page or resend a code."
          : err.message;
      setError(msg);
      if (err.needsNewCode) {
        goToEmail();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSelectWallet = async (address: string) => {
    setBusy(true);
    try {
      await setCircleExecutor(address);
      await refresh();
      onReady?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set executor");
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await circleLogout();
      goToEmail();
      setOpen(false);
      await refresh();
      onReady?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.loggedIn ?? false;

  if (variant === "toolbar") {
    return (
      <div className="payer-toolbar" ref={rootRef}>
        <button
          type="button"
          className={`payer-toolbar-chip ${connected ? "connected" : "action"}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <IconWallet size={14} />
          {connected ? (
            <>
              <span className="payer-toolbar-label">Payer</span>
              <span className="payer-toolbar-value email" title={status?.email ?? status?.executorAddress ?? ""}>
                {status?.email ? shortEmail(status.email) : shortAddr(status?.executorAddress ?? "")}
              </span>
              <span className="payer-dot on" />
            </>
          ) : (
            <>
              <span className="payer-toolbar-label">Payer</span>
              <span className="payer-toolbar-value warn">{step === "otp" ? "Enter code" : "Log in"}</span>
            </>
          )}
          <IconChevronDown size={12} className={open ? "open" : ""} />
        </button>

        {open && (
          <div className="payer-popover" role="dialog" aria-label="Circle payer">
            <p className="payer-popover-title">Circle payer · x402</p>

            {connected ? (
              <>
                <div className="payer-popover-session">
                  <span className="muted small">{status.email ?? "Logged in"}</span>
                  {status.executorAddress && (
                    <code className="payer-address">{shortAddr(status.executorAddress)}</code>
                  )}
                </div>
                {status.gatewayBalanceUsdc != null && (
                  <p className={`payer-balance${Number(status.gatewayBalanceUsdc) === 0 ? " low" : ""}`}>
                    Gateway: {status.gatewayBalanceUsdc} USDC
                    {Number(status.gatewayBalanceUsdc) === 0 && (
                      <span className="payer-balance-hint">
                        Fund at faucet.circle.com (Arc testnet), or run{" "}
                        <code>circle wallet fund --chain ARC-TESTNET</code>, then{" "}
                        <code>circle gateway deposit --method direct</code>.
                      </span>
                    )}
                  </p>
                )}
                {wallets.length > 1 && (
                  <div className="circle-wallet-list">
                    {wallets.map((w) => (
                      <button
                        key={w.address}
                        type="button"
                        className={`circle-wallet-pick ${status.executorAddress === w.address ? "active" : ""}`}
                        disabled={busy}
                        onClick={() => handleSelectWallet(w.address)}
                      >
                        {shortAddr(w.address)}
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className="btn ghost sm payer-popover-btn" disabled={busy} onClick={handleLogout}>
                  Sign out
                </button>
              </>
            ) : step === "otp" ? (
              <>
                <p className="payer-otp-hint">
                  Code sent to <strong>{email}</strong>
                  {otpPrefix ? (
                    <>
                      <br />
                      Format: <strong>{otpPrefix}-######</strong> or 6 digits only
                    </>
                  ) : (
                    <>
                      <br />
                      {hint ?? "Enter the 6-digit code from your email"}
                    </>
                  )}
                  <br />
                  <span className="muted">No email? Tap <strong>Resend</strong> — codes expire after 15 minutes.</span>
                </p>
                <input
                  className="field-input"
                  placeholder={otpPrefix ? `${otpPrefix}-123456` : "123456"}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="text"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleVerify();
                  }}
                />
                <div className="payer-actions">
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy || otp.replace(/\D/g, "").length < 6}
                    onClick={handleVerify}
                  >
                    {busy ? "Verifying…" : "Verify"}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={busy} onClick={handleSendOtp}>
                    Resend
                  </button>
                  <button type="button" className="btn ghost sm" disabled={busy} onClick={goToEmail}>
                    Back
                  </button>
                </div>
              </>
            ) : (
              <>
                <input
                  type="email"
                  className="field-input"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && email.includes("@")) void handleSendOtp();
                  }}
                />
                <button
                  type="button"
                  className="btn primary sm payer-popover-btn"
                  disabled={busy || !email.includes("@")}
                  onClick={handleSendOtp}
                >
                  {busy ? "Sending code…" : "Send login code"}
                </button>
                {busy && (
                  <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
                    Contacting Circle — usually under 30 seconds.
                  </p>
                )}
              </>
            )}

            {error && <p className="payer-error">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  return null;
}

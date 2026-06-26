import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  circleLoginVerify,
  circleLogout,
  getCircleStatus,
  getCircleWallets,
  pollCircleLoginJob,
  setCircleExecutor,
  shortAddr,
  startCircleLoginJob,
  wakeApiForLogin,
  IS_LOCAL_API,
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

function formatOtpForVerify(otp: string, prefix: string | null): string {
  const trimmed = otp.trim();
  if (trimmed.includes("-")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 6 && prefix) {
    return `${prefix.toUpperCase()}-${digits.slice(-6)}`;
  }
  return trimmed;
}

function otpDigits(value: string): number {
  return value.replace(/\D/g, "").length;
}

function measurePopoverPos(chip: HTMLButtonElement | null) {
  if (!chip) return null;
  const rect = chip.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    right: Math.max(12, window.innerWidth - rect.right),
    width: Math.min(300, window.innerWidth - 24),
  };
}

export function CircleLoginPanel({
  onReady,
  onLoginSuccess,
  variant = "toolbar",
}: {
  onReady?: () => void;
  onLoginSuccess?: (info: {
    executorAddress: string | null;
    funding?: import("../api.ts").CircleLoginFunding;
  }) => void;
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
  const [sendElapsed, setSendElapsed] = useState(0);
  const [awaitingSession, setAwaitingSession] = useState(false);
  const [open, setOpen] = useState(() => Boolean(saved?.requestId));
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number; width: number } | null>(
    null
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const connected = status?.loggedIn ?? false;
  const showOtpEntry =
    step === "otp" || awaitingSession || Boolean(requestId) || (busy && email.includes("@"));

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
    if (showOtpEntry && !connected) {
      setOpen(false);
      setPopoverPos(null);
    }
  }, [showOtpEntry, connected]);

  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const update = () => {
      setPopoverPos(measurePopoverPos(chipRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (showOtpEntry || busy) return;
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, showOtpEntry, busy]);

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
    setStep("otp");
    setOpen(false);
    setPopoverPos(null);
    setAwaitingSession(true);
    setOtp("");
    setSendElapsed(0);
    const tick = window.setInterval(() => setSendElapsed((s) => s + 1), 1_000);
    try {
      await wakeApiForLogin();
      const started = await startCircleLoginJob(email);
      const res = await Promise.race([
        pollCircleLoginJob(started.jobId, {
          onPending: () => setAwaitingSession(true),
        }),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("Still waiting on Circle — you can enter your code and tap Verify, or tap Resend.")),
            IS_LOCAL_API ? 90_000 : 125_000
          )
        ),
      ]);
      if (!res?.requestId) {
        throw new Error("Code may have been sent — enter it below and tap Verify, or tap Resend.");
      }
      setRequestId(res.requestId);
      setOtpPrefix(res.otpPrefix ?? null);
      setHint(res.hint ?? null);
      saveSession({
        requestId: res.requestId,
        email,
        otpPrefix: res.otpPrefix,
        hint: res.hint,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send OTP";
      setError(msg);
      // Stay on OTP step so the user can paste a code they already received.
    } finally {
      setAwaitingSession(false);
      window.clearInterval(tick);
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
      await wakeApiForLogin(45_000);
      const res = await circleLoginVerify(
        requestId,
        formatOtpForVerify(otp, otpPrefix),
        email,
        otpPrefix ?? undefined
      );
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
      onLoginSuccess?.({
        executorAddress: res.executorAddress ?? null,
        funding: res.funding,
      });
      onReady?.();
    } catch (e) {
      const err = e as Error & { needsNewCode?: boolean };
      const msg =
        err.name === "AbortError"
          ? "Verify timed out. Circle may still be processing — refresh the page or resend a code."
          : err.message;
      setError(msg);
      if (err.needsNewCode) {
        setRequestId(null);
        clearSession();
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

  const popover =
    open && popoverPos && !showOtpEntry ? (
      <div
        ref={popoverRef}
        className="payer-popover payer-popover-fixed"
        role="dialog"
        aria-label="Circle payer"
        style={{ top: popoverPos.top, right: popoverPos.right, width: popoverPos.width }}
      >
        <p className="payer-popover-title">Circle payer · x402</p>

        {connected ? (
          <>
            <div className="payer-popover-session">
              <span className="muted small">{status?.email ?? "Logged in"}</span>
              {status?.executorAddress && (
                <code className="payer-address">{shortAddr(status.executorAddress)}</code>
              )}
            </div>
            {status?.gatewayBalanceUsdc != null && (
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
                    className={`circle-wallet-pick ${status?.executorAddress === w.address ? "active" : ""}`}
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
                Contacting Circle… {sendElapsed > 0 ? `${sendElapsed}s` : ""}
                {sendElapsed > 90 ? " — taking longer than usual" : " — usually under 60s"}
              </p>
            )}
          </>
        )}

        {error && !showOtpEntry && <p className="payer-error">{error}</p>}
      </div>
    ) : null;

  const otpSheet =
    showOtpEntry && !connected ? (
      <div className="payer-otp-sheet-backdrop" role="presentation">
        <div className="payer-otp-sheet" role="dialog" aria-label="Enter login code">
          <p className="payer-otp-sheet-title">Enter your login code</p>
          <p className="payer-otp-hint">
            {awaitingSession || (busy && !requestId) ? (
              <>
                Sending to <strong>{email}</strong>… check your inbox.
                <br />
                <span className="muted">Paste the code below as soon as it arrives.</span>
              </>
            ) : (
              <>
                Code sent to <strong>{email}</strong>
                {otpPrefix ? (
                  <>
                    <br />
                    Use the full code from email: <strong>{otpPrefix}-######</strong>
                  </>
                ) : (
                  <>
                    <br />
                    {hint ?? "Enter the code from your email"}
                  </>
                )}
              </>
            )}
          </p>
          <input
            className="field-input payer-otp-input payer-otp-input-lg"
            placeholder={otpPrefix ? `${otpPrefix}-123456` : "ABC-123456 or 6 digits"}
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            autoComplete="one-time-code"
            inputMode="text"
            autoFocus
            aria-label="Email verification code"
            onKeyDown={(e) => {
              if (e.key === "Enter" && requestId && otpDigits(otp) >= 6) void handleVerify();
            }}
          />
          <div className="payer-actions payer-otp-sheet-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !requestId || otpDigits(otp) < 6}
              onClick={handleVerify}
            >
              {busy && requestId ? "Verifying…" : !requestId ? "Linking session…" : "Verify code"}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={handleSendOtp}>
              Resend
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={goToEmail}>
              Cancel
            </button>
          </div>
          {error && <p className="payer-error">{error}</p>}
        </div>
      </div>
    ) : null;

  if (variant === "toolbar") {
    return (
      <div className="payer-toolbar" ref={rootRef}>
        <button
          ref={chipRef}
          type="button"
          className={`payer-toolbar-chip ${connected ? "connected" : "action"}`}
          onClick={() => {
            setOpen((v) => {
              const next = !v;
              if (next) setPopoverPos(measurePopoverPos(chipRef.current));
              return next;
            });
          }}
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
              <span className="payer-toolbar-value warn">{showOtpEntry ? "Enter code" : "Log in"}</span>
            </>
          )}
          <IconChevronDown size={12} className={open ? "open" : ""} />
        </button>

        {popover && createPortal(popover, document.body)}
        {otpSheet && createPortal(otpSheet, document.body)}
      </div>
    );
  }

  return null;
}

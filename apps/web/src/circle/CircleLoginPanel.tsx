import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  circleLoginVerify,
  circleLogout,
  fundCircleWallet,
  getCircleStatus,
  getCircleWallets,
  sendLoginCode,
  setCircleExecutor,
  shortAddr,
  wakeApiForLogin,
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

const EMAIL_DOMAIN_FIXES: Record<string, string> = {
  "gamil.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gnail.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "yaho.com": "yahoo.com",
};

function fixEmailTypos(email: string): { email: string; corrected: boolean } {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return { email: trimmed, corrected: false };
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const fixed = EMAIL_DOMAIN_FIXES[domain];
  if (!fixed) return { email: trimmed, corrected: false };
  return { email: `${local}@${fixed}`, corrected: true };
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
  onLoginSuccess?: (info: { executorAddress: string | null }) => void;
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
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(saved?.hint ?? null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendElapsed, setSendElapsed] = useState(0);
  const [open, setOpen] = useState(false);
  const [showFundModal, setShowFundModal] = useState(false);
  const [fundBusy, setFundBusy] = useState(false);
  const [fundMessage, setFundMessage] = useState<string | null>(null);
  const [loggedInAddress, setLoggedInAddress] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const connected = status?.loggedIn ?? false;
  const codeReady = Boolean(requestId);

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
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const update = () => setPopoverPos(measurePopoverPos(chipRef.current));
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
      if (step === "otp" || busy || showFundModal) return;
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, step, busy, showFundModal]);

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
    const { email: sendTo, corrected } = fixEmailTypos(email);
    if (corrected) {
      setEmail(sendTo);
      setEmailHint(`Using ${sendTo} (fixed typo in domain)`);
    } else {
      setEmailHint(null);
    }
    setBusy(true);
    setSending(true);
    setError(null);
    setStep("otp");
    setOpen(true);
    setPopoverPos(measurePopoverPos(chipRef.current));
    setRequestId(null);
    setOtp("");
    setSendElapsed(0);
    const tick = window.setInterval(() => setSendElapsed((s) => s + 1), 1_000);
    try {
      const res = await sendLoginCode(sendTo);
      setRequestId(res.requestId);
      setOtpPrefix(res.otpPrefix ?? null);
      setHint(res.hint ?? null);
      saveSession({
        requestId: res.requestId,
        email: sendTo,
        otpPrefix: res.otpPrefix,
        hint: res.hint,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send code";
      setError(
        /API is down|Bad Gateway|Cannot reach API|unavailable/i.test(msg)
          ? "Server is waking up on Render (free tier). Wait 60 seconds, open the health link below, then tap Resend."
          : msg
      );
    } finally {
      window.clearInterval(tick);
      setSending(false);
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!requestId || otpDigits(otp) < 6 || busy) return;
    setBusy(true);
    setSending(false);
    setError(null);
    try {
      await wakeApiForLogin(90_000);
      const res = await circleLoginVerify(
        requestId,
        formatOtpForVerify(otp, otpPrefix),
        email,
        otpPrefix ?? undefined
      );
      const loggedInEmail = res.email ?? email;
      const address = res.executorAddress ?? null;
      setWallets(res.wallets ?? []);
      setStatus((prev) => ({
        installed: prev?.installed ?? true,
        runnable: prev?.runnable ?? true,
        loggedIn: true,
        testnet: prev?.testnet ?? true,
        version: prev?.version ?? null,
        chain: prev?.chain ?? "ARC",
        email: loggedInEmail,
        executorAddress: address,
      }));
      clearSession();
      setStep("email");
      setOtp("");
      setOpen(false);
      setLoggedInAddress(address);
      setShowFundModal(true);
      setFundMessage(null);
      await refresh();
      onLoginSuccess?.({ executorAddress: address });
      onReady?.();
    } catch (e) {
      const err = e as Error & { needsNewCode?: boolean };
      setError(err.message);
      if (err.needsNewCode) {
        setRequestId(null);
        clearSession();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFundWallet = async () => {
    setFundBusy(true);
    setFundMessage(null);
    try {
      await wakeApiForLogin(60_000);
      await fundCircleWallet();
      setFundMessage("Testnet USDC is on the way to your wallet. Gateway balance updates in about a minute.");
      await refresh();
      onReady?.();
    } catch (e) {
      setFundMessage(e instanceof Error ? e.message : "Could not fund wallet. Try the Circle faucet link below.");
    } finally {
      setFundBusy(false);
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
      setShowFundModal(false);
      await refresh();
      onReady?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  };

  const fundModal =
    showFundModal && loggedInAddress ? (
      <div className="payer-fund-backdrop" role="presentation">
        <div className="payer-fund-modal" role="dialog" aria-label="Get testnet tokens">
          <p className="payer-fund-title">You&apos;re logged in</p>
          <p className="payer-fund-copy">
            Get free testnet USDC on Arc so you can run agents and pay x402 merchants.
          </p>
          <p className="payer-fund-wallet">
            Your wallet: <code>{shortAddr(loggedInAddress)}</code>
          </p>
          <button
            type="button"
            className="btn primary payer-fund-btn"
            disabled={fundBusy}
            onClick={() => void handleFundWallet()}
          >
            {fundBusy ? "Sending tokens…" : "Get testnet USDC"}
          </button>
          <p className="muted small payer-fund-alt">
            Or use{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              faucet.circle.com
            </a>{" "}
            (Arc testnet) and send to your wallet address.
          </p>
          {fundMessage && <p className="payer-fund-msg">{fundMessage}</p>}
          <button type="button" className="btn ghost sm payer-fund-dismiss" onClick={() => setShowFundModal(false)}>
            Continue to app
          </button>
        </div>
      </div>
    ) : null;

  const popover =
    open && popoverPos ? (
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
        ) : step === "otp" ? (
          <>
            <p className="payer-otp-hint">
              {sending ? (
                <>
                  Sending code to <strong>{email}</strong>…
                  <br />
                  <span className="muted">
                    Usually 30–60s{sendElapsed > 0 ? ` (${sendElapsed}s)` : ""}. Stops after 2 min if server is down.
                  </span>
                </>
              ) : codeReady ? (
                <>
                  Code sent to <strong>{email}</strong>
                  {otpPrefix ? (
                    <>
                      <br />
                      Enter <strong>{otpPrefix}-######</strong> from your email
                    </>
                  ) : (
                    <>
                      <br />
                      {hint ?? "Enter the code from your email"}
                    </>
                  )}
                </>
              ) : (
                <>
                  Could not send code to <strong>{email}</strong>. Tap Resend.
                </>
              )}
            </p>
            <input
              className="field-input payer-otp-input"
              placeholder={otpPrefix ? `${otpPrefix}-123456` : "ABC-123456 or 6 digits"}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              disabled={!codeReady || sending || busy}
              aria-label="Email verification code"
              onKeyDown={(e) => {
                if (e.key === "Enter" && codeReady && otpDigits(otp) >= 6) void handleVerify();
              }}
            />
            <div className="payer-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={sending || busy || !codeReady || otpDigits(otp) < 6}
                onClick={handleVerify}
              >
                {sending ? "Sending code…" : busy ? "Logging in…" : "Verify & log in"}
              </button>
              <button type="button" className="btn ghost sm" disabled={sending || busy} onClick={handleSendOtp}>
                Resend
              </button>
              <button type="button" className="btn ghost sm" disabled={sending || busy} onClick={goToEmail}>
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
              Send login code
            </button>
            {emailHint && <p className="muted small" style={{ margin: "0.35rem 0 0" }}>{emailHint}</p>}
          </>
        )}

        {error && (
          <p className="payer-error">
            {error}
            {/waking up|API is down|Bad Gateway/i.test(error) && (
              <>
                {" "}
                <a href={`${import.meta.env.VITE_API_URL || "https://butler-api-x7lh.onrender.com"}/api/health`} target="_blank" rel="noreferrer">
                  Check API health
                </a>
              </>
            )}
          </p>
        )}
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
              <span className="payer-toolbar-value warn">{step === "otp" ? "Enter code" : "Log in"}</span>
            </>
          )}
          <IconChevronDown size={12} className={open ? "open" : ""} />
        </button>

        {popover && createPortal(popover, document.body)}
        {fundModal && createPortal(fundModal, document.body)}
      </div>
    );
  }

  return null;
}

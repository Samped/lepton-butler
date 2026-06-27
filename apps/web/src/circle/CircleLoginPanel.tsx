import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  beginLoginCodeSend,
  circleLoginVerify,
  circleLogout,
  fundCircleWallet,
  getCircleStatus,
  getCircleWallets,
  pollCircleLoginJob,
  resetBrowserSessionId,
  resolveLoginRequestId,
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
  jobId?: string;
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

function saveSession(data: {
  jobId?: string;
  requestId?: string;
  email: string;
  otpPrefix?: string;
  hint?: string;
}) {
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

function measurePopoverPos(chip: HTMLButtonElement | null, wide = false) {
  if (!chip) return null;
  const rect = chip.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    right: Math.max(12, window.innerWidth - rect.right),
    width: Math.min(wide ? 340 : 300, window.innerWidth - 24),
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
  const [jobId, setJobId] = useState<string | null>(saved?.jobId ?? null);
  const [requestId, setRequestId] = useState<string | null>(saved?.requestId ?? null);
  const [otpPrefix, setOtpPrefix] = useState<string | null>(saved?.otpPrefix ?? null);
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<Step>(saved?.requestId || saved?.jobId ? "otp" : "email");
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
  const [verifyHint, setVerifyHint] = useState<string | null>(null);
  const [loggedInAddress, setLoggedInAddress] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const skipResumePoll = useRef(false);

  const connected = status?.loggedIn ?? false;

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
    const update = () => setPopoverPos(measurePopoverPos(chipRef.current, step === "otp"));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (step === "otp" || busy || sending || showFundModal) return;
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, step, busy, sending, showFundModal]);

  const goToEmail = () => {
    setStep("email");
    setJobId(null);
    setRequestId(null);
    setOtp("");
    setOtpPrefix(null);
    setHint(null);
    setError(null);
    clearSession();
  };

  const applyLoginJobResult = (
    result: {
      requestId: string;
      email?: string;
      otpPrefix?: string;
      hint?: string;
    },
    meta?: { jobId?: string; email?: string }
  ) => {
    setRequestId(result.requestId);
    setOtpPrefix(result.otpPrefix ?? null);
    setHint(result.hint ?? null);
    saveSession({
      jobId: meta?.jobId ?? jobId ?? undefined,
      requestId: result.requestId,
      email: meta?.email ?? email,
      otpPrefix: result.otpPrefix,
      hint: result.hint,
    });
  };

  const handleSendCode = async () => {
    if (!email.includes("@") || busy || sending) return;
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
    setSendElapsed(0);
    setRequestId(null);
    setOtp("");
    skipResumePoll.current = true;
    let startedJobId: string | null = null;
    const tick = window.setInterval(() => setSendElapsed((s) => s + 1), 1_000);
    try {
      const res = await beginLoginCodeSend(sendTo, {
        onJobStarted: ({ jobId: id }) => {
          startedJobId = id;
          setJobId(id);
          setStep("otp");
          setOpen(true);
          setPopoverPos(measurePopoverPos(chipRef.current, true));
          saveSession({ jobId: id, email: sendTo });
        },
        onProgress: (sec) => setSendElapsed(Math.max(sec, 1)),
      });
      setJobId(res.jobId);
      applyLoginJobResult(res, { jobId: res.jobId, email: sendTo });
    } catch (e) {
      if (startedJobId) {
        setError(
          e instanceof Error
            ? e.message
            : "If you received the email, enter the code below and tap Verify & log in."
        );
      } else {
        setStep("email");
        setJobId(null);
        clearSession();
        setError(e instanceof Error ? e.message : "Could not send code. Try again.");
      }
    } finally {
      window.clearInterval(tick);
      setSending(false);
      setBusy(false);
      skipResumePoll.current = false;
    }
  };

  useEffect(() => {
    if (skipResumePoll.current || !jobId || requestId || connected || step !== "otp") return;
    let cancelled = false;
    void (async () => {
      setSending(true);
      try {
        const res = await pollCircleLoginJob(jobId, {
          onPending: (ms) => {
            if (!cancelled) setSendElapsed(Math.max(1, Math.floor(ms / 1000)));
          },
        });
        if (!cancelled) applyLoginJobResult(res, { jobId, email });
      } catch {
        /* user can still verify — waitForLoginRequestId runs on submit */
      } finally {
        if (!cancelled) setSending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, requestId, connected, step, email]);

  const handleVerify = async () => {
    if (otpDigits(otp) < 6 || busy) return;
    setBusy(true);
    setError(null);
    setVerifyHint("Connecting…");
    try {
      const rid = await resolveLoginRequestId(jobId, requestId);
      if (rid !== requestId) {
        applyLoginJobResult(
          { requestId: rid, otpPrefix: otpPrefix ?? undefined, hint: hint ?? undefined },
          { jobId: jobId ?? undefined, email }
        );
      }
      const formattedOtp = formatOtpForVerify(otp, otpPrefix);
      const res = await circleLoginVerify(rid, formattedOtp, email, otpPrefix ?? undefined, {
        onProgress: (msg) => setVerifyHint(msg),
      });
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
      const msg = err.message;
      setError(
        /Cannot reach API|waking up|502|503|504|Bad Gateway|timed out/i.test(msg) && !err.needsNewCode
          ? `${msg} If /api/health shows ok:true, tap Verify & log in again and wait up to 2 minutes.`
          : msg
      );
      if (err.needsNewCode) {
        goToEmail();
      }
    } finally {
      setBusy(false);
      setVerifyHint(null);
    }
  };

  const handleFundWallet = async () => {
    setFundBusy(true);
    setFundMessage(null);
    try {
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
      resetBrowserSessionId();
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
              {sending && !requestId ? (
                <>
                  Sending to <strong>{email}</strong>
                  {sendElapsed > 0 ? ` (${sendElapsed}s)` : ""}.
                  <br />
                  <span className="muted">Got the email? Enter the code below while we finish connecting.</span>
                </>
              ) : (
                <>
                  Code sent to <strong>{email}</strong>.
                  {otpPrefix ? (
                    <>
                      {" "}
                      Enter <strong>{otpPrefix}-######</strong> from your email.
                    </>
                  ) : (
                    <> {hint ?? "Enter the code from your email."}</>
                  )}
                </>
              )}
            </p>
            <label className="payer-otp-label" htmlFor="butler-otp-input">
              Verification code
            </label>
            <input
              id="butler-otp-input"
              className="field-input payer-otp-input"
              placeholder={otpPrefix ? `${otpPrefix}-123456` : "ABC-123456"}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              disabled={busy}
              aria-label="Email verification code"
              onKeyDown={(e) => {
                if (e.key === "Enter" && otpDigits(otp) >= 6 && !busy) void handleVerify();
              }}
            />
            <button
              type="button"
              className="btn primary sm payer-popover-btn"
              disabled={busy || otpDigits(otp) < 6}
              onClick={() => void handleVerify()}
            >
              {busy ? verifyHint ?? "Logging in…" : "Verify & log in"}
            </button>
            {verifyHint && busy && <p className="muted small payer-send-status">{verifyHint}</p>}
            <button type="button" className="btn ghost sm payer-link-btn" disabled={busy || sending} onClick={goToEmail}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <label className="payer-otp-label" htmlFor="butler-email-input">
              Email
            </label>
            <input
              id="butler-email-input"
              type="email"
              className="field-input"
              placeholder="you@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              disabled={sending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && email.includes("@") && !sending) void handleSendCode();
              }}
            />
            <button
              type="button"
              className="btn primary sm payer-popover-btn"
              disabled={sending || busy || !email.includes("@")}
              onClick={() => void handleSendCode()}
            >
              {sending ? `Sending code…${sendElapsed > 0 ? ` (${sendElapsed}s)` : ""}` : "Send code"}
            </button>
            {sending && (
              <p className="muted small payer-send-status">
                Waking server and emailing <strong>{email}</strong>. This can take up to a minute on free hosting.
              </p>
            )}
            {emailHint && !sending && (
              <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
                {emailHint}
              </p>
            )}
          </>
        )}

        {error && <p className="payer-error">{error}</p>}
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
              if (next) setPopoverPos(measurePopoverPos(chipRef.current, step === "otp"));
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

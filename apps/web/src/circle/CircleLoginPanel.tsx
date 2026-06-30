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
import { IconChevronDown, IconClose, IconWallet } from "../icons.tsx";

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

function fallbackPopoverPos(wide = false) {
  return {
    top: 72,
    right: 12,
    width: Math.min(wide ? 340 : 300, typeof window !== "undefined" ? window.innerWidth - 24 : 300),
  };
}

export function CircleLoginPanel({
  onReady,
  onLoginSuccess,
  variant = "toolbar",
  open: openProp,
  onOpenChange,
}: {
  onReady?: () => void;
  onLoginSuccess?: (info: { executorAddress: string | null }) => void;
  variant?: "sidebar" | "toolbar" | "mobile-sheet";
  /** Controlled open (used by mobile sign-in sheet). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  const [verifying, setVerifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendElapsed, setSendElapsed] = useState(0);
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = openProp ?? internalOpen;
  const setOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const prev = openProp ?? internalOpen;
      const next = typeof value === "function" ? value(prev) : value;
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, internalOpen, onOpenChange]
  );
  const [showFundModal, setShowFundModal] = useState(false);
  const [fundBusy, setFundBusy] = useState(false);
  const [fundMessage, setFundMessage] = useState<string | null>(null);
  const [verifyHint, setVerifyHint] = useState<string | null>(null);
  const [loggedInAddress, setLoggedInAddress] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const skipResumePoll = useRef(false);
  const sendInFlightRef = useRef(false);

  const connected = status?.loggedIn ?? false;

  useEffect(() => {
    if (variant !== "mobile-sheet" || !isOpen || step !== "email" || connected) return;
    const t = window.setTimeout(() => emailInputRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, [variant, isOpen, step, connected]);

  useEffect(() => {
    if (variant !== "mobile-sheet" || !isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [variant, isOpen]);

  const refresh = useCallback(async () => {
    try {
      const s = await getCircleStatus();
      setStatus(s);
      if (s.loggedIn) {
        clearSession();
        setError(null);
        setStep("email");
        setJobId(null);
        setRequestId(null);
        setSending(false);
        sendInFlightRef.current = false;
        const w = await getCircleWallets().catch(() => null);
        if (w) setWallets(w.wallets);
      }
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    clearSession();
    setError(null);
    setStep("email");
    setJobId(null);
    setRequestId(null);
    setSending(false);
    sendInFlightRef.current = false;
  }, [connected]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isOpen) {
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
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen || variant === "mobile-sheet") return;
    const onDoc = (e: MouseEvent) => {
      if (step === "otp" || verifying || sending || showFundModal) return;
      const target = e.target as Node;
      if (
        rootRef.current?.contains(target) ||
        popoverRef.current?.contains(target) ||
        sheetRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [isOpen, step, verifying, sending, showFundModal, variant]);

  useEffect(() => {
    if (step !== "otp" || !isOpen) return;
    const t = window.setTimeout(() => otpInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [step, isOpen]);

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

  const handleSendCode = () => {
    if (!email.includes("@") || verifying || sendInFlightRef.current || connected) return;
    const { email: sendTo, corrected } = fixEmailTypos(email);
    if (corrected) {
      setEmail(sendTo);
      setEmailHint(`Using ${sendTo} (fixed typo in domain)`);
    } else {
      setEmailHint(null);
    }

    sendInFlightRef.current = true;
    setStep("otp");
    setOpen(true);
    setPopoverPos(measurePopoverPos(chipRef.current, true) ?? fallbackPopoverPos(true));
    setSending(true);
    setError(null);
    setSendElapsed(0);
    setRequestId(null);
    setOtp("");
    skipResumePoll.current = true;
    saveSession({ email: sendTo });
    const tick = window.setInterval(() => setSendElapsed((s) => s + 1), 1_000);

    void (async () => {
      let startedJobId: string | null = null;
      try {
        const res = await beginLoginCodeSend(sendTo, {
          onJobStarted: ({ jobId: id }) => {
            startedJobId = id;
            setJobId(id);
            saveSession({ jobId: id, email: sendTo });
          },
          onProgress: (sec) => setSendElapsed(Math.max(sec, 1)),
        });
        setJobId(res.jobId);
        applyLoginJobResult(res, { jobId: res.jobId, email: sendTo });
        setError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not confirm the code was sent.";
        setError(
          startedJobId
            ? `${msg} If you received the email, enter the code below and tap Verify & log in.`
            : `${msg} If you already received a code, enter it below and tap Verify & log in.`
        );
      } finally {
        window.clearInterval(tick);
        setSending(false);
        sendInFlightRef.current = false;
        skipResumePoll.current = false;
      }
    })();
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
    if (otpDigits(otp) < 6 || verifying) return;
    setVerifying(true);
    setError(null);
    setVerifyHint("Verifying code…");
    try {
      const rid = requestId ?? (await resolveLoginRequestId(jobId, requestId));
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
      const address = res.executorAddress ?? res.wallets?.[0]?.address ?? null;
      setWallets(res.wallets ?? []);
      setStatus((prev) => ({
        installed: prev?.installed ?? true,
        runnable: prev?.runnable ?? true,
        loggedIn: true,
        testnet: prev?.testnet ?? true,
        version: prev?.version ?? null,
        chain: prev?.chain ?? "ARC-TESTNET",
        email: loggedInEmail,
        executorAddress: address,
      }));
      clearSession();
      setStep("email");
      setOtp("");
      setOpen(false);
      setError(null);
      onLoginSuccess?.({ executorAddress: address });
      onReady?.();
      void (async () => {
        try {
          const s = await getCircleStatus();
          setStatus((prev) => ({
            ...s,
            loggedIn: s.loggedIn || true,
            email: s.email ?? loggedInEmail,
            executorAddress: s.executorAddress ?? address,
          }));
          if (s.loggedIn) {
            const w = await getCircleWallets().catch(() => null);
            if (w?.wallets?.length) setWallets(w.wallets);
          }
        } catch {
          /* optimistic login from verify response */
        }
      })();
    } catch (e) {
      const err = e as Error & { needsNewCode?: boolean };
      const msg = err.message;
      setError(
        /Cannot reach API|waking up|502|503|504|Bad Gateway|timed out/i.test(msg) && !err.needsNewCode
          ? `API server is not responding. SSH to your Oracle VM and run: bash scripts/oracle-recover.sh — then tap Verify again with a fresh code.`
          : msg
      );
      if (err.needsNewCode) {
        goToEmail();
      }
    } finally {
      setVerifying(false);
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

  const showOtpStep = step === "otp" && !connected;
  const popoverLayout =
    popoverPos ?? measurePopoverPos(chipRef.current, showOtpStep) ?? fallbackPopoverPos(showOtpStep);

  const loginPanelContent = (
    <>
      <p className="payer-popover-title">
        {variant === "mobile-sheet" ? "Sign in with Circle" : "Circle payer · x402"}
      </p>

      {connected && !showOtpStep ? (
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
          {Number(status?.gatewayBalanceUsdc ?? 0) === 0 && status?.executorAddress && (
            <button
              type="button"
              className="btn ghost sm payer-popover-btn"
              disabled={fundBusy}
              onClick={() => {
                setLoggedInAddress(status.executorAddress);
                setShowFundModal(true);
              }}
            >
              Get testnet USDC
            </button>
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
      ) : showOtpStep ? (
        <>
          <p className="payer-otp-hint">
            {sending && !requestId ? (
              <>
                Sending to <strong>{email}</strong>
                {sendElapsed > 0 ? ` (${sendElapsed}s)` : ""}.
                <br />
                <span className="muted">Enter the code below as soon as it arrives — you can type while we connect.</span>
                {sendElapsed > 120 ? (
                  <>
                    <br />
                    <span className="muted">
                      Server is slow or stuck — if verify fails, SSH to the Oracle VM and run{" "}
                      <code>bash scripts/oracle-recover.sh</code>, then tap Resend for a fresh code.
                    </span>
                  </>
                ) : null}
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
            ref={otpInputRef}
            id="butler-otp-input"
            className="field-input payer-otp-input"
            placeholder={otpPrefix ? `${otpPrefix}-123456` : "ABC-123456"}
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            autoComplete="one-time-code"
            inputMode="text"
            disabled={verifying}
            aria-label="Email verification code"
            onKeyDown={(e) => {
              if (e.key === "Enter" && otpDigits(otp) >= 6 && !verifying) void handleVerify();
            }}
          />
          <button
            type="button"
            className="btn primary sm payer-popover-btn"
            disabled={verifying || otpDigits(otp) < 6}
            onClick={() => void handleVerify()}
          >
            {verifying ? "Verifying…" : "Verify & log in"}
          </button>
          {verifyHint && verifying && verifyHint !== "Verifying code…" && (
            <p className="muted small payer-send-status">{verifyHint}</p>
          )}
          <button type="button" className="btn ghost sm payer-link-btn" disabled={verifying} onClick={goToEmail}>
            Use a different email
          </button>
        </>
      ) : (
        <>
          {variant === "mobile-sheet" && (
            <p className="payer-sheet-lead muted small">
              Enter your email. We&apos;ll send a one-time code so Butler can pay agents from your Circle wallet.
            </p>
          )}
          <label className="payer-otp-label" htmlFor="butler-email-input">
            Email
          </label>
          <input
            ref={emailInputRef}
            id="butler-email-input"
            type="email"
            className="field-input payer-email-input"
            placeholder="you@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
            autoFocus={variant !== "mobile-sheet"}
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && email.includes("@") && !sending) void handleSendCode();
            }}
          />
          <button
            type="button"
            className="btn primary payer-popover-btn"
            disabled={sending || verifying || !email.includes("@")}
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

      {error && !connected && <p className="payer-error">{error}</p>}
    </>
  );

  const popover =
    isOpen && variant !== "mobile-sheet" ? (
      <div
        ref={popoverRef}
        className="payer-popover payer-popover-fixed"
        role="dialog"
        aria-label="Circle payer"
        style={{ top: popoverLayout.top, right: popoverLayout.right, width: popoverLayout.width }}
      >
        {loginPanelContent}
      </div>
    ) : null;

  const mobileSheet =
    isOpen && variant === "mobile-sheet" ? (
      <>
        <button
          type="button"
          className="payer-sheet-backdrop"
          aria-label="Close sign in"
          onClick={() => setOpen(false)}
        />
        <div
          ref={sheetRef}
          className="payer-sheet"
          role="dialog"
          aria-label="Sign in with Circle"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="payer-sheet-close"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            <IconClose size={18} />
          </button>
          <div className="payer-sheet-handle" aria-hidden />
          {loginPanelContent}
        </div>
      </>
    ) : null;

  if (variant === "mobile-sheet") {
    return (
      <>
        {mobileSheet && createPortal(mobileSheet, document.body)}
        {fundModal && createPortal(fundModal, document.body)}
      </>
    );
  }

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
              if (next) {
                setPopoverPos(
                  measurePopoverPos(chipRef.current, step === "otp") ?? fallbackPopoverPos(step === "otp")
                );
              }
              return next;
            });
          }}
          aria-expanded={isOpen}
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
          <IconChevronDown size={12} className={isOpen ? "open" : ""} />
        </button>

        {popover && createPortal(popover, document.body)}
        {fundModal && createPortal(fundModal, document.body)}
      </div>
    );
  }

  return null;
}

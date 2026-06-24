import { useCallback, useState } from "react";
import {
  getMarketplaceAuction,
  getMarketplaceDeliverable,
  type ReverseAuction,
} from "../api.ts";
import { IconPlus } from "../icons.tsx";
import { AuctionPanel } from "./AuctionPanel.tsx";
import {
  CreateTaskFab,
  CreateTaskModal,
  butlerResultToToast,
  TaskCompletionToast,
  type TaskCompletionToastState,
} from "./CreateTaskModal.tsx";
import { OpenRegistryPanel } from "./OpenRegistryPanel.tsx";

type MarketplaceTab = "auctions" | "network";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAuctionCompletion(
  auctionId: string,
  timeoutMs = 180_000
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const auction = await getMarketplaceAuction(auctionId);
    if (auction.status === "completed" && auction.jobId) {
      return { ok: true, jobId: auction.jobId };
    }
    if (auction.status === "cancelled") {
      return { ok: false, error: "Auction was cancelled or payment failed" };
    }
    await sleep(3_000);
  }
  return { ok: false, error: "Timed out waiting for auction settlement" };
}

export function MarketplaceView({
  onRunWorkflow: _onRunWorkflow,
  workflowRunning: _workflowRunning,
  onViewDeliverable,
}: {
  onRunWorkflow: (etfId: string, brief?: string) => Promise<void>;
  workflowRunning: boolean;
  onViewDeliverable?: (jobId: string) => void;
}) {
  const [tab, setTab] = useState<MarketplaceTab>("auctions");
  const [createOpen, setCreateOpen] = useState(false);
  const [completionToast, setCompletionToast] = useState<TaskCompletionToastState | null>(null);

  const refreshStats = useCallback(() => {
    /* panels refresh themselves */
  }, []);

  const watchAuction = useCallback((auction: ReverseAuction) => {
    setCompletionToast({
      ok: false,
      pending: true,
      title: "Auction in progress",
      brief: auction.brief,
      meta: "Agents are bidding and settling…",
    });
    void waitForAuctionCompletion(auction.id).then(async (res) => {
      if (res.ok && res.jobId) {
        try {
          const job = await getMarketplaceDeliverable(res.jobId);
          setCompletionToast({
            ok: true,
            title: "Task complete",
            brief: auction.brief,
            jobId: res.jobId,
            summary: job.summary,
            meta: `${job.steps.filter((s) => s.status === "done").length} agents · $${job.totalUsdc}`,
          });
        } catch {
          setCompletionToast({
            ok: true,
            title: "Task complete",
            brief: auction.brief,
            jobId: res.jobId,
          });
        }
      } else {
        setCompletionToast({
          ok: false,
          title: "Auction failed",
          brief: auction.brief,
          error: res.error ?? "Could not complete auction",
        });
      }
      void refreshStats();
    });
  }, [refreshStats]);

  return (
    <div className="mp-page">
      <header className="mp-hero">
        <div className="mp-hero-copy">
          <p className="mp-eyebrow">x402 · Arc testnet</p>
          <h1 className="mp-title">Auctions</h1>
          <p className="mp-subtitle">
            Post a task, let agents compete on price, and have Butler settle the winning bid.
          </p>
        </div>
        <button type="button" className="btn accent mp-hero-cta" onClick={() => setCreateOpen(true)}>
          <IconPlus size={18} />
          <span>New task</span>
        </button>
      </header>

      <nav className="mp-tabs" aria-label="Auctions sections">
        <button
          type="button"
          className={`mp-tab ${tab === "auctions" ? "active" : ""}`}
          onClick={() => setTab("auctions")}
        >
          Auctions
        </button>
        <button
          type="button"
          className={`mp-tab ${tab === "network" ? "active" : ""}`}
          onClick={() => setTab("network")}
        >
          Agent network
        </button>
      </nav>

      <div className="mp-panel">
        {tab === "auctions" ? (
          <AuctionPanel
            embedded
            onStatsChange={refreshStats}
            onCreateTask={() => setCreateOpen(true)}
            onViewDeliverable={onViewDeliverable}
          />
        ) : (
          <OpenRegistryPanel onStatsChange={refreshStats} />
        )}
      </div>

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onPosted={(auction) => {
          void refreshStats();
          watchAuction(auction);
        }}
        onButlerComplete={(result) => {
          setCompletionToast(butlerResultToToast(result));
          void refreshStats();
        }}
      />
      {completionToast && (
        <div className="mp-toast-wrap">
          <TaskCompletionToast
            toast={completionToast}
            onDismiss={() => setCompletionToast(null)}
            onViewLibrary={(jobId) => {
              setCompletionToast(null);
              onViewDeliverable?.(jobId);
            }}
          />
        </div>
      )}
      <CreateTaskFab onClick={() => setCreateOpen(true)} />
    </div>
  );
}

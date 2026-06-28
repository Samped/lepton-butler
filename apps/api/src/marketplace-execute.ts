/**
 * x402 agent execute endpoints — required for Butler to pay agents in lite API mode.
 */
import type { Express, Request, Response } from "express";
import { formatUnits } from "viem";
import type { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import {
  appendRecord,
  evaluateSpend,
  getAgentCredits,
  loadMarketplaceState,
  loadState,
  recordAgentFailure,
  recordAgentSuccess,
  saveMarketplaceState,
  saveState,
  treasuryCredit,
  mergeJobUpdates,
  mergeAuctionUpdates,
  type SpendRecord,
} from "@butler/core";
import { enrichSpendPayer, spendInitiatorFromMarketplaceQuery } from "./ledger-payer.ts";
import { readWorkflowContext } from "./context-store.ts";
import {
  buildAuditPayload,
  buildBillPayload,
  buildChartPayload,
  buildCompetitorPayload,
  buildDefiPayload,
  buildMacroPayload,
  buildMarketPayload,
  buildNewsPayload,
  buildOnchainPayload,
  buildReportPayload,
  buildResearchPayload,
  buildRiskPayload,
  buildSentimentPayload,
  buildSubscriptionPayload,
  buildThesisPayload,
} from "./agent-services.ts";

type PaidRequest = Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

type Gateway = ReturnType<typeof createGatewayMiddleware>;

interface AgentServiceDef {
  price: string;
  merchantId: string;
  category: SpendRecord["category"];
  policyAgent: SpendRecord["agent"];
  etaSeconds: number;
  payload: (req: PaidRequest) => Promise<unknown>;
}

function briefFrom(req: PaidRequest): string {
  const briefContextId = String(req.query.briefContextId ?? "").trim();
  if (briefContextId) {
    const ctx = readWorkflowContext(briefContextId);
    if (ctx.trim()) return ctx;
  }
  return String(req.query.brief ?? "");
}

function contextFrom(req: PaidRequest): string {
  const contextId = String(req.query.contextId ?? "").trim();
  if (contextId) return readWorkflowContext(contextId);
  return String(req.query.context ?? "");
}

const AGENT_SERVICES: Record<string, AgentServiceDef> = {
  "news-agent": {
    price: "$0.01",
    merchantId: "research-summary",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 15,
    payload: (req) => buildNewsPayload(briefFrom(req)),
  },
  "market-agent": {
    price: "$0.001",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 5,
    payload: (req) => buildMarketPayload(briefFrom(req)),
  },
  "research-agent": {
    price: "$0.02",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 20,
    payload: (req) => buildResearchPayload(briefFrom(req), contextFrom(req)),
  },
  "sentiment-agent": {
    price: "$0.03",
    merchantId: "research-summary",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 12,
    payload: (req) => buildSentimentPayload(briefFrom(req)),
  },
  "chart-agent": {
    price: "$0.015",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 10,
    payload: (req) => buildChartPayload(briefFrom(req)),
  },
  "report-agent": {
    price: "$0.05",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 25,
    payload: (req) => buildReportPayload(briefFrom(req), contextFrom(req)),
  },
  "thesis-agent": {
    price: "$0.069",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 50,
    payload: (req) => buildThesisPayload(briefFrom(req), contextFrom(req)),
  },
  "audit-agent": {
    price: "$0.10",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 45,
    payload: (req) => buildAuditPayload(briefFrom(req), String(req.query.contract ?? "")),
  },
  "defi-agent": {
    price: "$0.02",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 18,
    payload: (req) => buildDefiPayload(briefFrom(req)),
  },
  "macro-agent": {
    price: "$0.025",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 22,
    payload: (req) => buildMacroPayload(briefFrom(req)),
  },
  "onchain-agent": {
    price: "$0.018",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 16,
    payload: (req) => buildOnchainPayload(briefFrom(req)),
  },
  "competitor-agent": {
    price: "$0.03",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 20,
    payload: (req) => buildCompetitorPayload(briefFrom(req)),
  },
  "risk-agent": {
    price: "$0.04",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 18,
    payload: (req) => buildRiskPayload(briefFrom(req), contextFrom(req)),
  },
  "bill-agent": {
    price: "$0.05",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 14,
    payload: (req) => buildBillPayload(briefFrom(req)),
  },
  "subscription-agent": {
    price: "$0.03",
    merchantId: "subscription-check",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 12,
    payload: (req) => buildSubscriptionPayload(briefFrom(req)),
  },
};

export function registerAgentExecuteRoutes(
  app: Express,
  gateway: Gateway,
  opts: { statePath: string; policyStatePath: string; sellerAddress: string }
): void {
  const { statePath, policyStatePath, sellerAddress } = opts;

  function loadMp() {
    return loadMarketplaceState(statePath, sellerAddress);
  }

  function mpCredits() {
    return getAgentCredits(loadMp());
  }

  function saveMp(state: ReturnType<typeof loadMp>) {
    const latest = loadMp();
    const next = {
      ...latest,
      agentStats: { ...latest.agentStats, ...state.agentStats },
      treasury: { ...latest.treasury, ...state.treasury },
      jobs: mergeJobUpdates(latest.jobs, state.jobs),
      auctions: mergeAuctionUpdates(latest.auctions, state.auctions),
    };
    saveMarketplaceState(next, statePath);
    return next;
  }

  function marketplacePaidHandler(agentId: string, svc: AgentServiceDef) {
    return async (req: PaidRequest, res: Response) => {
      const policyState = loadState(policyStatePath);
      const amountUsdc = req.payment ? formatUnits(BigInt(req.payment.amount), 6) : svc.price.replace("$", "");

      const decision = evaluateSpend(
        policyState.policy,
        { agent: svc.policyAgent, merchantId: svc.merchantId, amountUsdc, category: svc.category },
        policyState.records
      );

      if (!decision.allowed) {
        const payer = enrichSpendPayer(req.payment?.payer);
        const record: SpendRecord = {
          id: crypto.randomUUID(),
          at: Math.floor(Date.now() / 1000),
          agent: svc.policyAgent,
          category: svc.category,
          merchantId: svc.merchantId,
          amountUsdc,
          settlementId: req.payment?.transaction,
          payerAddress: payer.payerAddress,
          executorAddress: payer.executorAddress,
          initiator: spendInitiatorFromMarketplaceQuery(req.query as Record<string, unknown>),
          status: "blocked",
          reason: decision.reason,
        };
        saveState(appendRecord(policyState, record), policyStatePath);
        let mp = loadMp();
        mp = recordAgentFailure(mp, agentId);
        saveMp(mp);
        res.status(403).json({ error: decision.reason, agentId });
        return;
      }

      let data: unknown;
      try {
        data = await svc.payload(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent service failed";
        res.status(503).json({ error: message, agentId });
        return;
      }

      const payer = enrichSpendPayer(req.payment?.payer);
      const record: SpendRecord = {
        id: crypto.randomUUID(),
        at: Math.floor(Date.now() / 1000),
        agent: svc.policyAgent,
        category: svc.category,
        merchantId: svc.merchantId,
        amountUsdc,
        settlementId: req.payment?.transaction,
        payerAddress: payer.payerAddress,
        executorAddress: payer.executorAddress,
        initiator: spendInitiatorFromMarketplaceQuery(req.query as Record<string, unknown>),
        status: "settled",
      };
      saveState(appendRecord(policyState, record), policyStatePath);

      let mp = loadMp();
      mp = recordAgentSuccess(mp, agentId, amountUsdc, svc.etaSeconds);
      mp = treasuryCredit(mp, amountUsdc);
      saveMp(mp);

      res.json({
        agentId,
        marketplace: true,
        paid_by: req.payment?.payer,
        amount_usdc: amountUsdc,
        settlementId: req.payment?.transaction,
        reputation: mpCredits().find((c) => c.agentId === agentId)?.score,
        data,
      });
    };
  }

  for (const [agentId, svc] of Object.entries(AGENT_SERVICES)) {
    app.get(
      `/marketplace/agents/${agentId}/execute`,
      gateway.require(svc.price),
      marketplacePaidHandler(agentId, svc)
    );
  }
}

export async function createMarketplaceGateway(sellerAddress: string): Promise<Gateway> {
  const [{ createGatewayMiddleware }, { GATEWAY_FACILITATOR, ARC_EIP155 }] = await Promise.all([
    import("@circle-fin/x402-batching/server"),
    import("@butler/arc"),
  ]);
  return createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: process.env.GATEWAY_FACILITATOR_URL ?? GATEWAY_FACILITATOR,
    networks: [ARC_EIP155],
  });
}

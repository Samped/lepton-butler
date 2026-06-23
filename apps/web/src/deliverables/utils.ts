export function formatRelativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function strategyLabel(strategy?: string): string {
  if (strategy === "etf") return "Workflow";
  if (strategy === "workflow") return "Multi-agent";
  if (strategy === "direct") return "Single agent";
  return "Task";
}

export const AGENT_COLORS: Record<string, string> = {
  "news-agent": "#3b82f6",
  "market-agent": "#10b981",
  "research-agent": "#8b5cf6",
  "sentiment-agent": "#f59e0b",
  "chart-agent": "#06b6d4",
  "report-agent": "#ec4899",
  "audit-agent": "#ef4444",
};

export function agentInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

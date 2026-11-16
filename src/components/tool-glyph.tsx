import { cn } from "@/lib/utils";
import type { ToolKind, TaskStatus } from "@/lib/types";
import {
  Mail,
  Calendar,
  Wallet,
  Globe,
  FileText,
  Search,
  Folder,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

export const toolIcons: Record<ToolKind, LucideIcon> = {
  email: Mail,
  calendar: Calendar,
  money: Wallet,
  browser: Globe,
  docs: FileText,
  search: Search,
  files: Folder,
  message: MessageSquare,
};

export function ToolGlyph({
  tool,
  className,
  size = 16,
}: {
  tool: ToolKind;
  className?: string;
  size?: number;
}) {
  const Icon = toolIcons[tool] ?? MessageSquare;
  return <Icon size={size} className={className} />;
}

export const statusStyles: Record<
  TaskStatus,
  { label: string; dot: string; text: string }
> = {
  queued: { label: "Queued", dot: "bg-muted", text: "text-muted" },
  running: { label: "Running", dot: "bg-accent animate-pulse", text: "text-accent" },
  paused: { label: "Paused", dot: "bg-muted", text: "text-muted" },
  needs_input: { label: "Needs you", dot: "bg-danger", text: "text-danger" },
  done: { label: "Done", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-danger", text: "text-danger" },
};

export function StatusPill({ status }: { status: TaskStatus }) {
  const s = statusStyles[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-medium", s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

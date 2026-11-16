"use client";

import { cn } from "@/lib/utils";
import { useApp, type Tab } from "@/lib/store";
import { ThemeToggle } from "@/components/theme-toggle";
import { ScreenControls } from "@/components/shell/screen-controls";
import { PingsBell } from "@/components/shell/pings-bell";
import { ConversationControl } from "@/components/shell/conversation-control";
import { OpenViewButton, WorkspacesButton } from "@/components/shell/side-view";
import { PanelLeft, PanelRightClose, PanelRightOpen, MessageSquare, FolderKanban, Globe } from "lucide-react";
import { MarigoldIcon } from "@/components/marigold-icon";
import { isAux } from "@/lib/aux";
import { useState } from "react";

const TABS: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "projects", label: "Projects", icon: FolderKanban },
];

export function TopNav() {
  const [aux] = useState(() => isAux());
  const activeTab = useApp((s) => s.activeTab);
  const setTab = useApp((s) => s.setTab);
  const setSidebarOpen = useApp((s) => s.setSidebarOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const collapsedPref = useApp((s) => s.sidebarCollapsed);
  const autoHidden = useApp((s) => s.sidebarAutoHidden);
  const collapsed = collapsedPref || autoHidden;
  const setCollapsedPref = useApp((s) => s.setSidebarCollapsed);
  const setAutoHidden = useApp((s) => s.setSidebarAutoHidden);
  const setCollapsed = (v: boolean) => { setAutoHidden(false); setCollapsedPref(v); };
  const projectChatOpen = useApp((s) => s.projectChatOpen);
  const dockHidden = useApp((s) => s.dockHidden);
  const setDockHidden = useApp((s) => s.setDockHidden);
  const dockOn = activeTab === "chats" || (activeTab === "projects" && projectChatOpen); // the apps panel lives beside chats

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      {/* Mobile: open the sidebar drawer. */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover md:hidden"
        aria-label="Open menu"
      >
        <PanelLeft size={17} />
      </button>

      {/* Desktop: only shown when the sidebar is collapsed, to bring it back. */}
      {collapsed && (
        <div className="hidden items-center gap-1.5 md:flex">
          <button
            onClick={() => setCollapsed(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
            aria-label="Show sidebar"
          >
            <PanelLeft size={17} />
          </button>
          <MarigoldIcon size={22} />
        </div>
      )}

      {/* Tabs */}
      <nav className="flex items-center gap-0.5 rounded-lg bg-surface p-0.5">
        {TABS.filter((t) => !(aux && t.id === "browser")).map((t) => {
          const active = activeTab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1">
        <ConversationControl />
        {!aux && <WorkspacesButton />}
        {!aux && <OpenViewButton />}
        <ScreenControls />
        {dockOn && (
          <button
            onClick={() => setDockHidden(!dockHidden)}
            title={dockHidden ? "Show your apps" : "Hide your apps"}
            aria-label={dockHidden ? "Show your apps" : "Hide your apps"}
            aria-pressed={!dockHidden}
            className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors hover:bg-surface-hover", dockHidden ? "text-muted hover:text-foreground" : "text-foreground")}
          >
            {dockHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            <span className="hidden lg:inline">Apps</span>
          </button>
        )}
        <PingsBell />
        <ThemeToggle />
      </div>
    </header>
  );
}

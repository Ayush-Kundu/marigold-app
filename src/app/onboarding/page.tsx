"use client";

import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import { capabilities } from "@/lib/mock-data";
import { ToolGlyph } from "@/components/tool-glyph";
import { Button } from "@/components/ui/button";
import { MarigoldIcon } from "@/components/marigold-icon";
import { Mail, ArrowRight } from "lucide-react";

export default function OnboardingPage() {
  const router = useRouter();
  const name = useApp((s) => s.user.name);

  const run = (prompt: string) => {
    // Kick off the task against the shared store, then drop the user into the app.
    useApp.getState().newChat();
    useApp.getState().sendUserMessage(prompt);
    router.push("/");
  };

  return (
    <div className="min-h-dvh overflow-y-auto bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4">
            <MarigoldIcon size={48} />
          </div>
          <h1 className="text-2xl font-semibold">You&apos;re in, {name}.</h1>
          <p className="mt-2 max-w-md text-muted">
            Let&apos;s get the first thing off your plate. Want me to send an email
            to kick things off — or pick anything below.
          </p>
        </div>

        {/* Hero suggestion: send an email */}
        <button
          onClick={() => run("Draft and send an intro email to my new teammate welcoming them.")}
          className="group mt-8 flex w-full items-center gap-4 rounded-2xl border border-accent bg-accent-soft p-4 text-left transition-transform hover:scale-[1.01]"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <Mail size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Send an email to get started</p>
            <p className="text-sm text-muted">
              I&apos;ll draft it and show you before anything sends.
            </p>
          </div>
          <ArrowRight size={18} className="shrink-0 text-accent transition-transform group-hover:translate-x-0.5" />
        </button>

        <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Or here&apos;s what else I can do
        </h2>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {capabilities.map((c) => (
            <button
              key={c.id}
              onClick={() => run(c.example)}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-accent"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                <ToolGlyph tool={c.tool} size={17} className="text-accent" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted">{c.example}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="mt-8 flex justify-center">
          <Button variant="ghost" onClick={() => router.push("/")}>
            Skip for now — take me to the app
          </Button>
        </div>
      </div>
    </div>
  );
}

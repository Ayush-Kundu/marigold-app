"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { nativeApp } from "@/lib/native";

/**
 * "Take a photo": a live camera preview, then one click attaches the picture to the message, so you can show Marigold
 * what you're looking at. The camera is on only while this window is open, and nothing is saved until you press Use photo.
 */
export function CameraDialog({ onClose, onPhoto }: { onClose: () => void; onPhoto: (file: File) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    (async () => {
      try {
        await nativeApp()?.requestPermission?.("camera"); // makes macOS ask the first time
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => {}); }
        setReady(true);
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(name === "NotAllowedError" || name === "SecurityError" ? "Camera access is off for Marigold. Turn it on in System Settings → Privacy & Security → Camera, then try again." : name === "NotFoundError" ? "No camera found on this Mac." : "Couldn't start the camera.");
      }
    })();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); window.removeEventListener("keydown", esc); };
  }, [onClose]);

  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { onPhoto(new File([b], `photo-${Date.now()}.jpg`, { type: "image/jpeg" })); onClose(); } }, "image/jpeg", 0.9);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="flex items-center gap-2 text-[14px] font-semibold"><Camera size={15} /> Take a photo</p>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-hover hover:text-foreground"><X size={16} /></button>
        </div>
        {error ? (
          <div className="space-y-3 px-4 pb-5 text-[13px]">
            <p className="text-danger">{error}</p>
            <button onClick={() => void nativeApp()?.requestPermission?.("camera")} className="h-8 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">Open camera settings</button>
          </div>
        ) : (
          <>
            <div className="relative bg-black">
              <video ref={video} muted playsInline className="aspect-video w-full -scale-x-100 object-cover" />
              {!ready && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-white/70">Starting the camera…</p>}
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-[11.5px] text-muted">The camera is only on while this window is open.</p>
              <div className="flex gap-2">
                <button onClick={onClose} className="h-8 rounded-lg border border-border px-3 text-[12.5px] hover:bg-surface-hover">Cancel</button>
                <button onClick={snap} disabled={!ready} className="h-8 rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-foreground disabled:opacity-40">Use photo</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Is this one of the extra Marigold windows (⌘N)? Those are chat windows: the Browser and the listening/speaking helpers stay with the main window. */
export function isAux(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (location.search.includes("aux=1")) window.name = "marigold-aux";
    return window.name === "marigold-aux";
  } catch { return false; }
}

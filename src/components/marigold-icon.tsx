/**
 * Marigold flower logo — a layered gold rosette. Full-color (not currentColor)
 * so it reads as a marigold wherever the brand mark appears.
 */
/**
 * state:
 *  - "stream": breathing pulse while the agent is answering
 *  - "idle":   twirls up and lands every 10s
 *  - "static": no motion (default; used for brand marks and while the user types)
 */
export function MarigoldIcon({
  size = 16,
  className,
  state = "static",
}: {
  size?: number;
  className?: string;
  state?: "stream" | "idle" | "static";
}) {
  // Outer petals at 30° steps, inner petals offset by 15°.
  const outer = Array.from({ length: 12 }, (_, i) => i * 30);
  const inner = Array.from({ length: 8 }, (_, i) => 15 + i * 45);
  const anim =
    state === "stream" ? "marigold-stream" : state === "idle" ? "marigold-idle" : "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={[anim, className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <g fill="#e8a317">
        {outer.map((a) => (
          <ellipse key={`o${a}`} cx="12" cy="4.9" rx="2" ry="4.3" transform={`rotate(${a} 12 12)`} />
        ))}
      </g>
      <g fill="#f6c04b">
        {inner.map((a) => (
          <ellipse key={`i${a}`} cx="12" cy="7.4" rx="1.7" ry="3.1" transform={`rotate(${a} 12 12)`} />
        ))}
      </g>
      <circle cx="12" cy="12" r="3.1" fill="#c47d0a" />
      <circle cx="12" cy="12" r="1.3" fill="#e8a317" />
    </svg>
  );
}

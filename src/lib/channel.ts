/**
 * Which kind of build this is. "tester" (the default) has the testing tools: invite code, own-AI-key option, Advanced settings.
 * Build the public release with MARIGOLD_CHANNEL=store sh scripts/release.sh: none of those exist in it, and no key or invite ships.
 */
export const TESTER_BUILD = process.env.NEXT_PUBLIC_MARIGOLD_CHANNEL !== "store";

import { promises as fs } from "fs";
import path from "path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { MARIGOLD_DIR } from "./policy";

/**
 * Touch ID for money actions, via WebAuthn with the Mac's built-in platform
 * authenticator (Secure Enclave). The private key never leaves the chip; the
 * server only stores the public key and verifies a fresh signature over a
 * challenge bound to the specific approval being granted.
 */

const FILE = path.join(MARIGOLD_DIR, "webauthn.json");
const RP_NAME = "Marigold";

interface Stored {
  credentials: { id: string; publicKey: string; counter: number; transports?: string[] }[];
}

const g = globalThis as unknown as { __marigoldChallenges?: Map<string, string> };
/** key → expected challenge ("register" or the approval step id). */
const challenges = (g.__marigoldChallenges ??= new Map());

async function load(): Promise<Stored> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return { credentials: [] };
  }
}
async function save(s: Stored) {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

const toCred = (c: Stored["credentials"][number]): WebAuthnCredential => ({
  id: c.id,
  publicKey: Buffer.from(c.publicKey, "base64url"),
  counter: c.counter,
  transports: c.transports as WebAuthnCredential["transports"],
});

export const hasBiometric = async () => (await load()).credentials.length > 0;

export async function registrationOptions(rpID: string) {
  const s = await load();
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: "marigold-owner",
    attestationType: "none",
    excludeCredentials: s.credentials.map((c) => ({ id: c.id })),
    authenticatorSelection: {
      authenticatorAttachment: "platform", // Touch ID / Face ID only — not a phone or USB key
      userVerification: "required",
      residentKey: "preferred",
    },
  });
  challenges.set("register", opts.challenge);
  return opts;
}

export async function verifyRegistration(resp: RegistrationResponseJSON, rpID: string, origin: string) {
  const expectedChallenge = challenges.get("register");
  if (!expectedChallenge) throw new Error("No registration in progress");
  challenges.delete("register");
  const v = await verifyRegistrationResponse({
    response: resp,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) return false;
  const { credential } = v.registrationInfo;
  const s = await load();
  s.credentials.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports,
  });
  await save(s);
  return true;
}

export async function authenticationOptions(stepId: string, rpID: string) {
  const s = await load();
  if (s.credentials.length === 0) return null;
  const opts = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: s.credentials.map((c) => ({ id: c.id })),
  });
  challenges.set(`step:${stepId}`, opts.challenge);
  return opts;
}

/** Verify a Touch ID assertion made for one specific approval step. */
export async function verifyForStep(stepId: string, resp: AuthenticationResponseJSON, rpID: string, origin: string) {
  const expectedChallenge = challenges.get(`step:${stepId}`);
  if (!expectedChallenge) return false;
  challenges.delete(`step:${stepId}`);
  const s = await load();
  const stored = s.credentials.find((c) => c.id === resp.id);
  if (!stored) return false;
  const v = await verifyAuthenticationResponse({
    response: resp,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: toCred(stored),
    requireUserVerification: true,
  });
  if (!v.verified) return false;
  stored.counter = v.authenticationInfo.newCounter;
  await save(s);
  return true;
}

export async function removeBiometrics() {
  await save({ credentials: [] });
}

/** rpID + origin from a request already vetted by localOnly(). */
export function rpFrom(req: Request) {
  const host = req.headers.get("host") ?? "localhost";
  const origin = req.headers.get("origin") ?? `http://${host}`;
  return { rpID: new URL(origin).hostname, origin };
}

// Wallets: discovery (EIP-6963, with the legacy injected provider as a fallback) and sign-in (SIWE).
// Signing in is a signature on a message. Nothing here builds, signs or sends a transaction.

import { api } from "../api";
import { refreshMe } from "./hooks";

export type Eip1193 = { request(args: { method: string; params?: unknown }): Promise<unknown> };
export type Wallet = { id: string; name: string; icon: string | null; provider: Eip1193 };

type Announce = { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 };

/** Only inline images are accepted as wallet icons; anything else is dropped. */
export function safeIcon(icon: unknown): string | null {
  return typeof icon === "string" && /^data:image\/(png|svg\+xml|webp|jpeg|gif)[;,]/i.test(icon) ? icon : null;
}

/** Turn an announcement into a wallet, or null when it is malformed. */
export function fromAnnounce(d: Announce | null | undefined): Wallet | null {
  const info = d?.info;
  if (!info || !d.provider || typeof d.provider.request !== "function") return null;
  const id = info.rdns || info.uuid;
  if (!id) return null;
  return { id, name: (info.name ?? "").trim().slice(0, 40) || "Wallet", icon: safeIcon(info.icon), provider: d.provider };
}

/** Find the wallets in this browser. Calls back with the full list whenever it changes. Returns a stop function. */
export function discover(onChange: (wallets: Wallet[]) => void): () => void {
  const found = new Map<string, Wallet>();
  const emit = (): void => onChange([...found.values()]);
  const onAnnounce = (e: Event): void => {
    const w = fromAnnounce((e as CustomEvent<Announce>).detail);
    if (!w) return;
    found.delete("injected");
    found.set(w.id, w);
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Wallets answer the request synchronously. Give late ones a moment, then fall back to the legacy global.
  const t = setTimeout(() => {
    const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (found.size === 0 && legacy && typeof legacy.request === "function") {
      found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: legacy });
    }
    if (import.meta.env.VITE_MOCK === "1") found.set("demo", demoWallet());
    emit();
  }, 120);
  return () => {
    clearTimeout(t);
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

export type Step = "connect" | "sign" | "verify";

export class WalletError extends Error {
  readonly code: "rejected" | "no_account" | "failed";
  constructor(code: WalletError["code"], message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

function rejected(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 4001 || code === "ACTION_REJECTED";
}

/** The message a wallet shows before signing. Kept here so it can be read and tested in one place. */
export const STATEMENT = "Sign in to Freeweight. This is a signature on a message: it sends no transaction and costs nothing.";

/** Connect, sign the sign-in message, verify it with the gateway. Resolves with the signed-in address. */
export async function signIn(wallet: Wallet, chainId: number, onStep: (s: Step) => void): Promise<string> {
  onStep("connect");
  const lib = import("./viem");
  let accounts: unknown;
  try {
    accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
  } catch (e) {
    throw rejected(e) ? new WalletError("rejected", "You declined the connection. Nothing was signed.") : new WalletError("failed", "The wallet did not connect. Unlock it and try again.");
  }
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string") throw new WalletError("no_account", "The wallet returned no account.");
  const { createSiweMessage, getAddress, stringToHex } = await lib;
  const address = getAddress(first);
  const nonce = await api.nonce();

  onStep("sign");
  const message = createSiweMessage({
    address,
    chainId,
    domain: location.host,
    uri: location.origin,
    nonce,
    version: "1",
    statement: STATEMENT,
    issuedAt: new Date(),
  });
  let signature: unknown;
  try {
    signature = await wallet.provider.request({ method: "personal_sign", params: [stringToHex(message), address] });
  } catch (e) {
    throw rejected(e) ? new WalletError("rejected", "You declined the signature. You are not signed in.") : new WalletError("failed", "The wallet could not sign the message.");
  }
  if (typeof signature !== "string") throw new WalletError("failed", "The wallet returned no signature.");

  onStep("verify");
  await api.verify(message, signature);
  const me = await refreshMe();
  return me.address ?? address;
}

/** Mock mode only: a wallet that always agrees, so the flow can be seen without an extension. */
function demoWallet(): Wallet {
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    id: "demo",
    name: "Demo wallet",
    icon: null,
    provider: {
      async request({ method }) {
        await pause(500);
        if (method === "eth_requestAccounts") return ["0x52a1c0ffee9d3b7a8e6f4c2b0a9d8e7f6c5b4a3e"];
        if (method === "personal_sign") return `0x${"5a".repeat(65)}`;
        throw Object.assign(new Error("unsupported"), { code: 4200 });
      },
    },
  };
}

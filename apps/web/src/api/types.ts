// Contract 1: the gateway's public API, as the web app consumes it.

export type Tier = "light" | "medium" | "heavy";
/** `needs_load`: a pasted model whose stored weights were cleared. It wakes again after a first load. */
export type ModelState = "asleep" | "waking" | "awake" | "cold" | "unavailable" | "needs_load";

export type Model = {
  id: string;
  name: string;
  hf_repo: string;
  sha: string;
  license: string;
  params_b: number;
  quant: string;
  tier: Tier;
  price_usd_micro_per_min: number;
  context: number;
  owner: string | null;
  state: ModelState;
  /** Seconds a wake typically takes. Null (or 0) until one has been measured. */
  wake_estimate_s: number | null;
  /** The quick and the slow end of recent wakes, in seconds, from a gateway that measures them. Absent or 0: not measured. */
  wake_low_s?: number | null;
  wake_high_s?: number | null;
  tags: string[];
  blurb: string;
  tools_ok: boolean;
  /** `pasted`: somebody pasted its repo and paid for its first load. Nobody at Freeweight tested it. */
  origin?: "catalog" | "pasted";
  /** Only the account that loaded it sees it. */
  private?: boolean;
  /** This account loaded it. */
  mine?: boolean;
};

/** The free check of a pasted repo. A repo that cannot be served comes back with a code and a plain reason. */
export type RepoCheck =
  | { ok: false; repo: string; code: string; reason: string }
  | {
      ok: true;
      repo: string;
      sha: string;
      name: string;
      license: string;
      tier: Tier;
      size_bytes: number;
      params_b: number;
      context: number;
      architecture: string;
      price_usd_micro_per_min: number;
      load_cap_minutes: number;
      /** The most a first load costs. */
      load_cap_usd_micro: number;
      load_estimate_s: number;
      wake_estimate_s: number;
      state: "new" | "loading" | "loaded" | "needs_load";
      model_id: string | null;
      load_id: string | null;
      /** The state is that of the caller's own private copy. Nobody else's private copy is ever named. */
      private: boolean;
      can_load: boolean;
    };

export type LoadStage = "queued" | "checking" | "downloading" | "validating" | "starting" | "ready" | "failed";
/** The stages a first load goes through, in order. */
export const LOAD_STAGES: readonly LoadStage[] = ["queued", "checking", "downloading", "validating", "starting"];

/** The first load of a pasted model. The money fields are zero for everyone but the account that pays. */
export type Load = {
  id: string;
  model_id: string;
  hf_repo: string;
  sha: string;
  tier: Tier;
  state: "loading" | "ready" | "failed";
  stage: LoadStage;
  bytes: number;
  size_bytes: number;
  mine: boolean;
  price_usd_micro_per_min: number;
  cap_minutes: number;
  hold_usd_micro: number;
  charged_usd_micro: number;
  code?: string;
  detail?: string;
  created_at: number;
  ended_at: number | null;
  /** The gateway's clock when it wrote this, so elapsed time does not depend on this device's clock. */
  now: number;
};

/** A pasted model its loader sees in the account area. `clears_at` is null once the weights were cleared. */
export type MyModel = Model & { size_bytes: number; last_woken_at: number; clears_at: number | null };

export type PasteConfig = {
  /** False while no lane takes pasted models: the paste box says so and offers nothing. */
  open: boolean;
  engine: string;
  engine_version: string;
  load_cap_minutes: Record<Tier, number>;
  loads_per_day: number;
  clear_after_days: number;
};

export type Stage = "queued" | "gpu" | "container" | "weights" | "engine" | "ready" | "failed";
export type StageEvent = { stage: Stage; t_ms: number; detail?: string };

/**
 * Why a session is over. `stopped` on a failed session means the visitor cancelled the wake; `time` is the clock
 * running out; `idle` is the gateway ending a session nobody sent a request to for `idle_seconds`.
 */
export type ReceiptReason = "stopped" | "time" | "idle" | "wake_failed" | "wake_timeout" | "funding_error" | "model_lost";
export type Receipt = {
  /** GPU seconds over 60, to two decimals. Billing is by the second at the per-minute price. */
  minutes: number;
  price_usd_micro: number;
  tokens_out: number;
  wake_s: number;
  tokens_in?: number;
  gpu_seconds?: number;
  reason?: ReceiptReason | (string & {});
};

export type Session = {
  id: string;
  model_id: string;
  state: "waking" | "active" | "ended" | "failed";
  stages: StageEvent[];
  started_at: number | null;
  ends_at: number | null;
  now: number;
  base_url: string;
  spent_usd_micro: number;
  tokens_in: number;
  tokens_out: number;
  gpu_seconds: number;
  free: boolean;
  receipt?: Receipt;
  /**
   * The model is being woken again under a session that was already running: state is `waking` again, `started_at`
   * stays set, `ends_at` is null and the clock stands still until it is back.
   */
  paused?: boolean;
  /** When the session was asked for (epoch). The wake is timed from here, so a reloaded page shows the true elapsed time. */
  created_at?: number | null;
  /** Optional: stage detail is temporarily unavailable. The wake is still going; `stages` may be stale or short. */
  degraded?: boolean;
};

export type Awake = { model_id: string; since: number; sessions: number };
/**
 * `median_wake_s` is null until a wake has been timed. The two `hosted_` counters are the always-awake model's
 * own: its requests and tokens are not in the other figures. Absent from a gateway that does not offer it.
 */
export type Stats = { gpu_seconds: number; sessions: number; tokens: number; wakes: number; median_wake_s: number | null; hosted_requests?: number; hosted_tokens?: number };

/** The one model that is always awake and paid per token. Prices are USD micro per million tokens. */
export type HostedModel = {
  id: string;
  kind: "hosted";
  name: string;
  blurb: string;
  /** One public line that says where the model runs. */
  source: string;
  context: number;
  price_in_usd_micro_per_mtok: number;
  price_out_usd_micro_per_mtok: number;
  max_output_tokens: number;
  tools_ok: boolean;
  /** What a free message may be: how many a day, and how large. */
  free: { per_day: number; max_input_bytes: number; max_output_tokens: number };
  created_at: number;
};
/** One answered request to the always-awake model, as the account's history lists it. */
export type HostedUse = { id: string; at: number; surface: "api" | "chat"; free: boolean; tokens_in: number; tokens_out: number; charged_usd_micro: number };
/** What this visitor has used of the always-awake model. */
export type HostedAccount = {
  model_id: string;
  free_per_day: number;
  free_left: number;
  /** The next free message runs the human check first. */
  check_needed: boolean;
  recent: HostedUse[];
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at?: number | null;
  auto_session?: boolean;
};
export type NewKey = ApiKey & { key: string };

/** What holding or staking gives a wallet today. Everything but `enabled` is absent for a visitor and while perks are off. */
export type Perks = {
  enabled: boolean;
  /** The UTC day the allowance belongs to. Nothing rolls over. */
  day?: string;
  hold?: { tokens: string; tier: string | null; minutes: number } | null;
  stake?: { tokens: string; since: number; eligible: boolean; daily_usd_micro: number } | null;
  allowance_usd_micro?: number;
};

/** The account as the app uses it. The gateway nests the free try under `free_today`; the client flattens it. */
export type Me = {
  address: string | null;
  balance_usd_micro: number;
  /** Balance set aside for sessions that are running now. */
  held_usd_micro: number;
  /** Whether today's free try is still available to this visitor. */
  free_today: boolean;
  /** What is left of today's perk allowance. */
  allowance_usd_micro: number;
  keys: ApiKey[];
  perks: Perks;
  /** Sessions of this visitor that are waking or running now. */
  sessions: Session[];
  /** The line this wallet puts in a model README to list it. Null for a visitor. */
  listing_proof_line: string | null;
  /** Null when the gateway does not offer the always-awake model. */
  hosted: HostedAccount | null;
};

export type Credit = { asset: string; amount: string; credited_usd_micro: number; already_credited: boolean };
export type Topup = {
  credited_usd_micro: number;
  asset: string;
  amount: string;
  /** The transaction had been credited before: nothing was added this time. */
  already_credited?: boolean;
  credits?: Credit[];
  balance_usd_micro?: number;
};

/** One recent session from the public board: no account, no id, only what it used. */
export type PublicReceipt = { model_id: string; free: boolean; ended_at: number; minutes: number; price_usd_micro: number; tokens_out: number; wake_s: number };

export type Check = { name: string; ok: boolean; detail: string };
/**
 * `rejected`: a check failed (fix the repo and check again). `pending`: every check passed, waiting for a person.
 * `building`: approved, the weights are being prepared. `listed`: in the catalog. `failed`: the build did not finish.
 */
export type ListingState = "rejected" | "pending" | "building" | "listed" | "failed";
export type Listing = {
  id: string;
  hf_repo: string;
  sha: string;
  owner: string;
  state: ListingState;
  checks: Check[];
  tier: Tier | null;
  /** The exact line the owner's wallet must have in the model README. */
  proof_line?: string;
  size_bytes?: number;
  params_b?: number;
  license?: string;
  model_id?: string | null;
  detail?: string | null;
  created_at?: number;
};

/** Public config, flattened from the gateway's nested shape. The app works without it, on these defaults. */
export type Config = {
  prices_usd_micro_per_min: Record<Tier, number>;
  free_minutes: number;
  default_minutes: number;
  max_minutes: number;
  /** A session with no request for this long is ended by the gateway. */
  idle_seconds: number;
  turnstile_sitekey: string | null;
  chain_id: number;
  chain_name: string;
  treasury: string | null;
  topup_assets: { symbol: string; address: string | null; decimals: number }[];
  topup_confirmations: number;
  perks_enabled: boolean;
  owner_share_bps: number;
  /** The system note a client that runs its own tool loop puts in front of the conversation. */
  tool_system_note: string | null;
  paste: PasteConfig;
};
export const DEFAULT_CONFIG: Config = {
  prices_usd_micro_per_min: { light: 30_000, medium: 60_000, heavy: 100_000 },
  free_minutes: 5,
  default_minutes: 10,
  max_minutes: 240,
  idle_seconds: 300,
  turnstile_sitekey: null,
  chain_id: 4663,
  chain_name: "Robinhood Chain",
  treasury: null,
  topup_assets: [],
  topup_confirmations: 20,
  perks_enabled: false,
  owner_share_bps: 3000,
  tool_system_note: null,
  paste: { open: false, engine: "", engine_version: "", load_cap_minutes: { light: 5, medium: 10, heavy: 15 }, loads_per_day: 5, clear_after_days: 28 },
};

export const TIERS: readonly Tier[] = ["light", "medium", "heavy"];
export const STAGES: readonly Exclude<Stage, "failed">[] = ["queued", "gpu", "container", "weights", "engine", "ready"];

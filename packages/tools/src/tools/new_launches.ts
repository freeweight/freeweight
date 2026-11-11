import { CHAINS } from "../chains.js";
import { geckoNewPools, LAUNCHPADS, ponsNewest, type LaunchRow } from "../sources/launches.js";
import { defineTool } from "../tool.js";
import { chainArg, CHAIN_PROP, fmtAge, fmtUsd, InputError, int, short, str } from "../util/args.js";
import { HttpError } from "../util/http.js";
import { quoteUntrusted } from "../util/page.js";

/** Said with every failure: a model must not read "no list" as "no launches". */
const UNREAD = "This is not an answer about what launched: nothing was read. Try again in a minute.";

/** Pages of 40 read from a launchpad list per call when filters leave too few rows. */
const MAX_PAGES = 3;

function optInt(args: Record<string, unknown>, key: string, max: number): number | null {
  return args[key] === undefined || args[key] === null || args[key] === "" ? null : int(args, key, 0, 0, max);
}

function line(r: LaunchRow): string {
  const bits = [r.age_minutes === null ? "age unknown" : `${fmtAge(r.age_minutes * 60_000)} old`];
  if (r.market_cap_usd !== null) bits.push(`mc ${fmtUsd(r.market_cap_usd)}`);
  if (r.stage === "curve" && r.curve_progress_pct !== null) bits.push(`curve ${r.curve_progress_pct}%`);
  else if (r.stage === "graduated") bits.push("graduated");
  else if (r.liquidity_usd !== null) bits.push(`liquidity ${fmtUsd(r.liquidity_usd)}`);
  return `${quoteUntrusted(r.symbol_untrusted, 14)} ${short(r.token)} (${bits.join(", ")})`;
}

export const newLaunches = defineTool({
  name: "new_launches",
  title: "New launches",
  description:
    "List the newest tokens on a chain, newest first: what just launched, on which launchpad or exchange, how old it is, market cap, liquidity and " +
    "(for launchpad tokens) bonding-curve progress, creator and links. On Robinhood Chain the list comes from the Pons launchpad's public list plus " +
    "GeckoTerminal's new pools; on other chains from GeckoTerminal's new pools. Use it for questions like 'recent Pons launches' or 'what is new on Base'. " +
    "It lists, it does not judge: run safety_check or token_overview on a token before saying anything about its quality.",
  inputSchema: {
    type: "object",
    properties: {
      chain: CHAIN_PROP,
      launchpad: { type: "string", description: 'Only tokens from this launchpad. Supported: "pons" (Robinhood Chain). Omit for everything new on the chain.' },
      stage: { type: "string", enum: ["curve", "graduated"], description: "Launchpad tokens only: still on the bonding curve, or graduated to a pool." },
      limit: { type: "integer", minimum: 1, maximum: 25, description: "Rows to return. Default 10." },
      min_age_minutes: { type: "integer", minimum: 0, description: "Only tokens at least this old." },
      max_age_minutes: { type: "integer", minimum: 1, description: "Only tokens at most this old, e.g. 60 for the last hour." },
      min_liquidity_usd: { type: "number", minimum: 0, description: "Only tokens with at least this much liquidity (pool reserve, or the amount raised on a bonding curve)." },
    },
    additionalProperties: false,
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const pad = str(args, "launchpad", 40)?.toLowerCase() ?? null;
    const padList = Object.entries(LAUNCHPADS)
      .map(([k, v]) => `${k} (${CHAINS.find((c) => c.id === v.chainId)?.name ?? v.chainId})`)
      .join(", ");
    if (pad !== null && !LAUNCHPADS[pad]) throw new InputError("invalid_input", `unknown launchpad ${JSON.stringify(pad)}; supported: ${padList}. Omit launchpad to list everything new on the chain.`);
    if (pad !== null && LAUNCHPADS[pad]!.chainId !== chain.id) throw new InputError("invalid_input", `${LAUNCHPADS[pad]!.name} is a launchpad on Robinhood Chain, not on ${chain.name}. Omit launchpad to list new pools on ${chain.name}.`);
    const stageArg = str(args, "stage", 20);
    if (stageArg !== null && stageArg !== "curve" && stageArg !== "graduated") throw new InputError("invalid_input", 'stage must be "curve" or "graduated"');
    const stage: "curve" | "graduated" | null = stageArg;
    const hasPad = Object.values(LAUNCHPADS).some((l) => l.chainId === chain.id);
    if (stage !== null && !hasPad) throw new InputError("invalid_input", `stage applies to launchpad tokens (${padList}); ${chain.name} has no supported launchpad.`);
    const limit = int(args, "limit", 10, 1, 25);
    const minAge = optInt(args, "min_age_minutes", 10_000_000);
    const maxAge = optInt(args, "max_age_minutes", 10_000_000);
    if (minAge !== null && maxAge !== null && minAge > maxAge) throw new InputError("invalid_input", "min_age_minutes is larger than max_age_minutes");
    const minLiqRaw = args.min_liquidity_usd;
    const minLiq = minLiqRaw === undefined || minLiqRaw === null || minLiqRaw === "" ? null : Number(minLiqRaw);
    if (minLiq !== null && (!Number.isFinite(minLiq) || minLiq < 0)) throw new InputError("invalid_input", "min_liquidity_usd must be a number, 0 or more");

    let noLiquidityFigure = 0;
    const keep = (r: LaunchRow): boolean => {
      if (minAge !== null && (r.age_minutes === null || r.age_minutes < minAge)) return false;
      if (maxAge !== null && (r.age_minutes === null || r.age_minutes > maxAge)) return false;
      if (minLiq !== null && minLiq > 0) {
        if (r.liquidity_usd === null) {
          noLiquidityFigure++;
          return false;
        }
        if (r.liquidity_usd < minLiq) return false;
      }
      return true;
    };

    // A stage is a launchpad notion, so asking for one narrows the list to the launchpad.
    const usePad = hasPad;
    const usePools = pad === null && stage === null && !!chain.geckoterminal;

    const poolsP = usePools
      ? geckoNewPools(run, chain).then(
          (rows) => ({ rows, err: null as unknown }),
          (err: unknown) => ({ rows: [] as LaunchRow[], err }),
        )
      : Promise.resolve({ rows: [] as LaunchRow[], err: null as unknown });

    const padRows: LaunchRow[] = [];
    let padScanned = 0;
    let padOldest: number | null = null;
    let padMore = false;
    let padErr: unknown = null;
    if (usePad) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        let got: { rows: LaunchRow[]; next: string | null };
        try {
          got = await ponsNewest(run, { stage, cursor });
        } catch (e) {
          if (page === 0) padErr = e;
          else run.miss("pons", e);
          break;
        }
        padScanned += got.rows.length;
        for (const r of got.rows) {
          if (r.age_minutes !== null) padOldest = Math.max(padOldest ?? 0, r.age_minutes);
          if (keep(r)) padRows.push(r);
        }
        cursor = got.next;
        padMore = cursor !== null;
        const pastWindow = maxAge !== null && padOldest !== null && padOldest > maxAge;
        if (padRows.length >= limit || !padMore || pastWindow) break;
      }
    }
    const pools = await poolsP;

    const rateLimited = (e: unknown) => e instanceof HttpError && e.status === 429;
    const why = (e: unknown) => (rateLimited(e) ? "it is rate-limiting this server" : `it did not answer (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`);
    const data: Record<string, unknown> = {
      chain: chain.key,
      chain_id: chain.id,
      launchpad: pad ?? (stage !== null ? "pons" : null),
      filters: { stage, min_age_minutes: minAge, max_age_minutes: maxAge, min_liquidity_usd: minLiq },
    };
    const tail = { supported_launchpads: Object.fromEntries(Object.entries(LAUNCHPADS).map(([k, v]) => [k, CHAINS.find((c) => c.id === v.chainId)?.key ?? String(v.chainId)])), supported_chains: CHAINS.map((c) => c.key) };

    if (usePad && padErr && (!usePools || pools.err)) {
      const msg = `New launches on ${chain.name} could not be read: ${usePools ? "neither the Pons list nor GeckoTerminal answered" : `the Pons list did not answer (${(padErr instanceof Error ? padErr.message : String(padErr)).slice(0, 80)})`}. ${UNREAD}`;
      return { ok: false, summary: msg, data: { ...data, ...tail }, error: { code: "upstream_error", message: msg } };
    }
    if (!usePad && pools.err) {
      const msg = `New launches on ${chain.name} could not be read: GeckoTerminal is the only source for new pools there and ${why(pools.err)}. ${UNREAD}`;
      return { ok: false, summary: msg, data: { ...data, ...tail }, error: { code: "upstream_error", message: msg } };
    }
    if (padErr) {
      run.partial = true;
      run.note(`The Pons list was not checked: ${why(padErr)}. Rows are new pools only.`);
    }
    if (usePad && usePools && pools.err) {
      run.partial = true;
      run.note(`Rows are Pons launches only. New pools outside Pons (other launchpads, tokens put straight into a pool) were not checked: GeckoTerminal is the source for those and ${why(pools.err)}.`);
    }

    // Launchpad rows win; a pool of a launchpad token is that token graduating, not a new launch.
    const seen = new Set(padRows.map((r) => r.token));
    const poolRows = pools.rows.filter((r) => {
      if (r.launchpad !== null || seen.has(r.token) || !keep(r)) return false;
      seen.add(r.token);
      return true;
    });
    const all = [...padRows, ...poolRows].sort((a, b) => (a.age_minutes ?? Infinity) - (b.age_minutes ?? Infinity));
    const launches = all.slice(0, limit);

    const filtered = minAge !== null || maxAge !== null || (minLiq !== null && minLiq > 0);
    if (usePad && !padErr && filtered && padRows.length < limit && padMore && !(maxAge !== null && padOldest !== null && padOldest > maxAge)) {
      run.note(`Only the newest ${padScanned} Pons launches were read (back to ${fmtAge((padOldest ?? 0) * 60_000)} ago); older tokens that match the filters are not listed.`);
    }
    if (usePools && !pools.err && filtered) run.note("New pools outside a launchpad come from one page of the 20 newest; older pools that match the filters are not listed.");
    if (noLiquidityFigure > 0) run.note(`${noLiquidityFigure} token(s) without a liquidity figure (graduated launchpad tokens) were left out by min_liquidity_usd.`);

    const where = `${chain.name}${data.launchpad ? " (Pons)" : ""}`;
    const head = launches.length ? `${launches.length} newest launch(es) on ${where}` : `No launches on ${where} match`;
    const shown = launches.slice(0, 4).map(line).join("; ");
    const more = launches.length > 4 ? `; and ${launches.length - 4} more in data.launches` : "";
    return {
      summary: launches.length ? `${head}: ${shown}${more}. Figures are the sources' own, not checked on chain.` : `${head} the filters.`,
      data: { ...data, count: launches.length, launches, ...tail },
    };
  },
});

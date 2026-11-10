// The catalog: a dense table, never cards. Filters live in the URL so a filtered view can be shared.

import { useEffect, useMemo, useState } from "react";
import { TIERS, type Model, type Tier } from "../api";
import { filterModels, isFiltered, NO_FILTERS, readFilters, tagsOf, toQuery, type Filters, type SortKey, type StateFilter } from "../lib/catalog";
import { context, params as fmtParams, perMin, TIER_NAME } from "../lib/format";
import { loadFailed, refreshLive, useLive, useTitle } from "../lib/hooks";
import { Link, navigate } from "../router";
import { Icon, Notice, Segmented, StateTag, TierMark } from "../ui/bits";
import "./catalog.css";

const STATE_OPTIONS: readonly { value: StateFilter; label: string }[] = [
  { value: "all", label: "Any state" },
  { value: "awake", label: "Awake" },
  { value: "asleep", label: "Asleep" },
  { value: "cold", label: "Cold" },
];
const TIER_OPTIONS: readonly { value: Tier | "all"; label: string }[] = [{ value: "all", label: "All classes" }, ...TIERS.map((t) => ({ value: t, label: TIER_NAME[t] }))];

const COLS: { key: SortKey | null; label: string; cls: string }[] = [
  { key: "name", label: "Model", cls: "c-model" },
  { key: "tier", label: "Class", cls: "c-class" },
  { key: "price", label: "Price", cls: "c-price" },
  { key: "params", label: "Params", cls: "c-params" },
  { key: null, label: "Quant", cls: "c-quant" },
  { key: "context", label: "Context", cls: "c-ctx" },
  { key: null, label: "Licence", cls: "c-lic" },
  { key: "state", label: "State", cls: "c-state" },
];

export default function Catalog() {
  useTitle("Models");
  const { models, error } = useLive();
  const [f, setF] = useState<Filters>(() => readFilters(location.search));
  const patch = (p: Partial<Filters>): void => setF((cur) => ({ ...cur, ...p }));

  useEffect(() => {
    const to = location.pathname + toQuery(f);
    if (to !== location.pathname + location.search) navigate(to, { replace: true, keepScroll: true });
  }, [f]);

  const tags = useMemo(() => tagsOf(models ?? []), [models]);
  const rows = useMemo(() => (models ? filterModels(models, f) : null), [models, f]);
  const filtered = isFiltered(f);
  const awake = models?.filter((m) => m.state === "awake").length ?? 0;

  function sortBy(k: SortKey): void {
    setF((cur) => (cur.sort !== k ? { ...cur, sort: k, desc: false } : cur.desc ? { ...cur, sort: "", desc: false } : { ...cur, desc: true }));
  }

  return (
    <div className="wrap page catalog">
      <header className="page-head">
        <p className="micro">Catalog</p>
        <h1 className="h2">Models</h1>
        <p>Open text models, stored asleep. Wake one when you need it. The class sets the price per GPU minute, and an awake model can be joined at once.</p>
      </header>

      <div className="cat-bar">
        <div className="cat-bar-row">
          <label className="sr" htmlFor="cat-q">
            Search models
          </label>
          <input id="cat-q" className="input cat-q" type="search" placeholder="Search by name or repo" value={f.q} onChange={(e) => patch({ q: e.target.value })} autoComplete="off" spellCheck={false} />
          <Segmented label="Class" value={f.tier} onChange={(tier) => patch({ tier })} options={TIER_OPTIONS} />
          <Segmented label="State" value={f.state} onChange={(state) => patch({ state })} options={STATE_OPTIONS} />
        </div>
        <div className="cat-bar-row">
          {(!models || tags.length > 0) && (
            <div className="cat-tags" role="group" aria-label="Tag">
              {tags.map((t) => (
                <button key={t} type="button" className="chip" aria-pressed={f.tag === t} onClick={() => patch({ tag: f.tag === t ? "" : t })}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <p className="micro cat-count" aria-live="polite">
            {rows && models ? (
              <>
                {filtered ? `${rows.length} of ${models.length}` : models.length} {models.length === 1 ? "model" : "models"} · <span className={awake ? "accent" : undefined}>{awake} awake</span>
              </>
            ) : (
              " "
            )}
          </p>
        </div>
      </div>

      {!models && error ? (
        <Notice kind="err">
          The catalog did not load. {loadFailed(error)}{" "}
          <button type="button" className="link" onClick={refreshLive}>
            Try again
          </button>
        </Notice>
      ) : (
        <div className="cat" role="table" aria-label="Models" aria-busy={!rows} aria-rowcount={rows ? rows.length + 1 : undefined}>
          <div className="cat-head" role="row">
            {COLS.map((c) => {
              const on = c.key !== null && f.sort === c.key;
              return (
                <span key={c.label} role="columnheader" className={c.cls} aria-sort={on ? (f.desc ? "descending" : "ascending") : undefined}>
                  {c.key ? (
                    <button type="button" className={`cat-sort${on ? " on" : ""}${on && f.desc ? " desc" : ""}`} onClick={() => sortBy(c.key!)}>
                      {c.label}
                      <Icon name="up" size={12} />
                    </button>
                  ) : (
                    c.label
                  )}
                </span>
              );
            })}
          </div>
          {!rows ? (
            Array.from({ length: 8 }, (_, i) => (
              <div className="cat-row wait" role="row" key={i} aria-hidden="true">
                <div className="c-model" role="cell">
                  <span className="skel" style={{ width: `${44 + ((i * 17) % 30)}%`, height: 14 }} />
                </div>
                <div className="c-class" role="cell">
                  <span className="skel" style={{ width: 56 }} />
                </div>
                <div className="c-state" role="cell">
                  <span className="skel" style={{ width: 56 }} />
                </div>
              </div>
            ))
          ) : rows.length === 0 ? (
            <div className="cat-none">
              {models && models.length === 0 ? (
                <p>No models are listed yet.</p>
              ) : (
                <>
                  <p>No model matches these filters.</p>
                  <button type="button" className="btn sm" onClick={() => setF({ ...NO_FILTERS, sort: f.sort, desc: f.desc })}>
                    Clear filters
                  </button>
                </>
              )}
            </div>
          ) : (
            rows.map((m) => <Row key={m.id} m={m} />)
          )}
        </div>
      )}

      <p className="cat-foot small dimmer">
        Cold means the weights are not cached near a GPU yet, so the first wake takes longer. Have a model of your own?{" "}
        <Link className="link" href="/list">
          List it
        </Link>
      </p>
    </div>
  );
}

function Row({ m }: { m: Model }) {
  return (
    <div className={`cat-row${m.state === "unavailable" ? " off" : ""}`} role="row">
      <div className="c-model" role="cell">
        <span className="cat-nameline">
          <Link href={`/models/${encodeURIComponent(m.id)}`} className={`cat-name tw-${m.tier}`} title={m.name}>
            {m.name}
          </Link>
          {m.owner && <span className="tag">owner-listed</span>}
        </span>
        <span className="cat-repo mono">{m.hf_repo}</span>
      </div>
      <div className="c-class" role="cell">
        <TierMark tier={m.tier} />
      </div>
      <div className="c-price mono" role="cell">
        {perMin(m.price_usd_micro_per_min)}
      </div>
      <div className="c-params mono" role="cell">
        {fmtParams(m.params_b)}
      </div>
      <div className="c-quant mono" role="cell">
        {m.quant}
      </div>
      <div className="c-ctx mono" role="cell">
        {context(m.context)}
      </div>
      <div className="c-lic" role="cell">
        {m.license}
      </div>
      <div className="c-state" role="cell">
        <StateTag state={m.state} />
      </div>
    </div>
  );
}

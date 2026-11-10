// Roadmap. The page is the mark at full size: three plates, each narrower and lighter than the one above,
// with what is live, what switches on at launch, and what comes after hanging under them.

import { useTitle } from "../lib/hooks";
import { Link } from "../router";
import { Icon } from "../ui/bits";
import { ROADMAP, type RoadmapGroup } from "./roadmap-data";
import "./roadmap.css";

const STATE: Record<RoadmapGroup["key"], { tag: string; brass: boolean; weight: string }> = {
  now: { tag: "live", brass: true, weight: "tw-heavy" },
  launch: { tag: "at launch", brass: false, weight: "tw-medium" },
  after: { tag: "planned", brass: false, weight: "tw-light" },
};

export default function Roadmap() {
  useTitle("Roadmap");
  return (
    <div className="wrap page rm">
      <header className="page-head">
        <p className="micro">Roadmap</p>
        <h1 className="h2">What works, what switches on, what comes after</h1>
        <p>The first list is live in the preview. The second switches on together at launch. The third is planned in the order shown, with no dates.</p>
      </header>

      {ROADMAP.map((g) => {
        const s = STATE[g.key];
        return (
          <section key={g.key} className={`rm-group rm-${g.key}`} aria-labelledby={`rm-${g.key}`}>
            <div className="rm-plate" aria-hidden="true" />
            <div className="rm-body">
              <header className="rm-h">
                <h2 className={`rm-title ${s.weight}`} id={`rm-${g.key}`}>
                  {g.title}
                </h2>
                <span className={`tag${s.brass ? " brass" : ""}`}>{s.tag}</span>
                <p className="rm-lead">{g.lead}</p>
              </header>
              <ol className="rm-items">
                {g.items.map((it, i) => (
                  <li key={it.title}>
                    <span className="rm-n mono" aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <b>{it.title}</b>
                    <p>{it.text}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        );
      })}

      <div className="rm-go">
        <Link href="/" className="btn primary">
          Try what is live
          <Icon name="arrow" />
        </Link>
        <Link href="/docs" className="btn">
          Read the docs
        </Link>
      </div>
    </div>
  );
}

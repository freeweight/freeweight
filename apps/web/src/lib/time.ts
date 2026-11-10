// Server-anchored clocks on a local monotonic timeline. The timeline runs at `rate`: 1 in production; the mock
// gateway raises it to replay a wake faster, or sets it to 0 to hold a moment still.

let rate = 1;
let base = 0;
let since = performance.now();

/** Local time on the scaled timeline (ms). */
function local(): number {
  return base + (performance.now() - since) * rate;
}

export function setTimeRate(r: number): void {
  base = local();
  since = performance.now();
  rate = r;
}
export function timeRate(): number {
  return rate;
}

export type Anchor = { value: number; at: number };

/** Anchor a server-side reading (ms) to the local timeline. */
export function anchor(value: number): Anchor {
  return { value, at: local() };
}
/** The anchored reading, advanced to now. */
export function read(a: Anchor): number {
  return a.value + (local() - a.at);
}

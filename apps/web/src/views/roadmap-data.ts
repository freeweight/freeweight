// The roadmap, in one place: the home teaser and the roadmap page both read it.

export type RoadmapItem = { title: string; text: string };
export type RoadmapGroup = { key: "now" | "launch" | "after"; title: string; lead: string; items: RoadmapItem[] };

export const ROADMAP: RoadmapGroup[] = [
  {
    key: "now",
    title: "In preview now",
    lead: "What works today, on a test address.",
    items: [
      { title: "Free 5-minute try", text: "One session a day on a Light model. No wallet, no signup." },
      { title: "Wake view", text: "Real stages and real timings while a GPU loads the model. Wake time is never billed." },
      { title: "Sessions by the minute", text: "A clock, extend, stop, and a receipt in GPU-seconds." },
      { title: "Session endpoint", text: "OpenAI-compatible chat and completions, with keys per wallet." },
      { title: "Chain toolkit", text: "Ten read-only tools for tokens on EVM chains, in chat and over MCP." },
      { title: "List a model", text: "Automatic checks on a Hugging Face repo. Listings are approved by hand for now." },
    ],
  },
  {
    key: "launch",
    title: "At launch",
    lead: "Switched on together, on the public domain.",
    items: [
      { title: "Top-ups", text: "Send ETH or USDG on Robinhood Chain, submit the transaction, get balance." },
      { title: "$WEIGHT", text: "One token. No contract exists yet, and anything claiming to be it before launch is not." },
      { title: "Staking credits", text: "Daily credits for staked $WEIGHT. They do not roll over." },
      { title: "Heavy class out of preview", text: "80 GB class models at $0.10 per GPU minute." },
    ],
  },
  {
    key: "after",
    title: "After launch",
    lead: "Planned, in this order, not dated.",
    items: [
      { title: "Keep-ready", text: "Pay a little to keep a model close to awake, for faster wakes." },
      { title: "Owner payouts on a schedule", text: "Owners earn 30% of rent on their model. It accrues in the ledger today; payouts are manual." },
      { title: "Self-serve listings", text: "Listing without a manual approval step." },
      { title: "Faster wakes", text: "The target is ready in under two minutes for Light and Medium, every time, then lower." },
    ],
  },
];

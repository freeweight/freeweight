# Roadmap

What is live in v0.1, what is planned for launch, and what is open with no date. Nothing here has a date.
"Planned" means not live: no user can use it today.

## Live in v0.1

v0.1 runs on a staging address, not on the public domain.

- **Three models:** `qwen3-8b` (Light), `qwen3-32b` (Medium) and `llama33-70b` (Heavy, preview). Each is pinned
  to a commit and has a context of 16384 tokens. Tool calling is on for the two Qwen3 models.
- **Sessions by the GPU minute.** Billed by the second, with a one-minute minimum once the model is awake. The
  wake is free, within a budget of uncharged wakes per account and a ceiling for the service as a whole.
- **The free try:** 5 minutes on a Light model, from the browser, after a human check.
- **The API:** the catalog, sessions with a live event stream, API keys (with `auto_session`), receipts, and an
  OpenAI-compatible `/v1`.
- **Eleven read-only research tools** over MCP at `/mcp`, and in the chat on the site.
- **Two serving lanes.** Only the Light model
  runs on both. Medium and Heavy run on one.
- **Listing checks** for model owners. Approval, builds and payouts are done by hand.

## Planned for launch

Written or designed, and not live.

- **The public domain.** Examples in the docs use `https://freeweight.xyz`. Until launch it shows a placeholder
  page and nothing else.
- **Top-ups** in ETH and USDG on Robinhood Chain. The verification code is written. Top-ups stay closed until a
  treasury address is configured.
- **A catalog of about ten models.** The three models above are what is listed today.
- **The token and the staking vault.** No token exists. `WeightVault` is written and tested and is not deployed.
- **Staker perks:** a daily credit for GPU minutes, computed by the service from the vault's views. The code is
  switched off and the rates are not set. See [ADR 0007](adr/0007-vault-holds-no-rewards.md).
- **The policies.** Terms, privacy and acceptable use are drafts. They come into force at public launch, after
  review, with a legal entity and a governing law filled in.

## Open, no date set

- **A holder tier:** a perk for wallets that hold the token without staking it. It needs a daily snapshot of
  balances first, so that the same tokens cannot count for two wallets on one day. The tier stays in the types
  and no code path grants it.
- **A warm grace period:** keeping a model up for a short time after its last session, so that the next renter
  needs no wake.
- **Abuse and rate-limit hardening.**
- **The known gaps between the parts:** a
  check of the catalog against what each lane serves, a job that prunes old rows, and a payout route for
  owners.
- **The Heavy model:** tool calling on it is not tested and its wake is not measured.

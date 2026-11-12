# 0007: The staking vault holds no rewards; credits are computed off-chain

- Status: accepted. The vault is written and tested, not deployed. No token exists yet.
- Date: 2026-11-10

## Context

Freeweight plans a token, $WEIGHT, whose stakers get free GPU minutes. A staking contract that pays
rewards needs a funded reward pool, emission rules and an oracle or an owner who can move value. Each of those is a
way to lose user funds, and each turns a usage perk into something that looks like yield.

## Decision

Split the two jobs.

- **On-chain: custody of stake only.** `WeightVault` (`contracts/src/WeightVault.sol`) lets a holder `stake`,
  `requestUnstake`, `cancelUnstake` and `withdraw` after a cooldown. It records how much each address has staked and
  since when. It holds no rewards, charges no fee, has no oracle, no pause switch and no upgrade path. The owner can
  change one thing, the cooldown for future unstake requests, within 0 to 30 days. The owner cannot move, freeze or
  seize a stake.
- **Off-chain: the perk.** Once a day per wallet, the gateway reads the wallet's `positionOf(address)` in the
  vault at one pinned block and writes credit to that day's allowance account in the ledger
  (in the gateway, not in this repository). Staking grants a daily credit proportional to the stake, up to a cap, and only
  for a stake older than a minimum age at the start of the UTC day.
- **Stake-only in v0.1.** A tier for wallets that hold without staking is roadmap. Read from the current
  balance, it could be collected on several wallets with the same tokens, so it needs a daily snapshot first.
  The holder tiers stay in the types (`PERK_HOLD_TIERS`) and no code path grants them.
- Credits are micro-USD of GPU time in the internal ledger. They are spent before the paid balance, expire with the
  day, cannot be transferred and cannot be withdrawn.
- Perks are off unless `STAKING_VAULT` is configured. In v0.1 it is unset. The stake rate
  (`PERK_STAKE_USD_MICRO_PER_TOKEN_DAY`) has no default that grants anything.

## Consequences

- The worst case for the vault is a bug in a small, non-upgradeable contract that only holds what users put in. No
  operator key can drain it.
- The service can change perk rates, or end them, without touching the contract. Users have to trust the service for
  the perk, and only for the perk.
- The stake age rule and the pinned-block read stop a stake that is moved between wallets from collecting twice on
  one day. `stakedSince` restarts on every increase of a stake.
- A failed chain read grants nothing and is retried on a later request. Nobody is credited from stale data.
- A perk is a discount on usage. The docs never describe it as a return.

## Alternatives

- **Rewards paid by the contract.** A funded pool, emission maths and a larger attack surface, for a benefit that is
  not the product.
- **Share of revenue to stakers.** Changes what the token is in law and in practice. Not considered for v0.1.
- **No vault, balance-only perks.** Simpler, but a balance can be borrowed for one block. The vault's cooldown and
  the age rule make the staker perk harder to game.

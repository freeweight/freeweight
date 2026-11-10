# WeightVault

A small staking vault for the `$WEIGHT` token on Robinhood Chain (chain id 4663).
Stake `$WEIGHT` and the Freeweight gateway grants you daily rent credits (minutes of GPU time).

The vault only **holds stake and exposes it for reading**. Credits are computed off-chain by the
gateway from the views below, so the contract has no rewards, no reward token, no fee, no
oracle and no pause. It is one contract (`src/WeightVault.sol`), one interface
(`src/IWeightVault.sol`), tests and a deploy script.

Status: written and tested, **not deployed**. Nothing in this directory holds or uses a private key.

## What it does

| Call | Effect |
|---|---|
| `stake(amount)` | Pulls `amount` of the token (needs a prior `approve`). Credits what the vault actually received. |
| `requestUnstake(amount, maxCooldown)` | Moves `amount` out of counted stake into a cooldown (default 7 days); `maxCooldown` is the longest cooldown you accept, and the call reverts `CooldownAboveMax` if the owner has raised it above that. It stops counting at once. A new request while something is still locked adds to the pending amount and moves the unlock of all of it to `max(old unlock, now + cooldown)`, so it is never shortened. If the pending amount has already matured the call reverts `WithdrawFirst`: withdraw it first. |
| `cancelUnstake()` | Puts all pending tokens back into counted stake. |
| `withdraw()` | After the cooldown, sends all pending tokens back. |
| `setCooldown(seconds)` | Owner only. 0 to 30 days, affects future requests only. |

A user has `staked` (counts for credits) and `pending` (cooldown, does not count). The token
balance of the vault is `>= totalStaked + totalPending`: equal unless someone sends tokens straight
to the vault, and those donations stay stranded.

### Why `stakedSince` and not checkpoints

The gateway needs "has this stake been here long enough?" (for example 24 hours before credits
count) so that stake, claim, unstake cycling inside a day earns nothing. We use one timestamp,
`stakedSince(user)`, the time of the user's latest **increase** of counted stake (`stake` or
`cancelUnstake`). It is cleared when the staked amount reaches zero. Properties:

- Simple and cheap: one storage slot half, no arrays, nothing to binary-search over `eth_call`.
- Conservative: topping up restarts the age for the whole balance, so a small old stake plus a
  large fresh one counts as fresh. Partial unstakes do not reset it.
- Cycling-proof: leaving (request, cooldown, withdraw) and coming back always starts a new clock.
  The cost of that simplicity is that a user who tops up often keeps resetting their own age;
  full history checkpoints (`stakedAt(user, ts)`) would avoid it but cost an array and more attack
  surface, and are not needed for "minimum age before credits count".

### Gateway read rule

1. Read `positionOf(user)` with `eth_call` at **one pinned block number** (never "latest" twice, never
   separate `stakedOf` and `stakedSince` calls: a large top-up between two reads would pair an old age
   with a new amount). Take the timestamp from that same block (`eth_getBlockByNumber`), not from the
   gateway's wall clock; sequencer timestamps can lag.
2. Credit UTC day D only if `since != 0` and `since + minAge <= dayStart(D)`, where `dayStart(D)` is
   00:00 UTC of day D. Comparing against the start of the day (not the claim time) gives at most one
   credit per full 24 hours held; comparing at claim time lets about 24 h of stake earn two days
   (claim at 23:59, then again at 00:00).
3. Credit the amount of stake still present at claim (`staked`, or the smaller of the readings at the
   day start and at claim). `pending` never counts.
4. Credits must be linear in stake: with per-address floors or rounding up, splitting stake across
   addresses becomes profitable.

## Trust model

- **Users:** only you can move your stake, and only by the 4 user calls above. Withdrawing
  returns exactly what the vault credited (what it received on `stake`; tokens with fees, rebasing or a blocklist are out of scope). The owner cannot freeze, seize, slash,
  pause, upgrade, redirect or charge anything.
- **Owner:** one power, `setCooldown` (0 to 30 days, hard bound in code), emitting `CooldownUpdated`.
  It cannot shorten or re-lock a request already made: a later request can only keep or extend the unlock of what is still locked, and matured funds must be withdrawn first. Ownership is
  `Ownable2Step` (propose then accept) and can be renounced, which freezes the cooldown for good.
- **Limits:** the token address is immutable; the token itself is trusted to be a plain ERC-20.
  Tokens sent to the vault directly (not via `stake`) are not accounted and cannot be recovered.
  The owner can raise the cooldown (up to 30 days) for requests made afterwards. A request states the
  longest cooldown it accepts (`maxCooldown`), so a raise ordered before it, even in the same block, makes
  it revert instead of locking you longer than you agreed to. Watch `CooldownUpdated`.

## How the gateway reads it

Everything the vault exposes, with selectors (checked with `cast sig`):

| Function | Selector | Who | Returns |
|---|---|---|---|
| `stake(uint256 amount)` | `0xa694fc3a` | user | |
| `requestUnstake(uint256 amount, uint256 maxCooldown)` | `0x68d4341f` | user | |
| `cancelUnstake()` | `0x4ab17969` | user | |
| `withdraw()` | `0x3ccfd60b` | user | |
| `setCooldown(uint256)` | `0x4fc3f41a` | owner | |
| `positionOf(address)` | `0xfd2d39c5` | read | `(uint256 staked, uint256 since, uint256 pending, uint256 unlockTime)`, one call: **the gateway uses this** |
| `stakedOf(address)` | `0xaf500ba3` | read | `uint256` counted stake (token units) |
| `stakedSince(address)` | `0xa15668d9` | read | `uint256` unix seconds, 0 if nothing staked |
| `pendingUnstake(address)` | `0x56d6ea4f` | read | `(uint256 amount, uint256 unlockTime)` |
| `totalStaked()` | `0x817b1cd2` | read | `uint256` |
| `totalPending()` | `0x3f90916a` | read | `uint256` |
| `cooldown()` | `0x787a08a6` | read | `uint256` seconds |
| `MAX_COOLDOWN()` / `DEFAULT_COOLDOWN()` | `0x8b41d35f` / `0x827059ff` | read | `uint256` |
| `token()` | `0xfc0c546a` | read | `address` |
| `owner()` / `pendingOwner()` | `0x8da5cb5b` / `0xe30c3978` | read | `address` |

All reads are plain `eth_call` (address of the vault as `to`, no signature needed). Call data is the
selector followed by the address left-padded to 32 bytes. Example, `positionOf`
for `0x1111111111111111111111111111111111111111`:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
  "to":"<VAULT_ADDRESS>",
  "data":"0xfd2d39c50000000000000000000000001111111111111111111111111111111111111111"
},"0x<PINNED_BLOCK_NUMBER_HEX>"]}
```

The result is 4 words of 32 bytes (staked, since, pending, unlockTime), each a uint256. The single-value views return one word, `pendingUnstake` two. With viem: `readContract({abi, functionName: "positionOf", args: [addr], blockNumber})`.

Events for indexers: `Staked(user, amount, newStaked)`, `UnstakeRequested(user, amount, unlockTime)` (`unlockTime` applies to all of the user's pending tokens, not only `amount`: model one pending balance per user, not a queue),
`UnstakeCancelled(user, amount)`, `Withdrawn(user, amount)`, `CooldownUpdated(old, new)`.
Reading at a past block (`eth_call` with a block tag) works on archive nodes if the gateway wants a
snapshot at a specific hour.

## Build and test

Dependencies are vendored under `lib/` (OpenZeppelin v5.4.0, the few files used, and forge-std),
so a fresh clone builds with no submodules and no network beyond the solc download:

```sh
cd contracts
forge build
forge test            # unit, fuzz (512 runs), invariants (128 runs x 64 depth)
forge fmt --check
forge snapshot        # writes .gas-snapshot
```

Tests cover every path and revert, cooldown boundaries (one second before / exactly at unlock,
zero cooldown), re-request rules (`WithdrawFirst`, never shortened), `maxCooldown`, the owner
bounds and two-step ownership, a fee-on-transfer token, a token that reports success but moves
nothing, and `positionOf`. Reentrancy from a malicious token is tried inside `stake` and `withdraw`
through every entry point, and each attempt must fail with `ReentrancyGuardReentrantCall`. A spy
token asserts, during the payout transfer, that the accounting is already final (checks-effects-
interactions); the same probe is shown to fail on a mutant that transfers first. `Regression.t.sol`
holds exploit attempts against earlier versions of the contract; each must fail. The invariant run (fail_on_revert on, handlers
pre-filter their preconditions) covers stake, request, cancel, withdraw (also warping to the unlock),
donations and cooldown changes, and checks: vault balance >= `totalStaked + totalPending` (and equal
once donations are subtracted), per-user sums equal the totals, conservation from measured balance
deltas, position bounds (`stakedSince <= now`, `unlockTime <= last request + 30 days`) and liveness
(a matured pending amount is always withdrawable for exactly `pending`).

Optional static analysis: `slither . --filter-paths "lib|test|script"`. The two findings (strict
equality on a zero check, timestamp comparison for the cooldown) are intended.

## Deployment checklist (manual owner step, not automated, not done)

1. The token `$WEIGHT` exists on chain 4663 (launched on the third-party launchpad). Note its address
   and check on the explorer that it is a plain ERC-20 (no transfer fee, no rebase, no blocklist).
2. Decide the owner: a multisig or a fresh wallet, not a hot key. Plan whether to renounce later.
3. Constructor args: `WeightVault(address token, address owner)`.
4. Deploy with a signer supplied on the command line (hardware wallet or encrypted keystore), never
   a raw key in a file or env var:
   ```sh
   export WEIGHT_TOKEN=0x...   # the token
   export VAULT_OWNER=0x...    # the owner
   forge script script/Deploy.s.sol --rpc-url <RH_RPC_URL> --ledger --broadcast
   ```
   Dry-run first by leaving out `--broadcast` (simulates only).
5. Verify on the Blockscout explorer:
   ```sh
   forge verify-contract <VAULT_ADDRESS> src/WeightVault.sol:WeightVault \
     --chain-id 4663 --verifier blockscout --verifier-url <EXPLORER_URL>/api/ \
     --constructor-args $(cast abi-encode "constructor(address,address)" $WEIGHT_TOKEN $VAULT_OWNER)
   ```
6. Check with `cast call`: `token()`, `owner()`, `cooldown()` (604800), `totalStaked()` (0).
7. Put the address in the gateway config as `STAKING_VAULT` (unset means staking perks are off).

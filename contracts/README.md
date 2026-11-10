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
| `requestUnstake(amount)` | Moves `amount` out of counted stake into a cooldown (default 7 days). It stops counting at once. A second request adds to the pending amount and restarts the clock for all of it. |
| `cancelUnstake()` | Puts all pending tokens back into counted stake. |
| `withdraw()` | After the cooldown, sends all pending tokens back. |
| `setCooldown(seconds)` | Owner only. 0 to 30 days, affects future requests only. |

A user has `staked` (counts for credits) and `pending` (cooldown, does not count). Total token
balance of the vault equals `totalStaked + totalPending`.

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

Gateway rule: credits count for `stakedOf(user)` if `stakedSince(user) != 0` and
`now - stakedSince(user) >= minAge`.

## Trust model

- **Users:** only you can move your stake, and only by the 4 user calls above. Withdrawing
  returns exactly what you put in (what the vault received). The owner cannot freeze, seize, slash,
  pause, upgrade, redirect or charge anything.
- **Owner:** one power, `setCooldown` (0 to 30 days, hard bound in code), emitting `CooldownUpdated`.
  It cannot change a request already made (its unlock time is fixed when requested). Ownership is
  `Ownable2Step` (propose then accept) and can be renounced, which freezes the cooldown for good.
- **Limits:** the token address is immutable; the token itself is trusted to be a plain ERC-20.
  Tokens sent to the vault directly (not via `stake`) are not accounted and cannot be recovered.
  A cooldown the owner raises to 30 days applies to anyone who requests afterwards, so watch the event.

## How the gateway reads it

All reads are plain `eth_call` (address of the vault as `to`, no signature needed). Selectors:

| Function | Selector | Returns |
|---|---|---|
| `stakedOf(address)` | `0xaf500ba3` | `uint256` counted stake (token units, 18 decimals for a standard ERC-20) |
| `totalStaked()` | `0x817b1cd2` | `uint256` |
| `pendingUnstake(address)` | `0x56d6ea4f` | `(uint256 amount, uint256 unlockTime)` |
| `stakedSince(address)` | `0xa15668d9` | `uint256` unix seconds, 0 if nothing staked |
| `totalPending()` | `0x3f90916a` | `uint256` |
| `cooldown()` | `0x787a08a6` | `uint256` seconds |
| `token()` | `0xfc0c546a` | `address` |

Call data is the selector followed by the address left-padded to 32 bytes. Example, `stakedOf`
for `0x1111111111111111111111111111111111111111`:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
  "to":"<VAULT_ADDRESS>",
  "data":"0xaf500ba30000000000000000000000001111111111111111111111111111111111111111"
},"latest"]}
```

The result is a 32-byte hex word (`0x...`), parsed as a uint256. `pendingUnstake` returns two
words (amount, then unlock time). With viem: `readContract({abi, functionName: "stakedOf", args: [addr]})`.

Events for indexers: `Staked(user, amount, newStaked)`, `UnstakeRequested(user, amount, unlockTime)`,
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
zero cooldown), the owner bounds and two-step ownership, a fee-on-transfer token, a token that
reports success but moves nothing, reentrancy from a malicious token (inside `stake` and
`withdraw`, all entry points), fuzzing of amounts and cooldowns, and invariants: vault balance ==
`totalStaked + totalPending`, per-user sums equal the totals, conservation of in minus out.

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

# 0006: Top-ups verified by reading the chain

- Status: accepted
- Date: 2026-11-10

## Context

Renters pay with ETH or USDG on Robinhood Chain (chain id 4663). The service must turn a payment into balance without
holding user keys, without a deposit contract to audit, and without signing anything itself.

## Decision

The user sends a normal transfer from their own wallet to the treasury address, then tells the gateway the
transaction hash. The gateway reads the chain and credits what it can prove (the gateway is not in this repository).

- The caller must be signed in with the wallet that paid. Only transfers **from the signed-in wallet to the treasury**
  count: the native value of the transaction, and each USDG `Transfer` log in it.
- The transaction must exist, must not have reverted, and must have at least 20 confirmations
  (`TOPUP_CONFIRMATIONS`). The RPC endpoint must report chain id 4663.
- USDG is credited 1:1 in USD. ETH is priced at the minute of its block from two public exchange price series
  (Coinbase and Kraken one-minute candles). Both must answer, agree within 2% and fall inside a sanity range. The
  lower one is used. An ETH transfer older than six hours is refused and left for a manual credit.
- Each transfer has its own ledger ref, `topup:<chain id>:<tx hash>:native` or `:log<index>`. The `topups` row and
  the `ledger` row are written in one D1 batch. Submitting the same hash again returns the earlier result with
  `already_credited: true`.
- Top-ups are closed (`503 topups_closed`) until `TREASURY_ADDRESS` is set.
- The gateway holds no private key. It has no code path that signs or sends a transaction.

## Consequences

- No custody: user funds are never in a contract or wallet the service operates on their behalf. A payment is a
  purchase of credit, final when it confirms.
- A transaction cannot be credited twice or claimed by another wallet. The sender is part of what is verified.
- The balance appears after about 20 blocks, and only after the user submits the hash. Nothing watches the treasury
  for incoming transfers, so a payment whose hash is never submitted is not credited until someone submits it.
- Verification depends on a working RPC endpoint and, for ETH, on two price sources. When they fail, the answer is
  `503` with a retry hint, and the transfer stays claimable.
- Refunds, if offered, are manual transfers from the treasury by the operator. There is no refund code.
- Payments are public: anyone can see which wallets paid the treasury, and how much.
- Smart-contract wallets that pay through an inner call are covered for USDG (the log names the wallet) but not for
  ETH, where the outer transaction's sender and recipient must be the wallet and the treasury.

## Alternatives

- **A deposit contract.** Credits could be read from one event, but it adds a contract that holds funds and must be
  audited.
- **A deposit address per user.** Needs key management and sweeping, which is custody.
- **Card payments.** Accounts, chargebacks and a processor. Not in v0.1.
- **Watching the treasury.** Removes the "submit the hash" step. It needs an indexer and a way to match senders to
  accounts, and is a possible later addition on top of the same verification.

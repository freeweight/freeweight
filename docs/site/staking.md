---
title: Staking
summary: The perks planned for stakers, and what exists today.
order: 90
group: Models
---

> [!WARNING]
> No Freeweight token exists yet. Nothing on this page is live. There is nothing to buy, hold or stake today, and
> anyone who offers you a Freeweight token before we announce one on this site is not us.

This page describes a planned design. It is meant to switch on at launch. The code for it is written, the
staking contract is not deployed and the perks are switched off. The numbers that matter, such as how much
credit a staked token gives per day, are not set yet.

## What the perks are

Perks are a discount on using the service. They are daily credit that pays for GPU minutes.

They are not income and not a return. Credit cannot be withdrawn, sent to another wallet, or turned into money or
tokens. Staking pays out no tokens. This page says nothing about the price of any token, and neither do we.

## Staking (planned, at launch)

Staking means locking tokens in the staking contract. A wallet with a stake gets credit every day, in proportion
to the amount staked.

- The credit is a fixed amount per staked token per day, up to a daily cap per wallet. The rate is not set yet.
- A stake counts for a day only if it was in place for at least 24 hours before that UTC day began. Staking in the
  morning does not earn credit the same day.
- Adding to a stake restarts that waiting time for the whole stake.
- Tokens that you have asked to unstake stop counting at once.
- Credit is counted in US dollars and can be spent on any tier. $0.30 of credit pays for ten minutes on a Light
  model.

## How credit is spent

- Credit is spent before your balance. A session takes what it can from today's credit and the rest from your
  balance.
- Credit does not roll over. What you do not use by the end of the UTC day is gone.
- Minutes paid with credit earn no owner share for a listed model, because nobody paid for them.
- You need to sign in with the wallet that stakes. No transaction is needed to receive credit: the service
  reads your stake from the chain.

## The staking contract

The contract is written and tested, and it is not deployed. It has not been audited by an outside firm. Its source
and its tests will be published before anyone is asked to stake.

It is deliberately small:

| Property | Detail |
| -------- | ------ |
| What it holds | Staked tokens, and nothing else. No rewards, no reward token, no fees. |
| Who can move your stake | Only you. |
| Unstaking | You request it, wait for a cooldown, then withdraw. The default cooldown is 7 days. |
| The owner's one power | Setting the cooldown for future requests, between 0 and 30 days. |
| What the owner cannot do | Freeze, seize, slash, pause or upgrade the contract, or charge a fee. |
| Protection against a longer cooldown | Each unstake request names the longest cooldown you accept. If the cooldown is higher, the request fails. |

Credits are worked out by the service from what the contract shows, not by the contract. That keeps the contract
simple, and it means the credit rules on this page are rules of the service. We can change them. A change does not
touch your stake.

## What can go wrong

- The token's price can fall to zero. Perks are worth what the minutes are worth to you, and nothing more.
- Staked tokens are locked for the cooldown when you want them back.
- A contract can have a bug that tests did not find.
- The rates and caps can change, and the perks can end.

Do not buy a token for the perks unless you would use the minutes.

## Holding without staking (roadmap)

The first version of the perks is for stakers only. A perk for wallets that hold the token without staking it
is on the roadmap and has no date. It needs a daily snapshot of balances first, so that the same tokens
cannot count for two wallets on one day.

## When it goes live

When a token and the contract exist, `GET /api/config` will show their addresses under `perks`, and this page will
say so. Until then `perks.enabled` is `false`.

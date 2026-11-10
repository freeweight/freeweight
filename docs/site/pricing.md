---
title: Pricing
summary: One price per GPU minute for each tier, charged only while your session runs.
order: 20
group: Start
---

You rent a model by the GPU minute. There is no price per token. A long prompt costs the same as a short one. What
you pay for is the time your session is open.

## Tiers

| Tier | Price | Per hour | GPU class | Status |
| ---- | ----- | -------- | --------- | ------ |
| Light | $0.03 per GPU minute | $1.80 | 24 GB | |
| Medium | $0.06 per GPU minute | $3.60 | 48 GB | |
| Heavy | $0.10 per GPU minute | $6.00 | 80 GB | Preview |

The model decides the tier. You do not choose a GPU. See [models](/docs/models) for how a model lands in a tier.

The live prices are in `GET /api/config` and on every model in `GET /api/models`. The API counts money in
millionths of a US dollar, so `30000` means $0.03.

## What a session is

A session is your rental of one model for a number of minutes.

1. You pick a model and a number of minutes, from 1 to 240. The default is 10.
2. The price of those minutes is held from your balance.
3. The model wakes, if it is asleep. Waking costs nothing.
4. When the model is ready, the clock starts.
5. The session ends when you stop it, when its time runs out, or when it has had no request for 5 minutes.
6. You are charged for the seconds you used, and for at least one minute once the model was awake. The rest
   of the hold goes back to your balance.

The charge is the seconds used, times the price per minute, divided by 60. Seconds are whole seconds, rounded up.
The result is rounded up to a millionth of a dollar.

A paid session is billed by the second, with a one-minute minimum once the model is awake. A session you stop
20 seconds after the model was ready costs one minute. On the test deployment, a session that used 11 GPU
seconds on the Light model was charged $0.03. A session that never reaches a ready model costs nothing.

The minimum does not apply when the model went away under your session: when it was lost, or when you stop
the session while the model is being woken again. Then you pay for the seconds before the model stopped and
nothing more.

| Session | Tier | Charge |
| ------- | ---- | ------ |
| 10 minutes | Light | $0.30 |
| 7 minutes 20 seconds, stopped early | Medium | $0.44 |
| 20 seconds, stopped early | Light | $0.03 |
| 60 minutes | Heavy | $6.00 |
| The wake failed | Any | $0.00 |

You can extend a running session. The extra minutes are held in the same way, at the price the session started
with. A session keeps its price even if the tier price changes while it runs.

> [!NOTE]
> A session that sits idle is still open, and the idle minutes are charged until the session ends itself after 5
> minutes without a request. Stop a session when you are done.

## Waking is free

A sleeping model is not on a GPU. Waking it means getting a GPU, loading the weights and starting the engine. A
wake takes from under a minute to a few minutes, depending on the size of the model. Each model shows a wake
estimate: 40 seconds for the Light model and 60 seconds for the Medium model at the start of v0.1. Heavy has not
been measured yet. We design for a wake under two minutes. A first wake with nothing cached takes longer.

You do not pay for the wake. The clock starts when the model is ready. A wake has 10 minutes per GPU source. The
Light model has two, so its wake can take up to about 20 minutes before it fails. If the wake fails, the session
costs nothing and the hold is released.

Free wakes have a limit. A paid session that you stop before the model is ready is an uncharged wake. After
more than 3 of those in an hour, or 10 in a day, the next start is refused with `429 wake_budget` until the
limit clears. A wake that failed on our side never counts.

The service as a whole also gives away only a limited number of uncharged wakes in an hour, across all renters.
Past that, a paid session that you stop before the model is ready costs the one-minute minimum and does not count
against your own limit. Its receipt says why, with the note `wake_minimum`.

The same holds when a model drops while your session is running. The session is paused, the model is woken
again, and your clock stands still until it is ready. If it cannot be woken again, the session ends and you pay
only for the time before the model stopped. See [models](/docs/models#if-a-model-drops-during-a-session).

## One instance, many clocks

An awake model runs as one instance. Everyone who rents it at that moment shares that instance. Each session has
its own clock, and each renter pays the per-minute price for their own minutes.

- Joining a model that is already awake takes no wake time. The site shows which models are awake now.
- When the last session on a model ends, the model goes back to sleep.
- A busy model answers more slowly, because requests share one GPU. v0.1 does not limit how many sessions a model
  has.

## The free try

You can try a Light model for 5 minutes without a wallet and without paying.

- One free session per visitor per day. Days are UTC days.
- A human check runs before it starts.
- There are limits per network address, and a daily total for all visitors. When the daily total is used up, the
  free try is closed until the next UTC day.
- It starts from the site, not from an API key.
- If the wake fails, you get the free try back.
- A free session you stop early still uses at least one minute of the daily total, also when you stop it before
  the model is ready. A wake costs GPU time whether or not you wait for it.

## Balance and top-ups

Paid sessions draw on a prepaid balance, counted in US dollars.

- You sign in with a wallet. Signing in is a signed message, not a transaction.
- You add to the balance by sending ETH or USDG on Robinhood Chain to the treasury address shown on the site, and
  then submitting the transaction hash. Send from the wallet you sign in with.
- USDG counts as one US dollar per token. ETH is converted at the market price in the minute of the transfer.
  Two public price sources are read, and the lower price counts.
- A top-up is credited after 20 block confirmations.
- Submit the hash of an ETH transfer within 6 hours. After that it is not credited automatically: write to us and
  we credit it by hand. USDG has no such limit.
- Top-ups are open when the site shows a treasury address. Before public launch they are closed, and the free try
  is the way in.

Used minutes are not refunded. See the [terms](/docs/terms) for the rest.

## Thinking costs time, not tokens

Some models think before they answer. The two Qwen3 models do, unless you switch it off. Thinking text is made
of tokens, like the answer, and tokens are not billed. What you pay for is the time: an answer with thinking
takes longer, and the session clock runs while the model thinks. For short questions, switching thinking off
gives faster answers. The [API reference](/docs/api) shows how.

## Receipts

Every session ends with a receipt.

| Field | Meaning |
| ----- | ------- |
| Minutes | GPU minutes on your clock, to two decimals. |
| Price | What the session cost. A free session shows $0.00. |
| Tokens in and out | How much text went through. For your information. Tokens do not change the price. |
| Wake time | Seconds from your request to a ready model. |
| How it ended | Stopped by you, out of time, idle, or the model stopped and could not be woken again. |

The receipt on the site also names what you rented: the model's repository, its commit and its precision.

The site shows recent receipts from all renters: model, minutes, price, tokens and wake time. No wallet address
appears there.

## When renting by the minute is the wrong choice

Renting by the minute is not always the cheapest way to use a model.

If you chat now and then with a popular model, a service that sells that model by the token will cost you less.
There you pay for a few thousand tokens. Here you pay for minutes in which the GPU mostly waits for you to type.

Renting wins when you keep the GPU busy, or when nobody sells the model by the token:

- agent work with long context, where every step sends a large prompt
- batch jobs that send requests back to back, or several at once
- models that no per-token service carries

The arithmetic is simple. Ten minutes on a Light model cost $0.30. If you produce 6,000 tokens in that time, you
paid $50 per million tokens. If you produce 120,000 tokens in that time, you paid $2.50 per million. How many
tokens a model produces per minute depends on the model and on how many requests you run at once. We do not
promise a number. Use the free try to measure it for your own work.

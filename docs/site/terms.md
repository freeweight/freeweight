---
title: Terms
summary: The agreement between you and Freeweight, in plain language.
order: 100
group: Policies
---

> [!NOTE]
> Draft v0.1, 2026-11-10: in force at public launch.

These terms are short on purpose. They have not been through legal review yet. Points that still need a decision
are marked.

## What Freeweight is

Freeweight rents out open-weight text models by the GPU minute. You pick a model, it wakes on a GPU, and you use it
for as long as your session runs. You reach it through the site, an OpenAI-compatible API, or both.

By using the service you accept these terms, the [privacy policy](/docs/privacy) and the
[acceptable use policy](/docs/acceptable-use).

## Your account

- There are no usernames and no passwords. Your wallet address is your account. You sign in by signing a message.
  Signing in costs nothing and sends no transaction.
- You are responsible for your wallet, your API keys and your session links. Anyone who has a session id can use
  that session until it ends. Anyone who has an API key can spend your balance until you revoke the key.
- We never ask for your private key or seed phrase, and we never sign anything for you.

> [!WARNING]
> Draft point for the owner: minimum age and any countries where the service is not offered.

## Paying

- The price is per GPU minute, set by the model's tier. Prices are on the [pricing](/docs/pricing) page and in the
  API.
- A session holds its price from your balance when it starts. When it ends, you are charged for the time used,
  counted in whole seconds and rounded up, and the rest is released.
- Waking a model is free. The clock starts when the model is ready.
- A paid session is billed by the second, with a minimum of one minute once the model is awake.
- Free wakes are limited. An account that stops too many paid sessions before the model is ready can be
  refused a new session for a while.
- A session keeps the price it started with.
- We can change prices. A change applies to sessions started after it.

## Your balance

- You add to your balance by sending ETH or USDG on Robinhood Chain to the treasury address shown on the site, and
  then submitting the transaction hash. Send only from the wallet you sign in with.
- ETH is converted at the market price in the minute of the transfer. Two public price sources are read, and the
  lower price counts. USDG counts as one US dollar per token.
- Your balance is prepaid credit for this service, counted in US dollars. It is not a deposit, a wallet or a token.
  It earns nothing and cannot be transferred to another account.
- Transfers on a blockchain cannot be reversed by us. A transfer on the wrong network, of the wrong token, or from
  another wallet is not credited automatically. Write to us and we will look at it.

## Refunds

- Minutes you have used are not refunded.
- A session whose model fails to wake costs nothing.
- If a model stops during your session, the session is paused while we wake the model again. Paused time is not
  charged. If the model cannot be woken again, the session ends and you are charged for the time before it
  stopped. If you think a stop cost you money, write to us with the receipt.

> [!WARNING]
> Draft point for the owner: unspent balance is refundable on request to the paying wallet, minus the network fee.
> Not decided yet. Until it is, refunds of unspent balance are handled case by case.

## The free try

A short free session on a Light model, with daily limits. It exists so that you can see a model work before you pay.
We can change or stop it at any time. Getting around its limits breaks the acceptable use policy.

## The models

- The models are open-weight models made by other people. They answer as they were trained. We do not add a filter.
- Answers can be wrong, out of date, offensive or made up. Check anything that matters. Nothing a model says is
  legal, medical or financial advice from us.
- Each model has its own licence, shown on its page. You must follow it.
- One instance of a model serves everyone renting it at the moment. A busy model answers more slowly.
- We can add, change or remove models. A wake time shown on the site is a measurement, not a promise.

## The tools

Models can call read-only research tools, and so can you. The tools collect public data from other sources. That
data can be missing, late or wrong, and a tool says so when it knows. A tool result is not a recommendation. A check
that finds nothing does not make a token safe.

## Your content

What you send and what the model answers is yours, as far as the model's licence allows. We do not store it and we
do not train on it. See the [privacy policy](/docs/privacy) for where it passes through.

## Model owners

If you list a model, the [listing](/docs/listing) page describes the checks and the owner share. In v0.1 listings
are approved by hand and the share is paid out by hand.

## The token and perks

No Freeweight token exists yet. Anything on this site about staking or perks describes a planned design for
launch. None of it is live.
Credits from staking are a discount on usage. They are not income and not a return.

## Availability

v0.1 is an early service. We do not promise that it is always up, that every model can always be woken, or that an
answer arrives within a certain time. We will say so on the site when something is broken.

## Ending and refusing service

You can stop using the service at any time. We can end sessions, revoke keys or refuse a wallet that breaks the
[acceptable use policy](/docs/acceptable-use) or attacks the service. We do not do this for lawful use.

## Liability

The service is provided as it is.

> [!WARNING]
> Draft point for the owner: warranty and liability wording needs legal review. Nothing is claimed here until then.

## Changes

We can change these terms. The date at the top changes with them. If you keep using the service after a change, the
new terms apply.

## Who we are

Freeweight operates the service.

> [!WARNING]
> Placeholder: legal entity and governing law. To be filled in before public launch.

Contact: hello@freeweight.xyz

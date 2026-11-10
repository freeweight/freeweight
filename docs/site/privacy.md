---
title: Privacy
summary: What Freeweight stores, what it does not, and where your prompts go.
order: 110
group: Policies
---

> [!NOTE]
> Draft v0.1, 2026-11-10: in force at public launch.

This page describes what the service does today, checked against its source code. If the code changes, this page
changes with it.

## The short version

- We do not store your prompts or the model's answers.
- We do not train on anything you send.
- You can try a model without an account. Paying needs a wallet, not a name or an email.
- We keep what billing needs: your wallet address, what you rented, for how long, and what it cost.
- Your prompts pass through the GPU machine that runs the model. It is rented, and it is not ours.
- Payments are on a public blockchain. Anyone can see them.

## What we store

| What | Detail | Why |
| ---- | ------ | --- |
| Wallet address | The address you sign in with. | It is your account. |
| API keys | A hash of each key, its first nine characters, the name you gave it, and when it was created, last used and revoked. The key itself is shown once and not kept. | To check a key and let you manage keys. |
| Sessions | Model, start and end time, GPU seconds, wake time, how the session ended, the amount charged, and two counters: tokens in and tokens out. | Billing and receipts. |
| Ledger | Every credit and charge on your balance, with a reference and a time. | Billing. Entries cannot be edited or deleted. |
| Top-ups | Transaction hash, sending address, asset, amount, block number, and the ETH price used. | To credit a payment once. |
| Free try | A random visitor id from a cookie (or your wallet address, if you are signed in), a salted and shortened hash of your network address, the day, and the cost of the session. | The daily limits on the free try. |
| Stopped wakes | The session id, your wallet address and the time, when you stop a paid session before the model is ready and it is not charged. | The limit on free wakes, per account and for the service as a whole. |
| Wake records | Model, GPU source, duration, outcome and a short error text. No account. | Wake estimates and fault finding. |
| Sign-in | The one-time code from your sign-in message and when it was used. | To stop a signature being replayed. |
| Model listings | Repository name, commit, the owner's wallet address, check results, and the end of the build log. | To list a model and credit its owner. |

Token counters are numbers. They say how much text went through, not what it said.

## What we do not store

- Prompts, messages, system prompts or completions.
- Tool calls made by a model, their arguments or their results.
- Your network address in readable form in our database.
- Your name, email address or any identity document. We never ask for them.

## Where your prompts go

1. Your request reaches our gateway. It checks your session and passes the request on. The text is held in memory
   for as long as the request takes.
2. The request goes to a GPU machine that runs the model. We rent these machines from GPU providers. The text is in
   that machine's memory while the answer is produced. Our serving code does not write it to disk.
3. The answer comes back the same way.

We do not control a provider's hardware, and we cannot prove what its operator is technically able to observe. If
your threat model does not allow a third party's machine to see a prompt, do not send that prompt.

One instance of a model serves everyone who is renting it at that moment. Requests are handled separately and one
renter cannot read another renter's requests. There is no hardware isolation between renters.

In the site's chat, your conversation lives in the page's memory. Reload the page and it is gone.

## Tools

When a model calls a research tool in the site's chat, or when you call a tool yourself, the tool's arguments go to
the public data source that answers: a token address to a chain endpoint, a URL to that website, a search query to a
search service. Those sources see our server, not your network address. They do see the argument.

## Logs

- Our code logs failures: an error message with a short hash of the session id, or a model id. It does not log
  prompts or answers.
- Our hosting platform records request logs for the gateway. In v0.1 this is switched on. A log line can include
  the time, the path, the status, your network address and your browser's user agent. Bodies are not part of these
  logs. The platform deletes them after its retention period.
- A session id is part of some paths, so it can appear in those logs.

## Cookies and scripts

| Cookie | Lifetime | Purpose |
| ------ | -------- | ------- |
| `fw_session` | 30 days | Keeps your wallet signed in. |
| `fw_visitor` | 365 days | A random id for the free try and for your free session. |
| `fw_nonce` | 10 minutes | The one-time code for signing in. |

The site also remembers your light or dark theme in your browser.

There are no analytics and no advertising scripts. The only third-party script is the human check on the free try.
When you complete it, the service that runs the check receives your network address and signals from your browser.

## Payments are public

Top-ups are transfers on Robinhood Chain to a public treasury address. The chain shows the sender, the amount and
the time to anyone, forever. We cannot change that. Our ledger links your wallet address to your sessions
internally. If you do not want a link between your usage and your main wallet, pay from a wallet you use for nothing
else.

The public pages show activity without accounts: which models are awake and how many sessions they have, and recent
receipts with the model, the minutes, the price and the tokens produced. No wallet address appears there.

## Who else is involved

| Who | What they see |
| --- | ------------- |
| Our hosting platform | Requests to the gateway and the database described above. |
| The GPU providers we rent from | Prompts and answers in memory, while a model produces the answer. |
| The human-check service | Your network address and browser signals, on the free try only. |
| Public data sources behind the tools | Tool arguments. |
| Chain endpoints | The transaction hashes and wallet addresses we look up. |

We do not sell data. We have no advertising partners.

If a court or an authority with jurisdiction orders us to hand over data, we can only hand over what is listed under
"What we store". We have no prompts to give.

## How long we keep it

Sign-in codes are deleted once they are 20 minutes old, the next time anyone signs in. Nothing else is deleted
automatically in v0.1. The other records above are kept while the service runs.

> [!WARNING]
> Draft point for the owner: set retention periods for sessions, free-try records and wake records, and say here
> what is deleted when.

Ledger entries are kept by design: an account history that can be edited is worth nothing.

## Your choices

- Try a model with no wallet.
- Pay from a fresh wallet.
- Revoke an API key at any time from the site.
- Ask what we hold about a wallet address, or ask us to delete what can be deleted: hello@freeweight.xyz. We will
  ask you to sign a message with that wallet.

> [!WARNING]
> Draft point for the owner: confirm the deletion process and which records are excluded from it.

## Age

> [!WARNING]
> Draft point for the owner: minimum age. Until it is set, the service is meant for adults.

## Changes

We will change this page when the service changes, and put the date at the top.

> [!WARNING]
> Draft point for the owner: whether the source code is public at launch. If it is, say here that every statement on
> this page can be checked against it.

## Who we are

Freeweight operates the service.

> [!WARNING]
> Placeholder: legal entity and governing law. To be filled in before public launch.

Contact: hello@freeweight.xyz

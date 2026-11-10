---
title: Quickstart
summary: Wake a model, talk to it, call it from code.
order: 1
group: Start
---

> [!NOTE]
> This page is a stand-in. The full text is being written.

## Wake a model

Open the [home page](/), pick a model and press the button. One free session a day runs on a Light model for 5 minutes, with no wallet and no signup.

A model that is asleep takes a minute or two to wake. The wake view shows the real stages as they finish. Wake time is not billed.

## Call the session from code

A session has an OpenAI-compatible endpoint. Use the base URL and the model id from the session page.

```bash
curl "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-8b","messages":[{"role":"user","content":"Say hello."}]}'
```

1. Sign in with a wallet on the [account page](/account).
2. Create an API key. It is shown once.
3. Start a session, then call the endpoint while it runs.

## What you pay

| Class  | Price per GPU minute |
| ------ | -------------------: |
| Light  |                $0.03 |
| Medium |                $0.06 |
| Heavy  |                $0.10 |

Billing is by the second while your session runs, with a one-minute minimum once the model is awake. Never per token. See [pricing](pricing.md).

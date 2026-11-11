---
title: Quickstart
summary: Wake a model on the site, then do the same from curl, Python and TypeScript.
order: 10
group: Start
---

Freeweight rents open-weight text models by the GPU minute. You wake a model, use it for the minutes you chose,
and get a receipt. Waking is free. The clock starts when the model is ready.

This page does it once on the site and once from code.

## On the site

1. Pick a model on the home page or under Models. Each one shows its tier, its price per GPU minute, and whether
   it is awake now.
2. Press the wake button. Without a wallet you get the free try: 5 minutes on a Light model, once a day, after a
   human check. Signed in with a balance, you choose 10, 30 or 60 minutes, and the price of those minutes is held
   from your balance.
3. Watch the wake. It takes from under a minute to a few minutes, depending on the size of the model. The page
   shows the real stages with their real times: a GPU is assigned, the machine starts, the weights load, the
   engine starts. This part is not billed. You can leave the page. The address of the session brings you back.
4. When the model is ready, the clock starts. Chat with the model, or open the Session tab for the time left, the
   charge so far and the endpoint for your own code.
5. Stop when you are done, or let the time run out. You get a receipt with the minutes, the charge, the token
   counts and the wake time. If you stop early, you pay for the seconds used, and for at least one minute once
   the model was awake.

A model that is already awake needs no wake. You join it and your clock starts at once.

## From code

You need two things:

- **An API key.** Sign in on the site with a wallet, open the account page and create a key. It starts with `fw_`
  and is shown once.
- **A balance.** A key spends the balance of the wallet that made it. A session needs enough for the minutes you
  ask for.

> [!NOTE]
> Top-ups open at public launch. Until then, start a free try on the site and use its session id from code. See
> [without an API key](#without-an-api-key) below.

Examples use `https://freeweight.xyz` and the model `qwen3-8b`. A staging deployment has another address.

```
export FREEWEIGHT_KEY="fw_..."
```

**1. Pick a model.** The catalog needs no key. Use a model's `id` in the next steps.

```
curl https://freeweight.xyz/api/models
```

**2. Start a session.** This holds the price of 10 minutes. On a Light model that is $0.30.

```
curl -X POST https://freeweight.xyz/api/sessions \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model_id": "qwen3-8b", "minutes": 10}'
```

The answer is the session, shortened here. Keep its `id`.

```json
{
  "id": "ses_abcdefghijklmnopqrstuvwx",
  "model_id": "qwen3-8b",
  "state": "waking",
  "stages": [{ "stage": "queued", "t_ms": 0 }],
  "started_at": null,
  "ends_at": null,
  "base_url": "/v1",
  "spent_usd_micro": 0,
  "free": false
}
```

```
export SESSION="ses_abcdefghijklmnopqrstuvwx"
```

**3. Watch the wake.** This is optional: the request in step 4 waits for the model by itself. The stream sends a
`stage` event for each step of the wake, then a `tick` with the session every 2 seconds. The session is ready when
its `state` is `active`.

```
curl -N https://freeweight.xyz/api/sessions/$SESSION/events \
  -H "Authorization: Bearer $FREEWEIGHT_KEY"
```

**4. Send a request.** The inference API has the OpenAI shape. A request with your key runs on your live session
for that model.

```
curl https://freeweight.xyz/v1/chat/completions \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-8b", "messages": [{"role": "user", "content": "Say hello in five words."}]}'
```

If the model is still waking, the request waits for it, up to 5 minutes. Give your client a timeout longer than
that.

**5. Stop.** The answer is the session with its `receipt`. What was held and not used returns to your balance.

```
curl -X POST https://freeweight.xyz/api/sessions/$SESSION/stop \
  -H "Authorization: Bearer $FREEWEIGHT_KEY"
```

If you do not stop it, the session ends when its time is up, or after 5 minutes without a request. Those idle
minutes are charged.

## Python

The OpenAI SDK works once it points at Freeweight. Install it with `pip install openai`.

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://freeweight.xyz/v1", api_key=os.environ["FREEWEIGHT_KEY"], timeout=600)

stream = client.chat.completions.create(
    model="qwen3-8b",
    messages=[{"role": "user", "content": "Explain a bonding curve in three sentences."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

## TypeScript

Install the SDK with `npm install openai`.

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://freeweight.xyz/v1", apiKey: process.env.FREEWEIGHT_KEY, timeout: 600_000 });

const stream = await client.chat.completions.create({
  model: "qwen3-8b",
  messages: [{ role: "user", content: "Explain a bonding curve in three sentences." }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
process.stdout.write("\n");
```

Both examples need a live session on the model, as in step 2. Without one the answer is `409 no_active_session`.
A key with `auto_session` switched on starts the session for you: see [agents](/docs/agents).

`qwen3-8b` thinks before it answers, so the first words of the answer can take some seconds. The thinking text
arrives apart from the answer, as `delta.reasoning`, and the examples above do not print it. The
[API reference](/docs/api) shows how to switch thinking off.

## Without an API key

A session id is a credential for that one session. Anyone who holds it can read the session and send requests
on it, until it ends. Stopping it needs the owner: the browser that started it, or an API key of its wallet.

1. Start a session on the site, for example the free try.
2. Copy the session id from the page address. It is the part that starts with `ses_`.
3. Use it where the examples above use the API key, and as `SESSION`:

```
export FREEWEIGHT_KEY="ses_abcdefghijklmnopqrstuvwx"
export SESSION="$FREEWEIGHT_KEY"
```

Steps 3 and 4, the Python example and the TypeScript example then work as written. Step 2 is not needed, because
the session already exists. Step 5 does not work with the id alone: it answers `404 session_not_found`. Stop the
session on the site, in the browser that started it, or with an API key of its wallet. A free session cannot be
extended.

## Next

- [Pricing](/docs/pricing): what a minute costs and when renting by the minute is the wrong choice.
- [API reference](/docs/api): every endpoint, field and error.
- [Agents](/docs/agents): keys that start sessions by themselves, and how to cap spend.
- [Tools](/docs/tools): eleven read-only research tools a model or an agent can call.

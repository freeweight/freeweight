---
title: Questions
summary: Short answers about sessions, money, privacy, the API and the token.
order: 30
group: Start
---

## Sessions

### What do I get when I rent a model?

A session: one open-weight text model, awake on a GPU, for the minutes you chose. You can chat with it on the
site, call it from your own code through an OpenAI-compatible API, or both at once.

### Why by the minute and not by the token?

Because a GPU costs by the minute, whoever uses it. Per-minute pricing lets us serve any model, including ones too
rare to sell by the token. It is not always cheaper for you. The [pricing](/docs/pricing) page says when it is the
wrong choice.

### Is there a model I can use without waking anything?

One. DeepSeek V4.1 Flash is always awake. It is an uncensored build: it does not refuse topics, and you are
responsible for what you do with the answers. It has no session and no clock, and it is paid per token: $0.50
per million tokens in and $2.00 per million out, from the same balance. In the chat on the site, 20 short
messages a day are free. It is served by a hosted endpoint, not from a GPU rented here. See
[pricing](/docs/pricing#the-always-awake-model).

### Is waking a model free?

Yes. The clock starts when the model is ready. A wake that fails costs nothing.

### How long does a wake take?

From under a minute to a few minutes, depending on the size of the model. Each model shows an estimate, which
is the median of its recent wakes: 40 seconds for the Light model and 60 seconds for the Medium model at the
start of v0.1. Heavy has not been measured yet. We design for a wake under two minutes. A first wake with nothing cached
takes longer. A model that is already awake needs no wake at all.

### My wake failed. What now?

Try again. A wake fails when the start broke or the model was not ready in time. A wake has 10 minutes per GPU
source. The Light model has two, so its wake can take up to about 20 minutes before it fails. You were not
charged, and a free try that failed this way is given back. The [models](/docs/models) page describes how a wake works.

### What if the model stops while I am using it?

Your session is paused and the model is woken again. The clock stands still while it is away, and the session
goes on when it is ready. If the model cannot be woken again, the session ends and you pay only for the time
before it stopped. The [models](/docs/models#if-a-model-drops-during-a-session) page has the details.

### What happens when my time runs out?

The session ends, and requests to it are answered with `session_ended`. Extend the session before that if you need
more time. An agent with an `auto_session` API key gets a new session on its next request.

### Can I stop early?

Yes. You pay for the seconds used, with a one-minute minimum once the model is awake, and the rest of the hold
returns to your balance.

### I left a session open. Did it keep charging?

Until it ended itself. A session with no request for 5 minutes ends on its own, and those idle minutes are charged.

### Do I share the model with other people?

Yes. One instance of a model serves everyone renting it at that moment. Each renter has their own clock. A busy
model answers more slowly.

### Can other renters read my prompts?

No. Requests are handled separately, and a session can only be used with its own id or by its owner. There is no
hardware isolation between renters of the same model. Treat your session id like a password: anyone who has it can
use the session until it ends. It cannot stop or extend the session, and it cannot spend more than the session
has already paid for.

## Money

### How do I pay?

Sign in with a wallet. Send ETH or USDG on Robinhood Chain to the treasury address shown on the site, then submit
the transaction hash. Your balance is credited in US dollars after 20 block confirmations.

Top-ups open at public launch. Until then the free try is the way in.

### Is there a subscription or a minimum?

No subscription. There is no minimum top-up beyond an amount large enough to count. A session needs enough balance
for one minute.

### I paid from an exchange or from another wallet. Where is my balance?

A top-up is credited only when the transfer came from the wallet you are signed in with. A transfer from an
exchange or another wallet is not credited automatically. Write to hello@freeweight.xyz with the transaction hash.

### Can I get a refund?

Used minutes are not refunded. For unspent balance, see the [terms](/docs/terms).

### What does the free try include?

Five minutes on a Light model, once per visitor per day, after a human check. No wallet. It is the real thing: the
same model on the same kind of GPU as a paid session.

## Privacy and content

### Do you store my prompts or the answers?

No. They pass through the gateway and the GPU in memory and are not written down. We keep the numbers billing
needs: time, cost and token counts. A conversation with the always-awake model goes to the hosted endpoint that
serves it, not to a GPU we rent. The [privacy](/docs/privacy) page lists everything.

### Do you train on what I send?

No.

### What does "uncensored" mean here?

The models answer as they were trained. We add no filter, we do not read prompts, and we do not ban lawful use.
The always-awake model goes one step further: it is an uncensored build, made so that it does not refuse topics.
You are responsible for what you do with the answers.
Some things are still not allowed. The [acceptable use](/docs/acceptable-use) page says which.

### Are the models changed in any way?

The weights come from the public repository named in the model's `hf_repo` field, at the commit named in `sha`.
`qwen3-8b` is served as its authors published it. `qwen3-32b` and `llama33-70b` are quantised copies, from a
repository that publishes them at reduced precision, so that they fit their tier. A quantised copy is not the
original weights, and its answers can differ. Each model says so in its `quant` field. See
[models](/docs/models).

## API and agents

### Is the API OpenAI-compatible?

The inference part is: `POST /v1/chat/completions`, `POST /v1/completions` and `GET /v1/models`, with streaming.
Point an OpenAI client at `https://freeweight.xyz/v1` and use a Freeweight API key or a session id as the key.
There are no embeddings, images or audio endpoints. See the [API reference](/docs/api).

### Do the models support tool calling?

The two Qwen3 models do. The Heavy model has not been tested yet, and the catalog marks it `tools_ok: false`.
Read `tools_ok` from `GET /api/models` before you send `tools`. See [agents](/docs/agents).

### Does thinking cost extra?

Not by the token. The Qwen3 models think before they answer, and the thinking text is not billed, because on a
rented model no tokens are. It costs time: the answer takes longer, and the session clock runs. You can switch thinking off for
a request with `"chat_template_kwargs": {"enable_thinking": false}`. See the [API reference](/docs/api).

### How long can a conversation be?

16,384 tokens on every model in v0.1: the prompt, the conversation so far, the thinking and the answer
together. A request that is too long gets an error that says so.

### Can an agent wake a model by itself?

Yes. Create an API key with `auto_session` switched on. A request for a sleeping model then starts a session, waits
for the wake and answers. See [agents](/docs/agents).

### How do I cap what an agent can spend?

An API key spends your balance, so the balance is the cap. Keep a small balance on a wallet used only for that
agent. v0.1 has no per-key spending limit.

### What are the tools?

Eleven read-only research tools for on-chain questions: token overviews, holders, safety checks and more. A model can
call them in the site's chat, and any agent can call them over MCP at `/mcp`. See [tools](/docs/tools).

## Models

### Which models can I rent?

The live list is on the site under Models and in `GET /api/models`. The one always-awake model is not rented:
it is in `GET /api/hosted`.

### Can I add my own model?

If you control its repository on Hugging Face and it passes the checks, yes. You earn 30% of the rent paid on it.
See [list a model](/docs/listing).

### Why is a model unavailable?

It cannot be woken right now: it is being built, it was switched off, or no GPU source for it is connected.

## The token

### Is there a Freeweight token?

No. No token exists yet, no contract is deployed and nothing can be staked. Anyone offering a Freeweight token
today is not us. The [staking](/docs/staking) page describes what is planned for launch.

## Contact

hello@freeweight.xyz

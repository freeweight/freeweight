---
title: Models
summary: How the catalog works, what tiers, quantisation and states mean, and how wake estimates are measured.
order: 70
group: Models
---

Every model on Freeweight is an open-weight text model from a public Hugging Face repository. Text in, text out.
There are no image, audio or embedding models in v0.1.

v0.1 lists three models. A larger catalog of about ten models is planned for launch and is not live.

| Model | Tier | Repository (`hf_repo`) | Precision (`quant`) | Tool calling |
| ----- | ---- | ---------------------- | ------------------- | ------------ |
| `qwen3-8b` | Light | `Qwen/Qwen3-8B` | `bf16` | Yes |
| `qwen3-32b` | Medium | `RedHatAI/Qwen3-32B-FP8-dynamic` | `fp8` | Yes |
| `llama33-70b` | Heavy, preview | `RedHatAI/Llama-3.3-70B-Instruct-quantized.w4a16` | `w4a16` | Not tested yet |

`qwen3-8b` is served as its authors published it. The other two are quantised copies. `qwen3-32b` is the FP8
quantisation of `Qwen/Qwen3-32B`. `llama33-70b` is a 4-bit weight quantisation of Llama 3.3 70B Instruct. A
quantised copy is not the original weights, and its answers can differ. Every model is pinned to one commit and
has a context of 16,384 tokens.

This page explains how to read the catalog. The catalog itself is live:

- on the site, under Models
- `GET /api/models`, with every field described below
- `GET /v1/models`, in the shape OpenAI clients expect

## What a catalog entry says

| Field | Meaning |
| ----- | ------- |
| `id` | The name you use in requests, for example as `model` in a chat completion. |
| `hf_repo` | The Hugging Face repository the weights come from. |
| `sha` | The commit of that repository the model is served from. |
| `license` | The model's licence, as its authors declared it. |
| `params_b` | Parameters, in billions. |
| `quant` | The numeric precision the weights are served at. |
| `tier` | Light, Medium or Heavy. Sets the price. |
| `price_usd_micro_per_min` | The price per GPU minute, in millionths of a US dollar. |
| `context` | Context length in tokens: prompt, thinking and answer together. |
| `owner` | The wallet of the model owner, if an owner listed it. `null` for models Freeweight added. |
| `state` | Whether the model is on a GPU now. See below. |
| `wake_estimate_s` | The expected wake time in seconds. |
| `wake_low_s`, `wake_high_s` | The range most wakes fall in, in seconds. 0 until the model has been woken. |
| `tools_ok` | Whether tool calling is switched on for this model and has passed our test. See below. |
| `tags`, `blurb` | Short labels and one line of description. |

## Tiers

The model decides the tier, not you. A tier is a GPU memory class, and a model goes in the smallest class that
holds its weights plus working memory for its context.

| Tier | GPU class | Price |
| ---- | --------- | ----- |
| Light | 24 GB | $0.03 per GPU minute |
| Medium | 48 GB | $0.06 per GPU minute |
| Heavy | 80 GB | $0.10 per GPU minute |

Heavy is a preview tier in v0.1. Treat it as less settled than the other two: its wake times and availability can
change.

For models that owners list themselves, the tier follows from the parameter count:

| Parameters | Tier | Precision |
| ---------- | ---- | --------- |
| Up to 10 billion | Light | `bf16` |
| Up to 20 billion | Medium | `bf16` |
| Up to 34 billion | Medium | `fp8` |
| Up to 72 billion | Heavy | `fp8` |
| More than 72 billion | Not accepted in v0.1 | |

## Quantisation

`quant` says how the weights are stored on the GPU.

- `bf16` is 16-bit floating point. It is the precision most models are published in. Nothing is lost.
- `fp8` is 8-bit floating point. The model takes about half the memory, which lets a larger model fit a tier. The
  answers can differ slightly from the full-precision model.
- `w4a16` is 4-bit weights with 16-bit activations. The model takes about a quarter of the memory. The answers
  can differ more from the full-precision model than with `fp8`.

A model served at reduced precision can come from a repository that publishes it already quantised. `hf_repo`
names the repository the weights really come from, which is then not the repository of the model's authors. In
v0.1 that is the case for `qwen3-32b` and `llama33-70b`.

If precision matters for your work, check `quant` before you rent, and compare against the published model
yourself.

## Context

`context` is the number of tokens the model can hold in one request: your prompt, the conversation so far, the
model's thinking and the answer.

In v0.1 every model has a context of 16,384 tokens. That is less than these models can take. The number is set
so that the GPU of a Light or Medium model holds about two full-length conversations at the same time.

A request that is too long gets an error from the model that says so. It is not cut short without telling you.

## Tool calling

`tools_ok` says whether a model is served with tool calling switched on and has passed our test: the model
returns parsed `tool_calls`, with and without streaming, and reads the tool's result in the next turn.

| Model | `tools_ok` |
| ----- | ---------- |
| `qwen3-8b` | `true` |
| `qwen3-32b` | `true` |
| `llama33-70b` | `false`: not tested yet |

Read the field from `GET /api/models` before you send `tools`. See [agents](/docs/agents).

## Thinking

The two Qwen3 models think before they answer. The thinking text comes back apart from the answer, and you can
switch it off for a request. Thinking takes time and uses context. Tokens are not billed, so thinking costs
time, not tokens. See the [API reference](/docs/api).

## Licence

Each model keeps the licence its authors gave it. Some licences allow any use. Some restrict commercial use or
certain uses. The licence is shown on the model's page and in `license`. Following it is your responsibility.

## Pinned commit

A repository on Hugging Face can change. A model on Freeweight is served from one commit, named in `sha`, so a
change upstream does not change the model you rent without the catalog showing it.

All three models in v0.1 are pinned. Models that owners list are pinned to the commit that passed the listing
checks.

The model's page and the receipt on the site name the repository, the commit and the precision of the model
you rented. In the API these are the fields `hf_repo`, `sha` and `quant` of the model.

## States

| State | Meaning |
| ----- | ------- |
| `awake` | The model is on a GPU. A session on it starts at once. |
| `waking` | A wake is in progress. A session you start now joins that wake. |
| `asleep` | The model is not on a GPU. Starting a session wakes it. |
| `cold` | Asleep, and never woken on this deployment. Its wake estimate is a default, not a measurement. |
| `unavailable` | The model cannot be woken right now. |

A model goes back to sleep when its last session ends. Nobody pays for a sleeping model.

`GET /api/awake` lists the models that are awake, since when, and how many sessions each has.

## Wake estimates

`wake_estimate_s` is measured, not promised. It is the median of the model's last 15 successful wakes. A model that
has never been woken shows the value from its catalog entry instead, and its state is `cold`. A value of 0 means
the wake has not been measured yet. In v0.1 that is the Heavy model.

Wakes of one model differ, so the catalog also gives a range. `wake_low_s` and `wake_high_s` are the 25th and
75th percentile of the same 15 wakes: half of them took between the two. Both are 0 until the model has been
woken once, and after a single wake all three numbers are the same. When the two differ, say "30 to 55 seconds"
instead of one number.

A wake can be faster than the estimate, when the weights are still cached near the GPU. It can be slower, when
GPUs are scarce or the weights have to be fetched again. It can fail. A failed wake costs nothing.

A wake takes from under a minute to a few minutes, depending on the size of the model. The catalog carries the
estimate for each model. At the start of v0.1 it says:

| Model | `wake_estimate_s` |
| ----- | ----------------- |
| `qwen3-8b` | 40 seconds |
| `qwen3-32b` | 60 seconds |
| `llama33-70b` | 0: not measured yet |

On the test deployment, on the day this was written, two wakes of the Light model were ready in 19 and 24
seconds. Both restored a saved copy of the loaded model. The first answer began about 5 seconds after the model
was ready, and later answers began in under 2 seconds. That is a small sample.

We design for a wake under two minutes. A first wake with nothing cached takes longer: the slowest we have
seen took about 5 minutes on the Light model and about 3 minutes on the Medium model.

Only the Light model has a second GPU source in v0.1. Medium and Heavy run on one.

## How a wake works

While a model wakes, the site and the API show the real stages as they happen:

| Stage | What is happening |
| ----- | ----------------- |
| `queued` | The wake request is accepted. |
| `gpu` | A GPU is being assigned to the model. |
| `container` | The machine and its software are starting. |
| `weights` | The weights are being fetched to the machine or loaded into GPU memory. |
| `engine` | The inference engine is starting. |
| `ready` | The model answers. Your clock starts here. |
| `failed` | The wake did not work. Nothing is charged. |

What the stages are, and what they are not:

- They are reported by the system that runs the model, each with the time it began, counted from the start of
  the wake. None of them is estimated or played from a script.
- A stage whose time was not recorded is left out. So a wake can show fewer stages than the table.
- A stage can show more than once. The weights, for example, can be fetched to the machine first and loaded
  into GPU memory later, with the machine's start in between.
- When a start is tried again, the stage says which attempt it is.

A wake has 10 minutes. A wake that has not reached `ready` by then has failed, and so has a wake whose start
broke. A failed wake is final: the GPU is released and nobody is charged. If the model can run on a second GPU
source, the wake moves there, `queued` shows again, and the new attempt gets its own 10 minutes. In v0.1 only
the Light model has a second source. If no source is left, the sessions that waited end as failed. To try
again, start a new session.

A request alone does not wake a model. A model wakes when a session starts on it, and it is not kept warm
between sessions.

## If a model drops during a session

A GPU can go away while you are using it. When the model under a running session stops, the session is not
thrown away:

- The session is paused and the model is woken again. The stages show again, as for a first wake.
- Your clock stands still while the model is away. It stops at the last moment the model was confirmed awake,
  so the seconds before the drop was noticed are not charged either. When the model is ready the session goes
  on, and its end moves out by the time the model was away.
- A request you send while the model is away waits for it. An answer that was cut off in the middle is not
  repeated: send the request again.
- A model is woken again at most twice, unless it has stayed up for 30 minutes in between. After that, or if
  no GPU source can wake it, the session ends with the reason `model_lost`. So does a paused session that is
  still waiting after about half an hour. You pay for the time up to the point where the clock stopped, and
  the rest of your hold is released.
- If you stop the session while the model is away, you pay for the seconds before the clock stopped, with no
  one-minute minimum.

## Models from owners

Anyone who controls a model repository can ask to list it. Such models carry the tag `community` and name their
owner's wallet in `owner`. See [listing a model](/docs/listing).

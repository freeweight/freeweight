---
title: Bring any model
summary: Paste a Hugging Face model ID, pay a capped first load, and rent the model by the minute. What is accepted, what it costs, and the same flow from the API.
order: 75
group: Models
---

The catalog is not a closed list. Paste the ID of a public text model on Hugging Face, such as `org/model`, and
Freeweight checks it, loads it once, and puts it in the catalog. From then on it wakes and is rented like any
other model, at the price per minute of its class.

You do not have to own the model. If you do own it, you can also [list it](/docs/listing) and earn a share of its
rent.

> [!NOTE]
> A pasted model is marked **untested**. Freeweight has checked that the engine can start it and that it answers
> one request. Nobody has checked how well it answers, its licence, or whether tool calling works.

## The three steps

| Step | Costs | What happens |
| ---- | ----- | ------------ |
| Check | Nothing | The repository is read on Hugging Face. You get the class, the price, the most a first load can cost, or the reason the model cannot be loaded. |
| First load | The class price per minute of load time, up to a cap | The weights are fetched at the current commit, checked, stored, and the model is started once to prove that it runs. |
| Rent | The class price per minute, as for any model | The model is in the catalog. A session wakes it. The wake is free. |

## The check

Paste a model ID (`org/model`) or the address of the model's page on Hugging Face. The check is free, needs no
account, and answers in a second or two.

A model is accepted when all of this holds:

| Rule | Why |
| ---- | --- |
| The repository is public: not private, not gated, not disabled. | A gated model needs an approval on Hugging Face that Freeweight does not have. |
| It is a text-generation model. | Freeweight serves chat models that write text. |
| Its weights are safetensors files. | GGUF, bin and pickle files are not loaded. |
| Its `config.json` names one architecture that the serving engine runs as a text model. | The engine is vLLM, at the version in `paste.engine_version` of `GET /api/config`. |
| It needs no code of its own to load. | Code from a repository is never run. A model with `auto_map` or the `custom_code` tag is refused. |
| Quantised weights are of a kind the engine runs here: AWQ (4-bit), GPTQ (4- or 8-bit, symmetric) or FP8, as `config.json` states it. | Other kinds, bitsandbytes among them, either do not run on this engine version or were not proven on its GPUs. Plain weights are always fine. |
| Its tokenizer has a chat template. | Without one the chat route cannot be used. |
| Its files fit a class. | Models are served as they are. Nothing is quantised or shrunk for you. |

The first rule that fails is the answer, with a code and one sentence that says why.

The class follows from the size of the files that are fetched:

| Class | Files up to | Price | Cap of a first load | A first load costs at most |
| ----- | ----------- | ----- | ------------------- | -------------------------- |
| Light | 19 GiB | $0.03 per minute | 5 minutes | $0.15 |
| Medium | 40 GiB | $0.06 per minute | 10 minutes | $0.60 |
| Heavy | 68 GiB | $0.10 per minute | 15 minutes | $1.50 |

The live numbers are in `GET /api/config`: `prices_usd_micro_per_min` and `paste.load_cap_minutes`.

The check also shows the licence the model card states. It is shown as stated and is not judged: whether you may
use the model for your purpose is for you to read.

## The first load

A first load needs an account with a balance. You pay the class price per minute for the time the load takes,
and never for more minutes than the cap of the class. A download that takes longer than the cap still finishes:
those minutes are on Freeweight. The start on a GPU is not: it may use the GPU for the cap of the class, plus up
to two minutes of waiting for a GPU. A model that is not ready by then fails its load, and costs nothing.

- The cap is held from your balance when the load starts. When the load ends, you are charged for the time it
  took and the rest of the hold returns.
- **A load that fails costs nothing.** The whole hold returns, and the load says why it failed in one sentence.
- The commit of the repository is pinned at the first load. The catalog entry names it in `sha`. Later changes to
  the repository do not change what is served.
- You can leave the page. The load carries on, and its address shows where it stands when you come back.
- If somebody else is already loading the same model, you join their load. You see the same stages and pay
  nothing.

The stages of a load:

| Stage | Meaning |
| ----- | ------- |
| `queued` | The load is accepted and waits for a machine. |
| `checking` | The files of the repository are listed at the pinned commit. |
| `downloading` | The weights are fetched. `bytes` of `size_bytes` says how far. |
| `validating` | The fetched files are checked again: format, architecture, chat template, size. |
| `starting` | The model is started once on a GPU and asked one question, within the cap of its class. |
| `ready` | The model is in the catalog. |
| `failed` | The load ended without a model. Nothing was charged. |

The check runs on what Hugging Face says about the repository. The load checks the files themselves, so a model
can pass the check and still fail its load, for example when the engine cannot start it. That costs nothing.

## After the first load

The model is in the catalog under an id made from the repository name: `Org/Model-1.5` becomes `org_model-1-5`.
The id is in lower case, and anything but a letter or a digit becomes a hyphen. Read the id from `model_id` of the
load: a long name is cut, and a name that is taken gets a short suffix. The model carries the tag `untested`
and has `origin: "pasted"` in the API.

- Anyone can rent it, at the price of its class. A session wakes it, and the wake is free, as for every model.
  The [free try](/docs/pricing#the-free-try) works on a Light one.
- Its context is what the model's config states, up to 8192 tokens. `context` on the model gives the number.
- `tools_ok` is `false`: tool calling on an untested model is not set up. Do not send `tools` to it.
- It runs on one GPU source. There is no second source to fall back on.
- Nobody earns an owner share on it. If the owner of the repository [lists the model](/docs/listing), the owner's
  listing takes its place in the catalog when it is approved and built.

### Keep it private

Tick the box before the load to load a private copy. It gets an id of its own, the public id with `_p` and six
more characters, and only your account, with the browser sign-in or one of your API keys, can read it or start a
session on it. It is in no public list. For everyone else it does not exist: if they paste the same repository,
the check answers as if you had not loaded it, and they can load the public model as usual.

A private copy is a second set of weights. Its load counts toward your limits, and its weights are cleared like
any other's.

You can switch later, on the model's page or on your account page:

- A private copy becomes public, under its id, only while the repository has no public model. Otherwise it stays
  private, and the answer names the public model.
- A public model you loaded can be made private only until another account pays for a load of it. From then on
  it stays public.

Privacy covers the catalog entry. It does not make the weights private: they are a public repository on Hugging
Face.

### When the weights are cleared

Stored weights cost money while nobody uses them. The weights of a pasted model that nobody has woken for 28 days
are cleared. The catalog entry stays, with the state `needs_load`, and the next person who wants the model pays
for a first load again. That load fetches the same pinned commit.

Your account page lists the models you loaded, with the date each one is due to be cleared. A wake moves that
date 28 days ahead.

## Limits

| Limit | Value |
| ----- | ----- |
| Checks | 20 per minute per network address, and per account. Starting a load counts as a check. |
| First loads | 5 per account in any 24 hours (a rolling window, not a calendar day). Joining a load is not counted. |
| Loads of one account at the same time | One. Another answers `429 load_running`. |
| Failed loads | After 2 loads of an account failed on a GPU in 24 hours, the next answers `429 failed_load_limit` until the older of them is 24 hours old. |
| Loads at the same time | A small number across the whole service. One more answers `429 too_many_loads`: try again in a few minutes. |
| Storage | Pasted models share one storage budget. When it is full, a load answers `503 storage_full`. |

Freeweight can refuse a repository or an organisation, and can hide or remove a pasted model. See
[acceptable use](/docs/acceptable-use).

## From the API

Everything above works with an [API key](/docs/api#api-key). The check needs no key at all.

**1. Check.**

```
curl -X POST https://freeweight.xyz/api/models/check \
  -H "Content-Type: application/json" \
  -d '{"repo": "your-org/your-model"}'
```

```json
{
  "ok": true,
  "repo": "your-org/your-model",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "name": "your-model",
  "license": "apache-2.0",
  "tier": "light",
  "size_bytes": 6442450944,
  "params_b": 3.09,
  "context": 8192,
  "architecture": "Qwen2ForCausalLM",
  "price_usd_micro_per_min": 30000,
  "load_cap_minutes": 5,
  "load_cap_usd_micro": 150000,
  "load_estimate_s": 204,
  "wake_estimate_s": 78,
  "state": "new",
  "model_id": null,
  "load_id": null,
  "private": false,
  "can_load": true
}
```

A model that cannot be loaded also answers with status 200:

```json
{
  "ok": false,
  "repo": "your-org/your-model-gguf",
  "code": "no_safetensors",
  "reason": "The repo holds GGUF weights. Only safetensors weights can be loaded."
}
```

`state` says where the repository stands:

| `state` | Meaning | What to do |
| ------- | ------- | ---------- |
| `new` | Nobody has loaded it. | Start a load. |
| `needs_load` | It is in the catalog as `model_id`, and its weights were cleared. | Start a load. |
| `loading` | A load is running: `load_id`. | Follow that load, or start one to join it. |
| `loaded` | It is in the catalog as `model_id`. | Start a session on `model_id`. |

`can_load` is `true` for `new` and `needs_load`. When you have a private copy of the repository, the answer is
about that copy and `private` is `true`. Another account's private copy is never part of the answer.

**2. Load.**

```
curl -X POST https://freeweight.xyz/api/loads \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo": "your-org/your-model"}'
```

Add `"private": true` to load a private copy, under an id of its own. The answer is the load: status 201 when
you started it, 200 when you joined one that was running.

```json
{
  "id": "load_k3v7x2m4q7w5z6t5",
  "model_id": "your-org_your-model",
  "hf_repo": "your-org/your-model",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "tier": "light",
  "state": "loading",
  "stage": "queued",
  "bytes": 0,
  "size_bytes": 6442450944,
  "mine": true,
  "price_usd_micro_per_min": 30000,
  "cap_minutes": 5,
  "hold_usd_micro": 150000,
  "charged_usd_micro": 0,
  "created_at": 1794300000000,
  "ended_at": null,
  "now": 1794300000000
}
```

**3. Follow it.** Poll `GET /api/loads/{id}` every few seconds, or read the event stream at
`GET /api/loads/{id}/events`. `state` goes from `loading` to `ready` or `failed`.

```
curl https://freeweight.xyz/api/loads/load_k3v7x2m4q7w5z6t5 \
  -H "Authorization: Bearer $FREEWEIGHT_KEY"
```

A load that ended `ready` carries what it cost in `charged_usd_micro`. One that ended `failed` carries `code` and
a sentence in `detail`, and `charged_usd_micro` is 0.

**4. Rent it.** Start a session on `model_id`, as for any model:

```
curl -X POST https://freeweight.xyz/api/sessions \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model_id": "your-org_your-model", "minutes": 10}'
```

If the weights were cleared since, this answers `409 needs_load` with the repository name in `hf_repo`. Start a
load and try again when it is ready.

Every field and error code is in the [API reference](/docs/api#pasted-models).

## What a refusal means

| Code | Meaning |
| ---- | ------- |
| `repo_not_found` | No public model repository with that name. |
| `disabled` | Hugging Face has disabled the repository. |
| `gated` | The weights need an approval on Hugging Face. |
| `not_text_generation` | The model is not a text-generation model. |
| `no_safetensors` | The repository has no safetensors weights. |
| `unsupported_architecture` | The config names no architecture, more than one, or one the engine does not run as a text model. |
| `custom_code` | The model needs its own Python code to load. |
| `unsupported_quantization` | The weights are quantised in a way the engine does not run here, or `config.json` does not say how. |
| `no_chat_template` | The tokenizer has no chat template. |
| `too_big` | The files are bigger than the Heavy class holds, or the repository does not say how big they are. |
| `blocked` | Freeweight does not load this repository. |
| `removed` | The model was removed from the catalog and cannot be loaded again. |

## When this is the wrong choice

- You want a model that is known to work well. Use a catalog model without the `untested` tag.
- The model is only published as GGUF, or needs its own code. It cannot be loaded.
- You need a long context or tool calling today. A pasted model has neither.
- You own the model and want a share of its rent. [List it](/docs/listing) instead.

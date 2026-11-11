---
title: API reference
summary: Every public endpoint of the gateway, with authentication, sessions, the event stream, the OpenAI-compatible routes and errors.
order: 40
group: Build
---

The API has two parts.

- `/api` is Freeweight's own API: the catalog, sessions, your account.
- `/v1` is OpenAI-compatible inference. It needs a session, because a session is what you pay for. The one
  exception is [the always-awake model](#the-always-awake-model), which is paid per token and needs none.

A machine-readable description is at [/openapi.yaml](/openapi.yaml). This page and that file are written from the
same code.

> [!NOTE]
> Examples use `https://freeweight.xyz`. Before public launch the service runs on a staging address, and that
> address differs. This is v0.1: `/api` has no version prefix and can still change.

## Conventions

- Requests and responses are JSON. Send `Content-Type: application/json` with a body.
- Money is an integer count of millionths of a US dollar, in fields that end in `usd_micro`. `30000` is $0.03.
- Times are Unix time in milliseconds, unless a field ends in `_s` (seconds) or `_ms` (a duration).
- Wallet addresses are lowercase hex.
- Ids have a prefix: `ses_` for sessions, `key_` for API keys, `lst_` for listings, `hst_` for requests to the
  always-awake model, `load_` for first loads. An API key itself starts with `fw_`.
- A request body can be at most 1 MB.

## Authentication

There are three ways to say who you are. Public reads need none of them.

### API key

```
Authorization: Bearer fw_...
```

Create keys on the site, on your account page, while signed in with a wallet. A key is shown once. Freeweight
stores only its hash. A wallet can have 20 keys.

A key acts as your wallet: it can start sessions, spend your balance and submit listings. It cannot create or
revoke keys, and it cannot start the free try.

### Session id

A session id works like a key for that one session. Anyone who holds it can read the session and send requests
on it, until it ends. What it can spend is bounded by what the session has prepaid. It cannot stop or extend
the session: those need the owner, and with the id alone they answer `404 session_not_found`.

For anything automated, an API key is the right credential. Hand out a session id only when you want to give
someone the rest of one session and nothing else.

```
X-Freeweight-Session: ses_...
```

You can also send the session id as the bearer token. On `/v1` that lets an OpenAI client use it as its API key:

```
Authorization: Bearer ses_...
```

### Browser sign-in

The site signs you in with a wallet signature. It is a signed message, not a transaction.

1. `GET /api/auth/nonce` returns `{ "nonce": "..." }` and sets a short-lived cookie. The nonce is valid for 10
   minutes.
2. The wallet signs a Sign-In with Ethereum (EIP-4361) message. Its domain and URI must be the site's host, its
   chain id must be 4663 (`chain.id` in `GET /api/config`), it must carry the nonce, and it must have been issued
   within the last 10 minutes.
3. `POST /api/auth/verify` with `{ "message": "...", "signature": "0x..." }` returns `{ "address": "0x..." }` and
   sets the `fw_session` cookie for 30 days. Contract wallets are checked with ERC-1271 on Robinhood Chain.
4. `POST /api/auth/logout` clears the cookie.

Cookies are `HttpOnly` and `SameSite=Lax`. They are ignored on requests from another origin, and a write request
from another origin without a bearer token is refused with `403 bad_origin`. From your own code, use an API key.

## Errors

Every error has the same shape. `type` repeats `code`, for clients that expect an OpenAI-style error.

```json
{
  "error": {
    "code": "insufficient_balance",
    "message": "The balance covers 3 minutes on this model.",
    "type": "insufficient_balance"
  }
}
```

Some errors add fields, such as `session_id` on `session_live`, or `confirmations` and `required` on
`pending_confirmations`. Messages are written for people and can change. Program against `code`.

| Status | Code | Meaning |
| ------ | ---- | ------- |
| 400 | `bad_request` | The body or a field is missing or malformed. |
| 400 | `bad_repo` | What was pasted is not a Hugging Face model ID like `org/model`, nor the address of a model page. |
| 400 | `model_mismatch` | `model` in the request is not the model of the session. |
| 400 | `invalid_request` | A `/v1` field the gateway checks has a wrong value: `stream` that is not `true` or `false`, `n` outside 1 to 4, or `max_tokens` / `max_completion_tokens` that is not a whole number of zero or more. Nothing was sent to the model. On the always-awake model: `n` other than 1, a `max_tokens` below 1, message content that is not text, a tool that is not a function, another field with a value it does not allow, or a request the model refused as it was sent. |
| 400 | `too_long` | The extension would take the session past 240 minutes. |
| 400 | `turnstile_required` | The free try, or the first free message of a day on the always-awake model, needs a token from the human check. |
| 400 | `invalid_message`, `nonce_expired`, `nonce_used` | Sign-in message problems. |
| 4xx | `invalid_request_error` | The model refused the request, for example a prompt longer than its context. The status is the one the model gave. |
| 401 | `unauthorized` | No usable credential. |
| 401 | `invalid_api_key` | The API key is unknown or revoked. |
| 401 | `invalid_signature` | The sign-in signature does not match the address. |
| 401 | `sign_in_required` | A paid session was asked for without a wallet. Sign in and top up. |
| 402 | `insufficient_balance` | The balance does not cover the minutes asked for, or one minute. On the always-awake model: it does not cover the highest price the request can have. For a first load: it does not cover the cap of the load, and the error carries `needed_usd_micro`. |
| 403 | `bad_origin` | A cross-origin write without a bearer token. |
| 403 | `cookie_required` | API keys are created and revoked from a signed-in browser only. |
| 403 | `turnstile_failed` | The human check failed. |
| 403 | `forbidden` | The treasury wallet cannot top up its own account. |
| 403 | `not_yours` | Only the account that loaded a pasted model can keep it private. |
| 403 | `trial_unavailable` | `free: true` was sent with an API key, or for a model that is not a Light model. |
| 404 | `not_found` | No such route. |
| 404 | `model_not_found`, `session_not_found`, `key_not_found`, `listing_not_found`, `load_not_found`, `repo_not_found`, `tx_not_found` | No such thing. A session you may not use also answers `session_not_found`. A model or a load that another account keeps private answers `model_not_found` or `load_not_found`. |
| 409 | `no_active_session` | A `/v1` request without a live session, from a key without `auto_session`. |
| 409 | `session_ended` | The session has ended. Start a new one. |
| 409 | `session_live` | A free try was asked for while another session of the same account is live. Carries `session_id`. |
| 409 | `free_session_fixed` | A free session cannot be extended. |
| 409 | `needs_load` | The weights of this pasted model were cleared. Start a first load of the repository in `hf_repo`, which the error carries. |
| 409 | `already_loaded` | The pasted repository is in the catalog already. Carries `model_id`. |
| 409 | `model_id_taken` | The repository cannot get a model id of its own. Write to us. |
| 409 | `public_copy_exists` | A private copy cannot be made public while the repository has a public model. Carries `model_id` when that model is in the catalog. |
| 409 | `paid_by_others` | A public pasted model cannot be made private once another account has paid for a load of it. |
| 409 | `too_many_keys` | The wallet already has 20 keys. |
| 409 | `pending_confirmations`, `tx_already_used` | Top-up states. See below. |
| 413 | `body_too_large` | The body is over 1 MB. |
| 413 | `message_too_long` | A free message on the always-awake model is longer than a free message may be. |
| 422 | `repo_not_found`, `disabled`, `gated`, `not_text_generation`, `no_safetensors`, `unsupported_architecture`, `custom_code`, `unsupported_quantization`, `no_chat_template`, `too_big`, `blocked`, `removed` | A first load was asked for a repository that cannot be loaded. The codes are those of the check. See [pasted models](#pasted-models). |
| 422 | `tx_failed`, `no_transfer`, `tx_too_old`, `amount_too_small`, `amount_too_large` | Top-up problems. See below. |
| 429 | `rate_limited` | The model is busy with other requests. Carries `Retry-After`. The session is still live. On the always-awake model: the account sent more than 30 requests in a minute. On `POST /api/models/check` and `POST /api/loads` together: more than 20 in a minute. Carries `Retry-After: 60`. |
| 429 | `too_many_in_flight` | The account already has 4 requests running on the always-awake model. Carries `Retry-After: 5`. |
| 429 | `too_many_requests` | The session already has 4 requests in flight. Wait for one to finish. Carries `Retry-After: 1`. |
| 429 | `wake_budget` | Too many paid sessions were stopped before the model was ready: more than 3 in an hour or 10 in a day. Carries `retry_after`, in seconds, in the error body, and a `Retry-After` header. A wake that failed on our side does not count. |
| 429 | `free_used` | Today's free session is used, for this visitor or this network address. On the always-awake model: today's free messages are. |
| 429 | `free_budget_spent` | Today's free sessions, or today's free messages on the always-awake model, are all taken. |
| 429 | `too_many_listings` | More than 20 listing checks in a day. |
| 429 | `daily_load_limit` | The account started its 5 first loads in the last 24 hours. |
| 429 | `failed_load_limit` | 2 loads of the account failed on a GPU in the last 24 hours. Carries `retry_at` (ms) and a `Retry-After` header. |
| 429 | `load_running` | The account has a load running. Carries `load_id`. |
| 429 | `too_many_loads` | Too many models are being loaded right now. Carries `Retry-After: 120`. |
| 500 | `internal_error` | A fault on our side. |
| 502 | `upstream_error` | The model did not answer. Try again. |
| 502 | `hf_unavailable` | Hugging Face could not be read for a check. |
| 503 | `model_waking` | The model is still waking after a 5-minute wait, or is being woken again. Carries `Retry-After`. The session is still live. |
| 503 | `model_unavailable` | The model cannot be woken or reached right now. |
| 503 | `hosted_busy` | The always-awake model has reached what it may cost in a day, all callers together, or cannot take more requests right now. Carries `Retry-After`. Nothing was charged. |
| 503 | `storage_full` | The storage for pasted models is full. Nothing was held. |
| 503 | `loads_unavailable`, `load_not_started` | First loads are switched off, or the load could not be handed to a GPU machine. Nothing was charged. |
| 503 | `checks_unavailable` | Checks and first loads cannot be taken right now. Nothing was charged. |
| 503 | `misconfigured` | The service is not set up completely. Until it is, only the public reads answer: health, config, stats, receipts, the catalog and `/api/hosted`. `/mcp` answers 503 too, as a JSON-RPC error. |
| 503 | `model_lost` | The model stopped while the session was live and could not be woken again. The session has ended, and time after the model stopped is not charged. Start a new one. |
| 503 | `trial_unavailable`, `turnstile_unavailable` | The human check for the free try is not set up or could not be reached right now. |
| 503 | `topups_closed`, `rpc_unavailable`, `price_unavailable`, `price_out_of_bounds`, `ledger_unavailable` | Money paths that are closed or could not be checked. Nothing was charged or credited. |
| 504 | `upstream_timeout` | The model took too long to answer. Try again. |

## Public reads

No authentication.

| Endpoint | Returns |
| -------- | ------- |
| `GET /api/health` | `{ ok, status, now }`. Status 200 with `status: "ok"`, or 503 with `status: "misconfigured"` when a required setting is missing. It does not say which one. |
| `GET /api/config` | Prices, session limits, the chain, top-up details, the owner share. |
| `GET /api/models` | `{ models: [Model] }`: the catalog with live state. |
| `GET /api/models/{id}` | One `Model`. |
| `GET /api/awake` | `{ awake: [{ model_id, since, sessions }] }`: listed models on a GPU now. |
| `GET /api/hosted` | `{ model }`: the always-awake model, or `null` when the deployment does not offer one. See [below](#the-always-awake-model). |
| `GET /api/stats` | `{ gpu_seconds, sessions, tokens, wakes, median_wake_s, hosted_requests, hosted_tokens }`: service totals for listed models. `median_wake_s` is `null` before the first wake. `hosted_requests` and `hosted_tokens` count the answers of the always-awake model and their tokens. They are kept apart: `tokens` and the GPU figures are rented sessions only. The totals are counted again at most every 30 seconds, so they can be up to 30 seconds old. |
| `GET /api/receipts` | `{ receipts: [...] }`: the last 20 ended sessions on listed models, without any account data. |

A `Model`:

```json
{
  "id": "qwen3-8b",
  "name": "Qwen3 8B",
  "hf_repo": "Qwen/Qwen3-8B",
  "sha": "b968826d9c46dd6066d109eabc6255188de91218",
  "license": "apache-2.0",
  "params_b": 8.2,
  "quant": "bf16",
  "tier": "light",
  "price_usd_micro_per_min": 30000,
  "context": 16384,
  "owner": null,
  "state": "asleep",
  "wake_estimate_s": 40,
  "wake_low_s": 30,
  "wake_high_s": 55,
  "tags": ["chat", "reasoning", "tools"],
  "blurb": "Fast general model with tool calling. The default pick.",
  "tools_ok": true,
  "origin": "catalog",
  "private": false,
  "mine": false
}
```

`state`, `wake_estimate_s` and the range around it (`wake_low_s` to `wake_high_s`, 0 until three wakes are measured) change as
the model is used. `hf_repo`, `sha` and `quant` say exactly which
weights are served. `context` is 16384 on every model in v0.1. `tools_ok` is `false` on `llama33-70b`: read it
before you send `tools`. The [models](/docs/models) page explains every field. `state` is one of
`asleep`, `waking`, `awake`, `cold`, `unavailable`, `needs_load`.

`origin` is `catalog`, or `pasted` for a model that somebody [pasted](/docs/any-model). A pasted model carries
the tag `untested`, has `tools_ok: false`, and is in the state `needs_load` when its weights were cleared. Its
`quant` says how the weights are stored: `bf16` or `fp16`, or a quantisation such as `AWQ 4-bit`, `GPTQ 8-bit` or `FP8`.
`private` and `mine` are about pasted models: `mine` is `true` for the account that loaded the model, and a
model with `private: true` is returned to that account only.

`GET /api/config` returns:

| Field | Meaning |
| ----- | ------- |
| `prices_usd_micro_per_min` | `{ light, medium, heavy }` |
| `free_minutes`, `default_minutes`, `max_minutes`, `idle_seconds` | Session limits: 5, 10, 240 and 300 in v0.1. |
| `turnstile` | `{ enabled, sitekey }` for the human check on the free try. |
| `chain` | `{ id, name }`: Robinhood Chain, id 4663. |
| `topups` | `{ open, treasury, assets, confirmations }`. `open` is false until top-ups open. |
| `perks` | `{ enabled, token, vault }`. Staker perks are planned and not live: `enabled` is `false` and both addresses are `null` in v0.1. |
| `owner_share_bps` | The model owner's share of paid rent, in basis points. |
| `paste` | `{ open, engine, engine_version, load_cap_minutes: { light, medium, heavy }, loads_per_day, loads_failed_per_day, clear_after_days }`: the rules for [pasted models](#pasted-models). `open` is `false` when no GPU source takes them. |
| `tool_system_note` | The system note the server puts in front of a conversation when it runs the tools. If you run your own tool loop against `/mcp`, put the same text in front of yours. |

## Sessions

### Start a session

```
POST /api/sessions
```

```json
{ "model_id": "qwen3-8b", "minutes": 10 }
```

| Field | Meaning |
| ----- | ------- |
| `model_id` | Required. An id from the catalog. |
| `minutes` | Optional whole number from 1 to 240. Asks for a paid session of that length. |
| `free` | Optional boolean. `true` asks for the free try and nothing else. `false` asks for a paid session. |
| `turnstile` | The token from the human check. Needed for the free try only. |

The answer is a `Session`. The status is `201` for a new session. If you already have a live session on that
model, you get that session back with `200`, and nothing new is held.

What kind of session you get:

- **Paid: send `minutes`** (or `free: false`). You need a wallet: an API key or the browser sign-in. The price
  of the minutes is held from your balance now and settled when the session ends. With `free: false` and no
  `minutes` the session gets 10 minutes, or as many as the balance covers if that is fewer. Without a wallet
  the answer is `401 sign_in_required`. If the balance does not cover the minutes you asked for, or one
  minute, the answer is `402 insufficient_balance`. `minutes` is always paid: it never starts a free try.
- **Free try: send `free: true`** with the `turnstile` token. It starts from the browser only, on a Light
  model, and runs 5 minutes. Nothing is held and nothing is charged, whatever your balance is. An API key, or a
  model that is not Light, gets `403 trial_unavailable`. See [pricing](/docs/pricing) for its limits.
- **Neither field:** a wallet that can pay for at least one minute gets a paid session of 10 minutes, or of
  what the balance covers if that is less. An API key that cannot pay gets `402 insufficient_balance`. Any
  other caller is treated as asking for the free try. On a model that is not Light the answer is then
  `401 sign_in_required` without a wallet and `402 insufficient_balance` with one. Send `minutes` or `free` to
  say which one you mean.

`free: true` together with `minutes` is `400 bad_request`.

The wake is free, within a budget. A paid session that you stop before the model is ready is an uncharged
wake. After more than 3 of those in a rolling hour, or 10 in a day, the next start answers `429 wake_budget`,
with `retry_after` in the body, in seconds, and a `Retry-After` header. A wake that failed on our side never
counts.

When the service has given away its share of uncharged wakes for the hour, a paid session stopped before the
model is ready is charged the one-minute minimum instead, is not counted against the account, and its receipt
carries `note: "wake_minimum"`.

A `Session`:

```json
{
  "id": "ses_abcdefghijklmnopqrstuvwx",
  "model_id": "qwen3-8b",
  "state": "waking",
  "stages": [{ "stage": "queued", "t_ms": 0 }],
  "created_at": 1794299999000,
  "degraded": false,
  "started_at": null,
  "ends_at": null,
  "now": 1794300000000,
  "base_url": "/v1",
  "spent_usd_micro": 0,
  "tokens_in": 0,
  "tokens_out": 0,
  "gpu_seconds": 0,
  "free": false
}
```

| Field | Meaning |
| ----- | ------- |
| `state` | `waking`, `active`, `ended` or `failed`. |
| `paused` | Present and `true` while the model is being woken again under a session that was already running. The state is `waking` and the clock stands still. |
| `stages` | The wake so far. Each entry is a `StageEvent`: `stage`, `t_ms` (milliseconds since the session was asked for) and sometimes `detail`. |
| `created_at` | When the session was asked for. The wake is timed from here. |
| `degraded` | `true` while a wake is running and its stage data could not be read on the last check, so `stages` may lag. `false` otherwise. A change goes out with the next `tick` event. |
| `started_at` | When the model was ready and the clock started. `null` during the first wake. It moves forward by the length of every pause. |
| `ends_at` | When the paid time runs out. `null` during the first wake and while paused. After the end, when it ended. |
| `now` | The server's clock, so you can count down without trusting your own. |
| `base_url` | Where inference lives, relative to the site: `/v1`. |
| `spent_usd_micro` | The charge so far. `0` for a free session. |
| `gpu_seconds` | Seconds on your clock so far. |
| `tokens_in`, `tokens_out` | Token counts so far. For your information. |
| `free` | Whether this is a free try. |
| `receipt` | Present once the session has ended or failed. |

Stages are `queued`, `gpu`, `container`, `weights`, `engine`, `ready` and `failed`. Each `StageEvent` is
`{ stage, t_ms, detail? }`. `t_ms` is the time the stage began, in milliseconds from when the session was asked
for (`created_at`). Stages that began before the session joined show 0. A stage can appear more than once, and
a stage whose time was not recorded is left out. A session that
joins a model which is already awake gets one `ready` stage with `t_ms` 0. See
[how a wake works](/docs/models#how-a-wake-works).

A session can go from `active` back to `waking`. That happens when the model drops and is woken again: `paused`
is `true`, `stages` starts over with the new wake, `gpu_seconds` and `spent_usd_micro` stand still, and `ends_at`
is `null` until the model is ready. Then the state is `active` again and `ends_at` is later by the length of
the pause. If the model cannot be woken again, the session ends with the reason `model_lost`. Do not treat
`waking` as "never started": check `paused`, or `started_at`.

After the model was woken again, the wake time of the session is still that of its first wake: `wake_s` on the
receipt is what you waited at the start. `started_at` has moved forward by the time the model was away, so
`started_at - created_at` is no longer the wake time, and `stages` is the list of the latest wake.

A `receipt`:

| Field | Meaning |
| ----- | ------- |
| `minutes` | GPU minutes on your clock, to two decimals. |
| `gpu_seconds` | The same, in whole seconds. This is what was charged. |
| `price_usd_micro` | The charge. `0` for a free session and for a failed wake. |
| `tokens_in`, `tokens_out` | Totals. |
| `wake_s` | Seconds from your request to a ready model, for the first wake. |
| `reason` | `stopped`, `time`, `idle`, `model_lost`, `wake_failed`, `wake_timeout` or `funding_error`. |
| `note` | Present only when the price needs a word the other fields do not give. `wake_minimum`: the session was stopped before the model was ready, at an hour when the service had given away its share of uncharged wakes, so it was charged the one-minute minimum. |

### Read a session

```
GET /api/sessions/{id}
```

Returns the `Session`. Poll it every few seconds while the state is `waking`.

### Follow a session

```
GET /api/sessions/{id}/events
```

A server-sent event stream. Each event's data is JSON.

| Event | Data | When |
| ----- | ---- | ---- |
| `stage` | A `StageEvent` | Once for each stage so far when you connect, then as stages happen. |
| `tick` | The `Session` | Every 2 seconds while the session is live. |
| `ended` | The `Session`, with `receipt` | Once. The stream closes after it. |

If you connect after the session has ended, you get its stages, then `ended`, and the stream closes.

```
event: stage
data: {"stage":"weights","t_ms":21400}

event: tick
data: {"id":"ses_...","state":"active", ...}
```

### Extend a session

```
POST /api/sessions/{id}/extend
```

```json
{ "minutes": 10 }
```

Adds whole minutes at the session's own price. The extra amount is held from your balance. Returns the `Session`
with a later `ends_at`. Needs the session's owner: an API key or the signed-in wallet. The session id alone is not
enough. A session cannot go past 240 minutes in total. An extension that arrives while the session ends answers
`409 session_ended`, and the amount it held goes back to your balance.

### Stop a session

```
POST /api/sessions/{id}/stop
```

No body. Ends the session now and returns it with its `receipt`. Needs the session's owner: the wallet that
started it, through its sign-in or one of its API keys, or for a free try the browser that started it. The
session id alone is not enough: the answer is `404 session_not_found`.

A paid session is billed by the second, with a one-minute minimum once the model is awake. Stopping a session
during its first wake costs nothing, and for a paid session it counts against the wake budget. When the service
has given away its share of uncharged wakes for the hour, such a stop costs the one-minute minimum instead and is
not counted (`note: "wake_minimum"` on the receipt). Stopping a
paused session costs the seconds used before the pause, with no minimum: the model went away under it. A
session that ends because the model was lost (`model_lost`) pays for its seconds only, with no minimum either. Stopping an ended session
returns it unchanged.

## Inference

```
POST /v1/chat/completions
POST /v1/completions
GET  /v1/models
```

The two `POST` routes take the body an OpenAI client sends and return what an OpenAI server returns. The body goes
to the model as you sent it, so the fields that work are the ones the inference engine supports. `tools` in the
body are passed to the model. The gateway does not run them: your code does. Other `/v1` paths answer `404`.
There are no embeddings, images or audio.

```
curl https://freeweight.xyz/v1/chat/completions \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-8b", "messages": [{"role": "user", "content": "Say hello."}]}'
```

A request that names the always-awake model in `model` is the exception to most of this section. It needs no
session and is answered at once. See [the always-awake model](#the-always-awake-model).

### Which session a request runs on

1. The session named in `X-Freeweight-Session`, or a `ses_` id sent as the bearer token.
2. Otherwise, your live session on the model named in `model`.
3. Otherwise, if your API key has `auto_session` on, a new paid session: 10 minutes, or what the balance covers if
   that is less.
4. Otherwise the answer is `409 no_active_session`.

With an explicit session, `model` is optional. If you send it, it must be the session's model.

### Waiting for a wake

If the session is still waking, the request waits. When the model is ready, it runs. If the model is not ready
after 5 minutes, the answer is `503 model_waking` with `Retry-After: 10`: send the request again. If the wake
fails, the answer is `409 session_ended`.

The same goes for a model that drops under a running session. A request that finds the model gone waits while
it is woken again and is then sent once more, so you get a slow answer, not an error. If the model cannot be
woken again, the answer is `503 model_lost`. An answer that was already streaming when the model dropped is
cut off and is not repeated.

A request does not outlive its session. An answer that is still running when the session ends is cut off at
that moment. Extend the session first if a long answer needs more time.

Set your client's timeout above 5 minutes, or start the session first and wait for `ready` yourself.

### Streaming

`"stream": true` returns server-sent events in the OpenAI format, ending with `data: [DONE]`. A final chunk with
token usage is sent only if you ask for it with `"stream_options": {"include_usage": true}`.

A stream that breaks, or that is cut because the session ended, does not end with `data: [DONE]`. Its last
block is one error, and then the stream closes in order:

```
data: {"error": {"code": "session_ended", "message": "...", "type": "session_ended"}}
```

The code is `upstream_error` when the model's stream stopped or broke before it finished, `session_ended` when
the paid time ran out, and `slow_client` when your client read the stream too slowly: more than 8 MB of the
answer waited for it, so the gateway cut the stream and cancelled the request. A line that the model's stream
cut off in the middle is not passed on: every `data:` line you get is whole JSON or `[DONE]`. A stream without
`[DONE]` is not a complete answer.

### What the gateway changes

Very little. `model` is filled in when you leave it out, and a `model` that is not the session's is refused
with `400 model_mismatch`. On a stream the gateway always asks the model for token usage, and drops that
chunk unless you asked for it.

Three fields are checked before anything is sent, because the model would read a wrong value differently than
the gateway does. Each answers `400 invalid_request` when it is wrong:

- `stream` must be `true` or `false`. A string such as `"true"` is refused.
- `n`, the number of answers, must be a whole number from 1 to 4. Each answer is generated in full.
- `max_tokens` and `max_completion_tokens` must be whole numbers of zero or more.

Every other field goes to the model untouched, including fields the gateway does not know. `max_tokens` is not
capped by the gateway.

### Tool calls

A model whose catalog entry says `tools_ok: true` returns parsed `tool_calls`, and the answer ends with
`finish_reason: "tool_calls"`. You run the tool and send its result back in a message with the role `tool`.
In v0.1 that works on `qwen3-8b` and `qwen3-32b`. `llama33-70b` says `false`: tool calling has not been tested
on it, so do not send `tools` to it.

With streaming, a tool call arrives in pieces. The first piece carries `index`, `id` and `function.name`. The
pieces after it carry `index` and a fragment of `function.arguments`. Join the fragments that share an `index`.
These are the `delta` objects of three chunks:

```
{"tool_calls": [{"index": 0, "id": "chatcmpl-tool-a98c", "type": "function", "function": {"name": "holders"}}]}
{"tool_calls": [{"index": 0, "function": {"arguments": "{\"address\": \"0x12"}}]}
{"tool_calls": [{"index": 0, "function": {"arguments": "34\"}"}}]}
```

This is the OpenAI streaming format. A client that handles it there handles it here.

### Thinking

The Qwen3 models think before they answer. The thinking text is kept apart from the answer:

- Without streaming it is in `choices[0].message.reasoning`. The answer is in `message.content`.
- With streaming it arrives as `delta.reasoning`, before the pieces of `delta.content`.
- It counts as completion tokens. `usage.completion_tokens_details.reasoning_tokens` says how many.

Switch it off for one request:

```json
{
  "model": "qwen3-8b",
  "messages": [{ "role": "user", "content": "Say hello." }],
  "chat_template_kwargs": { "enable_thinking": false }
}
```

Thinking is not billed by the token, because nothing is. It costs time on the session clock and room in the
context. A small `max_tokens` can be used up by the thinking before the answer starts.

### Context

Every model in v0.1 has a context of 16384 tokens: the prompt, the thinking and the answer together. A request
that is too long gets an error from the model that says so.

### Response headers

`x-freeweight-session` names the session the request ran on. It comes on successful answers only. With
`auto_session` this is how you learn the id of the session that was started for you.

### `GET /v1/models`

The catalog in OpenAI's list shape. Each entry has `id`, `object`, `created` and `owned_by`, plus `name`,
`context_length`, `state`, `tier` and `price_usd_micro_per_min`. `context_length` is 16384 on every rented model
in v0.1. This list has no `tools_ok`: read that from `GET /api/models`.

When the always-awake model is offered, it is the first entry. It has no `tier` and no price per minute. In
their place it carries `hosted: true`, `max_output_tokens`, `price_in_usd_micro_per_mtok` and
`price_out_usd_micro_per_mtok`, and its `state` is always `awake`.

## The always-awake model

One model needs no wake and no session. It is served by a hosted endpoint, not from a GPU rented here, and it is
paid per token from the same balance. [Pricing](/docs/pricing#the-always-awake-model) has the rules for money.

```
GET /api/hosted
```

```json
{
  "model": {
    "id": "deepseek-v4.1-flash",
    "kind": "hosted",
    "name": "DeepSeek V4.1 Flash",
    "blurb": "A fast general model in an uncensored build: it does not refuse topics, and you are responsible for what you do with the answers. Always awake: no wake, no session, paid per token.",
    "source": "",
    "context": 128000,
    "price_in_usd_micro_per_mtok": 500000,
    "price_out_usd_micro_per_mtok": 2000000,
    "max_output_tokens": 4096,
    "tools_ok": true,
    "free": { "per_day": 20, "max_input_bytes": 4000, "max_output_tokens": 400 },
    "created_at": 1794355200000
  }
}
```

`model` is `null` when the deployment does not offer the model. Then `/v1/models` does not list it, its id
answers `404 model_not_found`, and the chat route below answers `404 not_found`. Prices are millionths of a US
dollar for one million tokens: `500000` is $0.50. `source` is one line about where the model is served from. It
is empty when the operator has set none, and it is repeated at the end of `blurb`. `free` describes a free
message in the chat on the site. This model is not in `GET /api/models`, which lists rented models only.

### Through `/v1`

```
curl https://freeweight.xyz/v1/chat/completions \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": "Say hello."}]}'
```

`POST /v1/chat/completions` with this model's id in `model` runs without a session. `/v1/completions` does not
serve it. What differs from a rented model:

- **Credential.** An API key, or the browser sign-in. Anything else answers `401 unauthorized`. No session is
  started, also for a key with `auto_session`.
- **Money.** The highest price the request can have is held from the balance before it runs: everything you
  sent for the model to read (messages, tools, an answer format), counted at one token for every byte, plus `max_tokens` of output. If the balance does not cover that, the
  answer is `402 insufficient_balance`. When the answer ends, the charge is written from the token counts and
  the rest of the hold is released. On a stream this happens before the stream closes.
- **Fields.** These go to the model: `messages`, `tools`, `tool_choice`, `parallel_tool_calls`,
  `temperature`, `top_p`, `stop`, `presence_penalty`, `frequency_penalty`, `seed` and `response_format`. Every
  other field stays at the gateway, `chat_template_kwargs` among them. One that is `null` counts as left out.
- **Text only.** Message `content` is a string, or an array of parts of the form `{"type": "text", "text": ...}`.
  Pictures, files and audio are not read. An assistant message with `tool_calls` may have `content: null`.
  A field of a message other than `role`, `content`, `name`, `tool_calls` and `tool_call_id` is left out.
- **Your tools only.** Each entry of `tools` is `{"type": "function", "function": {name, description,
  parameters, strict}}`: a function your own code runs when the model calls it. Other tool types are refused.
  `tool_choice` is `auto`, `none`, `required` or one named function. `stop` is a string or up to four strings.
  `response_format` is of type `text`, `json_object` or `json_schema`.
- **Checks.** `messages` holds 1 to 200 messages with the roles `system`, `user`, `assistant` and `tool`
  (`400 bad_request` otherwise). A field above with a value it does not allow answers `400 invalid_request`,
  and nothing is sent to the model. `stream` must be `true` or `false`. `n` must be 1 or left out. `max_tokens` and
  `max_completion_tokens` must be whole numbers of one or more. A value above `max_output_tokens` is lowered to
  it, and a request that sends neither gets `max_output_tokens`.
- **The answer.** A chat completion in the OpenAI shape, with this model's id in `model`. A message carries
  `role`, `content` and, when the model sent them, `tool_calls`, `refusal` and `reasoning_content`. `usage` has
  `prompt_tokens`, `completion_tokens` and `total_tokens`: the numbers the charge was made from.
  `finish_reason` is `stop`, `length`, `tool_calls` or `content_filter`. The `id` of a tool call is made by the
  gateway (`call_...`). Send it back as `tool_call_id` with the result, as with any OpenAI-shaped API.
- **No thinking pass.** This model answers directly. The gateway asks for no thinking on every request, and
  thinking fields you send stay at the gateway. If the model's server reports thinking tokens anyway, they are
  in `completion_tokens` and charged as output, inside the hold.
- **Streaming.** `"stream": true` works as on a rented model, ending with `data: [DONE]`, and the usage chunk is
  sent only with `"stream_options": {"include_usage": true}`. A stream that breaks ends with one error block and
  no `[DONE]`: `upstream_error` or `slow_client`. It is charged for what arrived.
- **Failure.** A request that fails before any answer, or a request without streaming whose answer broke off,
  answers `502 upstream_error` and costs nothing.
- **Closing early.** A request you close after it was sent to the model is charged: for what you sent, and for
  what the model had written by then. This holds with and without streaming, and it counts toward your limits.
- **Tools.** `tools` are passed to the model and it returns `tool_calls`, streamed or not. Your code runs them.
- **Header.** The answer carries `x-freeweight-request` with the id of the request (`hst_...`). There is no
  `x-freeweight-session`.
- **Limits.** One account runs at most 4 requests at the same time (`429 too_many_in_flight`) and 30 in a minute
  (`429 rate_limited`). When the model has reached what it may cost in a day, all callers together, the answer is
  `503 hosted_busy` until the next UTC day. All three carry `Retry-After`.

### The chat on the site

```
POST /api/hosted/chat
```

```json
{
  "messages": [{ "role": "user", "content": "Who holds this token? 0x..." }],
  "tools": true
}
```

One turn of a conversation, with the tool loop run by the server. This is what the chat page of the site uses.
`messages` is as above. `tools`, `temperature` and `max_tokens` are optional. `turnstile_token` carries the
token of the human check when one is needed.

Who pays is decided for each request:

- **Paid.** A signed-in wallet, or an API key, whose balance covers the request pays per token. With
  `tools: true` the model may call the [tools](/docs/tools), at most 4 rounds of 3 calls. Each step of the loop
  is held and charged as one request.
- **Free.** Everyone else gets a free message: 20 a day per visitor, with a limit per network address and a
  daily total for all visitors. A free message runs without tools, also when `tools` is `true`. Older turns of
  the conversation are dropped until it fits in 4,000 bytes, and the answer stops at 400 tokens. If the newest
  message alone is longer than that, the answer is `413 message_too_long`. The first free message of a UTC day
  needs the human check: `400 turnstile_required` without a token. An API key gets no free messages: it answers
  `402 insufficient_balance` when the balance does not cover the request.

A request that is not let in is a plain error answer: `429 free_used`, `429 free_budget_spent`,
`429 rate_limited`, `429 too_many_in_flight`, `402 insufficient_balance` or `503 hosted_busy`. Otherwise the
answer is a server-sent event stream:

| Event | Data |
| ----- | ---- |
| `start` | `{ free, free_left, tools }`: whether this turn is free, how many free messages are left today after it (`null` on a paid turn), and whether tools are on for it. Always first. |
| `delta` | `{ text }`: a piece of the answer. |
| `reasoning` | `{ text }`: a piece of the model's thinking, if it sends any. |
| `tool_call` | `{ id, name, arguments }`: the model asked for a tool. |
| `tool_result` | `{ id, name, ok, summary }`: the tool answered. |
| `usage` | `{ tokens_in, tokens_out, cost_usd_micro, free }`: one for each step of the loop, after its text. `cost_usd_micro` is what the step was charged, `0` on a free turn. |
| `done` | `{ rounds }` |
| `error` | `{ code, message }`. A stream that fails ends with this event and sends no `done`. Steps that already sent `usage` stay charged. |

### In your account

`GET /api/me` carries `hosted` when the model is offered, and `null` otherwise:

| Field | Meaning |
| ----- | ------- |
| `model_id` | The model's id. |
| `free_per_day`, `free_left` | Free messages a day, and how many this caller has left today. |
| `check_needed` | Whether the next free message needs the human check. |
| `recent` | The account's last 20 answers, newest first: `id`, `at`, `surface` (`chat` or `api`), `free`, `tokens_in`, `tokens_out` and `charged_usd_micro`. |

## Chat with tools

```
POST /api/sessions/{id}/chat
```

With `tools: true` this route runs the [tools](/docs/tools) on the server, so a model can look things up without
your code running anything, and puts the `tool_system_note` from `GET /api/config` in front of the conversation.
`tools` is off unless you send `true`. Without it the route is a plain chat on the session, with no tools and no
note.

```json
{
  "messages": [{ "role": "user", "content": "Who holds this token? 0x..." }],
  "tools": true
}
```

`messages` holds 1 to 200 messages with the roles `system`, `user`, `assistant` and `tool`. `tools`, `temperature`
and `max_tokens` are optional. So is `chat_template_kwargs`, which goes to the model as sent:
`{ "enable_thinking": false }` switches thinking off. The answer is a server-sent event stream:

| Event | Data |
| ----- | ---- |
| `delta` | `{ text }`: a piece of the answer. |
| `reasoning` | `{ text }`: a piece of the model's thinking, for models that think. |
| `tool_call` | `{ id, name, arguments }`: the model asked for a tool. |
| `tool_result` | `{ id, name, ok, summary }`: the tool answered. |
| `usage` | `{ tokens_in, tokens_out }` |
| `done` | `{ rounds }` |
| `error` | `{ code, message }`. A stream that fails ends with this event and sends no `done`. |

The model gets at most 4 rounds of tool calls with 3 calls each, then must answer. Tool calls cost nothing extra.
The session clock runs while they do.

## Account

`GET /api/me` answers for anyone. The other routes here need a wallet: an API key or the browser sign-in.

### `GET /api/me`

```json
{
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "balance_usd_micro": 4700000,
  "held_usd_micro": 300000,
  "free_today": { "trial_available": true, "trial_minutes": 5, "allowance_usd_micro": 0 },
  "keys": [],
  "perks": { "enabled": false, "day": "2026-11-10", "hold": null, "stake": null, "allowance_usd_micro": 0 },
  "sessions": [],
  "hosted": { "model_id": "deepseek-v4.1-flash", "free_per_day": 20, "free_left": 20, "check_needed": true, "recent": [] },
  "listing_proof_line": "freeweight-owner: 0x1234567890abcdef1234567890abcdef12345678"
}
```

`perks.hold` is always `null` in v0.1. Perks are planned for staking only, and nothing is deployed.

`balance_usd_micro` is what you can spend now. `held_usd_micro` is held by live sessions and is not part of the
balance. `sessions` lists up to 5 live sessions. `hosted` is the caller's use of
[the always-awake model](#in-your-account), or `null` when it is not offered. `listing_proof_line` is the line this wallet puts in a model's
README to [list it](/docs/listing). Without a wallet it comes back with `address: null`, no
`listing_proof_line`, and `perks` holding only `enabled`.

### API keys

| Endpoint | Does |
| -------- | ---- |
| `GET /api/keys` | Lists keys: `id`, `prefix`, `name`, `auto_session`, `created_at`, `last_used_at`. Never the key itself. |
| `POST /api/keys` | Creates a key from `{ "name": "...", "auto_session": false }`. The answer carries `key` once. Browser sign-in only. |
| `DELETE /api/keys/{id}` | Revokes a key at once. Browser sign-in only. |

### Top-ups

```
POST /api/topups
```

```json
{ "tx_hash": "0x..." }
```

Send ETH or USDG on Robinhood Chain from your wallet to the treasury address in `GET /api/config`, then submit
the transaction hash. The gateway reads the transaction from the chain and credits what it finds.

```json
{
  "credited_usd_micro": 5000000,
  "asset": "USDG",
  "amount": "5",
  "already_credited": false,
  "credits": [{ "asset": "USDG", "amount": "5", "credited_usd_micro": 5000000, "already_credited": false }],
  "balance_usd_micro": 5000000
}
```

| Code | Meaning |
| ---- | ------- |
| `topups_closed` | No treasury address is set. Top-ups open at launch. |
| `tx_not_found` | The chain does not know the transaction yet. Try again in a few seconds. |
| `pending_confirmations` | Fewer than 20 confirmations so far. Carries `confirmations` and `required`. |
| `tx_failed` | The transaction reverted. |
| `no_transfer` | The transaction sends no ETH or USDG from your wallet to the treasury. |
| `tx_already_used` | The transaction was credited to another wallet. |
| `tx_too_old` | An ETH transfer older than 6 hours. It has to be credited by hand. USDG has no such limit. |
| `amount_too_small` | The amount rounds to nothing. |
| `rpc_unavailable`, `price_unavailable`, `price_out_of_bounds` | The chain or the ETH price could not be read. Nothing was credited. Submit the same hash again later. |

## Pasted models

Anyone can paste the ID of a public text model on Hugging Face and have it loaded into the catalog. The check is
free. The first load is paid by whoever starts it, with a cap. [Bring any model](/docs/any-model) explains the
flow and what is accepted.

| Endpoint | Does |
| -------- | ---- |
| `POST /api/models/check` | Checks a repository from `{ "repo": "org/model" }`. No authentication. |
| `POST /api/loads` | Starts the first load from `{ "repo": "org/model", "private": false }`, or joins the load that is running. `private: true` loads a private copy of your own. Needs a wallet: an API key or the browser sign-in. |
| `GET /api/loads` | `{ loads: [Load] }`: the last 20 loads of the account. Needs a wallet. |
| `GET /api/loads/{id}` | One `Load`. Public, unless the load is of a private model. |
| `GET /api/loads/{id}/events` | The same load as an event stream. |
| `GET /api/me/models` | `{ models: [...] }`: the pasted models the account loaded, private ones included. Needs a wallet. |
| `PUT /api/models/{id}/private` | Keeps a pasted model private or makes it public, from `{ "private": true }`. Only the account that loaded it. A public model stays public once another account has paid for a load of it (`409 paid_by_others`). A private copy becomes public, under its id, only while the repository has no public model (`409 public_copy_exists`). Returns the `Model`. |

### Check a repository

```
POST /api/models/check
```

```json
{ "repo": "your-org/your-model" }
```

`repo` is a model ID or the address of a model page on Hugging Face. The answer has status 200 whether the model
can be loaded or not. Read `ok`.

A refusal is `{ ok: false, repo, code, reason }`. `code` is one of `repo_not_found`, `disabled`, `gated`,
`not_text_generation`, `no_safetensors`, `unsupported_architecture`, `custom_code`, `unsupported_quantization`, `no_chat_template`,
`too_big`, `blocked`, `removed`. `reason` is one sentence for a person.

An accepted model:

| Field | Meaning |
| ----- | ------- |
| `ok` | `true` |
| `repo` | The repository name as Hugging Face writes it. |
| `sha` | The commit a load would fetch: the current one, or the pinned one when the model was loaded before. |
| `name`, `license`, `params_b`, `architecture` | From the repository. `license` is what the model card states, or `""`. |
| `tier` | The class the files fit: `light`, `medium` or `heavy`. |
| `size_bytes` | The bytes a load fetches and stores. |
| `context` | The context the model is served with: what its config states, up to 8192 tokens. |
| `price_usd_micro_per_min` | The price of the class, for the load and for sessions. |
| `load_cap_minutes`, `load_cap_usd_micro` | The most minutes a first load is charged for, and what they cost. This amount is held when a load starts. |
| `load_estimate_s`, `wake_estimate_s` | Estimates from the size, in seconds, with a GPU free at once. Waiting for a GPU can add a few minutes to either. For an AWQ or GPTQ model, `wake_estimate_s` is that of a start from scratch, which its first wake after the load has been. After the model's third wake, it is what its wakes measured, without the time they waited for a GPU. |
| `state` | `new`, `needs_load`, `loading` or `loaded`. |
| `model_id` | The catalog id, when `state` is `loaded` or `needs_load`. Otherwise `null`. |
| `load_id` | The running load, when `state` is `loading`. Otherwise `null`. |
| `private` | `true` when `state` is about your own private copy. |
| `can_load` | `true` when `state` is `new` or `needs_load`. |

The answer is about your own private copy of the repository when you have one, and else about its public model.
Another account's private copy is never named or counted: for you it does not exist. A repository is read from
Hugging Face at most once in two minutes, so a change there can take that long to show.

The other answers are `400 bad_repo`, `429 rate_limited`, `502 hf_unavailable` and `503 checks_unavailable`.

### Start a first load

```
POST /api/loads
```

```json
{ "repo": "your-org/your-model", "private": false }
```

The repository is checked again. Then the cap of the load is held from the balance and the load starts. The
answer is a `Load`, with status 201 for a new load and 200 when you joined one that was running. Whoever joins
holds nothing and pays nothing.

```json
{
  "id": "load_k3v7x2m4q7w5z6t5",
  "model_id": "your-org_your-model",
  "hf_repo": "your-org/your-model",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "tier": "light",
  "state": "loading",
  "stage": "downloading",
  "bytes": 2147483648,
  "size_bytes": 6442450944,
  "mine": true,
  "price_usd_micro_per_min": 30000,
  "cap_minutes": 5,
  "hold_usd_micro": 150000,
  "charged_usd_micro": 0,
  "gpu_at": null,
  "gpu_wait_ms": null,
  "created_at": 1794300000000,
  "ended_at": null,
  "now": 1794300042000
}
```

| Field | Meaning |
| ----- | ------- |
| `state` | `loading`, `ready` or `failed`. |
| `stage` | `queued`, `checking`, `downloading`, `validating`, `starting`, then `ready` or `failed`. |
| `bytes`, `size_bytes` | Fetched so far, and the total. |
| `mine` | `true` for the account that pays for the load. |
| `hold_usd_micro`, `charged_usd_micro` | The hold and the charge. Both are 0 for anyone but the payer. |
| `gpu_at`, `gpu_wait_ms` | When the load reached its GPU stage (`starting`), and how long it then waited for a GPU, until the machine with the GPU first reported. Each is `null` until it is known. The wait is not charged. |
| `code`, `detail` | On a failed load: why, as a code and as one sentence. |
| `created_at`, `ended_at`, `now` | When the load started, when it ended (`null` while it runs), and the server's clock. |

A load that ends `ready` is charged the price per minute for the seconds from `created_at` to the end less
`gpu_wait_ms`, at most `cap_minutes`. A load that ends `failed` is charged nothing. In both cases the rest of the hold returns. The
model's commit is pinned by its first load: a load after the weights were cleared fetches the same `sha`.

Refusals come before any money is held:

| Status | Code | Meaning |
| ------ | ---- | ------- |
| 422 | a check code | The repository cannot be loaded. The codes and sentences are those of the check. |
| 409 | `already_loaded` | The model is in the catalog. Carries `model_id`. |
| 402 | `insufficient_balance` | The balance does not cover the cap. Carries `needed_usd_micro`. |
| 429 | `rate_limited` | More than 20 checks and loads in a minute, from one network address or one account. |
| 429 | `failed_load_limit` | 2 loads of the account failed on a GPU in the last 24 hours. Carries `retry_at`, when the next load is taken. |
| 429 | `daily_load_limit` | 5 first loads per account in a rolling 24 hours. |
| 429 | `load_running` | The account has a load running, in `load_id`. One at a time. |
| 429 | `too_many_loads` | Too many loads are running across the service. Carries `Retry-After: 120`. |
| 503 | `storage_full` | The storage for pasted models is full. |
| 503 | `loads_unavailable`, `load_not_started` | No GPU source takes pasted models right now, or the load could not be handed over. The hold was returned. |

The `code` of a failed load is one of `insufficient_balance`, `too_big`, `unsupported_architecture`,
`custom_code`, `unsupported_quantization`, `no_chat_template`, `no_weights`, `unsupported_format`, `unsafe_files`, `too_many_files`, `no_config`,
`download_failed`, `wake_failed`, `timeout`, `removed`, `blocked`, `lane_unavailable`, `build_error`.

`private` names the copy you load: `true` your own private copy, which gets an id of its own (the public id with
`_p` and six more characters); `false` the public model; left out, your private copy if you have one, else the
public model. A private copy does not keep anyone else from loading the repository.

The model is started on a GPU for at most the cap of its class, counted from the moment the machine with the GPU
first reports. The wait for a GPU before that is not charged. A model that is not ready by then fails its load
with `wake_failed` or `timeout`, and is charged nothing.

### Follow a load

`GET /api/loads/{id}` returns the `Load`. It needs no authentication unless the load is of a private model, which
only its account can read: everyone else gets `404 load_not_found`.

`GET /api/loads/{id}/events` is the same as server-sent events:

| Event | When | Data |
| ----- | ---- | ---- |
| `load` | At once, and each time the stage or the byte count changes. | The `Load`. |
| `tick` | Every 2 seconds while the load runs. | The `Load`. |
| `ended` | Once, when the load is `ready` or `failed`. The stream closes after it. | The `Load`. |

A load does not depend on the stream. Close it and open it again whenever you like.

### Your pasted models

`GET /api/me/models` lists the pasted models the account loaded. Each is a `Model` with three more fields:
`size_bytes`, `last_woken_at`, and `clears_at`, the time the weights are due to be cleared (`null` when they are
cleared already). Weights are cleared when nobody has woken the model for `paste.clear_after_days` days.

`PUT /api/models/{id}/private` with `{ "private": true }` takes the model out of every public list. From then on
only the loading account can read it or start a session on it. Everyone else gets `404 model_not_found`. Other
answers: `403 not_yours` and `404 model_not_found`.

## Listings

| Endpoint | Does |
| -------- | ---- |
| `POST /api/listings` | Checks a Hugging Face repository from `{ "hf_repo": "org/model" }` and records the result. Needs a wallet. |
| `GET /api/listings/{id}` | Returns a listing. Public. |

A listing has `id`, `hf_repo`, `sha`, `owner`, `proof_line`, `state`, `checks`, `tier`, `size_bytes`, `params_b`, `license`,
`model_id`, `detail` and `created_at`. `state` is `rejected`, `pending`, `building`, `listed` or `failed`. Each
check is `{ name, ok, detail }`. `proof_line` is the line the check looks for in the README:
`freeweight-owner: ` and the owner's address in lower case. See [list a model](/docs/listing).

## Tools over MCP

`POST /mcp` is a Model Context Protocol endpoint with eleven read-only research tools. It needs no session. Ten of
the tools need no key. `web_search` runs only with an API key, or the browser sign-in, and `tools/list` leaves it
out for everyone else. See [tools](/docs/tools)
and [agents](/docs/agents).

This route speaks JSON-RPC 2.0, so its errors do not have the shape above. A refusal is a JSON-RPC error object
with an HTTP status:

| Status | JSON-RPC code | When |
| ------ | ------------- | ---- |
| 400 | `-32700` | The body is not JSON. |
| 400 | `-32600` | The body is not JSON-RPC 2.0, or it carries more than one `tools/call`. |
| 400 | `-32600` | A batch that is not allowed: any batch for protocol version `2025-06-18` or later, an empty batch, a batch of more than 8 messages, or a batch with `initialize` in it. |
| 400 | `-32000` | The `MCP-Protocol-Version` header names a version the server does not support. |
| 403 | `-32000` | A browser request from another site whose origin is not on the allow list. |
| 405 | `-32000` | `GET` or `DELETE`. The endpoint has no event stream and no MCP session. |
| 406 | `-32000` | The `Accept` header rules out JSON. |
| 413 | `-32600` | The body is over 256 KiB. A body sent in chunks is read up to that limit and no further. |
| 415 | `-32000` | `Content-Type` is not `application/json`. |
| 429 | `-32000` | More than 30 tool calls in a minute from one network address. Carries `Retry-After: 30`. |
| 503 | `-32000` | The service is not set up completely. `/mcp` stays closed until it is, like the rest of the API. |

An unknown tool or bad `params` is answered with status 200 and a JSON-RPC error `-32602` in the body. A tool
that ran and failed is a normal result with `isError: true`. That includes arguments that do not fit the tool's
input schema: the result carries the error code `invalid_input`.

Send one message per request. A request without the `MCP-Protocol-Version` header is treated as version
`2025-03-26`, which still allows a batch of up to 8 messages with one `tools/call` among them.

## Rate limits

v0.1 has no general request rate limit. What limits you is the session: every renter of a model shares one GPU,
and a busy model answers more slowly. A model that cannot take another request right now answers
`429 rate_limited` with `Retry-After`. A session runs at most 4 requests at the same time: one more answers
`429 too_many_requests`.

The always-awake model is the one place with a request rate limit: 30 requests a minute and 4 at the same time
for one account.

The fixed limits:

| Limit | Value |
| ----- | ----- |
| Session length | 1 to 240 minutes |
| Idle end | 300 seconds without a request |
| Free try | 5 minutes, one per visitor per UTC day, with limits per network address and a daily total |
| API keys | 20 per wallet |
| Listing checks | 20 per wallet per day |
| Checks of a pasted repository | 20 per minute per network address, and per account |
| First loads | 5 per account in a rolling 24 hours, one at a time. After 2 that failed on a GPU in 24 hours, none until the older of them is 24 hours old |
| Request body | 1 MB on `/api` and `/v1`, 256 KiB on `/mcp` |
| Chat messages | 200 per request on the chat routes |
| Always-awake model | 4 requests at the same time and 30 a minute per account. 4,096 tokens of output per request. A daily ceiling for all callers together. |
| Free messages | 20 per visitor per UTC day in the chat on the site, each at most 4,000 bytes in and 400 tokens out, with limits per network address and a daily total |
| `/mcp` | One message per request with at most one `tools/call`. 30 tool calls per minute per network address. Listing the tools is not counted. |

## Idempotency

There is no idempotency-key header. These calls are safe to repeat:

- `POST /api/sessions` returns your live session on that model instead of starting a second one.
- `POST /api/topups` credits a transaction once. Submitting the hash again returns the same credit with
  `already_credited: true`.
- `POST /api/sessions/{id}/stop` on an ended session returns it unchanged.
- `POST /api/listings` for a repository and commit that already has an open listing returns that listing.
- `POST /api/loads` for a repository that is being loaded returns that load. It never starts a second one and
  never holds twice.
- `POST /api/models/check` changes nothing.

These are not:

- `POST /api/sessions/{id}/extend` adds minutes each time it succeeds.
- `POST /api/keys` creates a new key each time.
- `/v1` requests run each time. A request to the always-awake model is charged each time it is answered.

## Calling from a browser

`/v1` answers cross-origin requests from any origin, with a bearer token or a session header.

`/mcp` is for servers, command lines and SDKs, which send no `Origin` header. A browser page on another site is
refused with HTTP 403 unless its origin is on the operator's allow list.

`/api` is for the site itself and for server-side code.

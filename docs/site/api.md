---
title: API reference
summary: Every public endpoint of the gateway, with authentication, sessions, the event stream, the OpenAI-compatible routes and errors.
order: 40
group: Build
---

The API has two parts.

- `/api` is Freeweight's own API: the catalog, sessions, your account.
- `/v1` is OpenAI-compatible inference. It needs a session, because a session is what you pay for.

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
- Ids have a prefix: `ses_` for sessions, `key_` for API keys, `lst_` for listings. An API key itself starts with
  `fw_`.
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
| 400 | `model_mismatch` | `model` in the request is not the model of the session. |
| 400 | `too_long` | The extension would take the session past 240 minutes. |
| 400 | `turnstile_required` | The free try needs a token from the human check. |
| 400 | `invalid_message`, `nonce_expired`, `nonce_used` | Sign-in message problems. |
| 4xx | `invalid_request_error` | The model refused the request, for example a prompt longer than its context. The status is the one the model gave. |
| 401 | `unauthorized` | No usable credential. |
| 401 | `invalid_api_key` | The API key is unknown or revoked. |
| 401 | `invalid_signature` | The sign-in signature does not match the address. |
| 401 | `sign_in_required` | A paid session was asked for without a wallet. Sign in and top up. |
| 402 | `insufficient_balance` | The balance does not cover the minutes asked for, or one minute. |
| 403 | `bad_origin` | A cross-origin write without a bearer token. |
| 403 | `cookie_required` | API keys are created and revoked from a signed-in browser only. |
| 403 | `turnstile_failed` | The human check failed. |
| 403 | `forbidden` | The treasury wallet cannot top up its own account. |
| 403 | `trial_unavailable` | `free: true` was sent with an API key, or for a model that is not a Light model. |
| 404 | `not_found` | No such route. |
| 404 | `model_not_found`, `session_not_found`, `key_not_found`, `listing_not_found`, `repo_not_found`, `tx_not_found` | No such thing. A session you may not use also answers `session_not_found`. |
| 409 | `no_active_session` | A `/v1` request without a live session, from a key without `auto_session`. |
| 409 | `session_ended` | The session has ended. Start a new one. |
| 409 | `session_live` | A free try was asked for while another session of the same account is live. Carries `session_id`. |
| 409 | `free_session_fixed` | A free session cannot be extended. |
| 409 | `too_many_keys` | The wallet already has 20 keys. |
| 409 | `pending_confirmations`, `tx_already_used` | Top-up states. See below. |
| 413 | `body_too_large` | The body is over 1 MB. |
| 422 | `tx_failed`, `no_transfer`, `tx_too_old`, `amount_too_small`, `amount_too_large` | Top-up problems. See below. |
| 429 | `rate_limited` | The model is busy with other requests. Carries `Retry-After`. The session is still live. |
| 429 | `too_many_requests` | The session already has 4 requests in flight. Wait for one to finish. Carries `Retry-After: 1`. |
| 429 | `wake_budget` | Too many paid sessions were stopped before the model was ready: more than 3 in an hour or 10 in a day. Carries `retry_after`, in seconds, in the error body, and a `Retry-After` header. A wake that failed on our side does not count. |
| 429 | `free_used` | Today's free session is used, for this visitor or this network address. |
| 429 | `free_budget_spent` | Today's free sessions are all taken. |
| 429 | `too_many_listings` | More than 20 listing checks in a day. |
| 500 | `internal_error` | A fault on our side. |
| 502 | `upstream_error` | The model did not answer. Try again. |
| 502 | `hf_unavailable` | Hugging Face could not be read for a listing check. |
| 503 | `model_waking` | The model is still waking after a 5-minute wait, or is being woken again. Carries `Retry-After`. The session is still live. |
| 503 | `model_unavailable` | The model cannot be woken or reached right now. |
| 503 | `misconfigured` | The service is not set up completely. Until it is, only the public reads answer: health, config, stats, receipts and the catalog. |
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
| `GET /api/awake` | `{ awake: [{ model_id, since, sessions }] }`: models on a GPU now. |
| `GET /api/stats` | `{ gpu_seconds, sessions, tokens, wakes, median_wake_s }`: service totals. `median_wake_s` is `null` before the first wake. |
| `GET /api/receipts` | `{ receipts: [...] }`: the last 20 ended sessions, without any account data. |

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
  "tags": ["chat", "reasoning", "tools"],
  "blurb": "Fast general model with tool calling. The default pick.",
  "tools_ok": true
}
```

`state` and `wake_estimate_s` change as the model is used. `hf_repo`, `sha` and `quant` say exactly which
weights are served. `context` is 16384 on every model in v0.1. `tools_ok` is `false` on `llama33-70b`: read it
before you send `tools`. The [models](/docs/models) page explains every field. `state` is one of
`asleep`, `waking`, `awake`, `cold`, `unavailable`.

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
| `stages` | The wake so far. Each entry is a `StageEvent`: `stage`, `t_ms` (milliseconds since the wake began) and sometimes `detail`. |
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
`{ stage, t_ms, detail? }`. `t_ms` is the time the stage began, in milliseconds from the start of the model's
wake. A stage can appear more than once, and a stage whose time was not recorded is left out. A session that
joins a model which is already awake gets one `ready` stage with `t_ms` 0. See
[how a wake works](/docs/models#how-a-wake-works).

A session can go from `active` back to `waking`. That happens when the model drops and is woken again: `paused`
is `true`, `stages` starts over with the new wake, `gpu_seconds` and `spent_usd_micro` stand still, and `ends_at`
is `null` until the model is ready. Then the state is `active` again and `ends_at` is later by the length of
the pause. If the model cannot be woken again, the session ends with the reason `model_lost`. Do not treat
`waking` as "never started": check `paused`, or `started_at`.

A `receipt`:

| Field | Meaning |
| ----- | ------- |
| `minutes` | GPU minutes on your clock, to two decimals. |
| `gpu_seconds` | The same, in whole seconds. This is what was charged. |
| `price_usd_micro` | The charge. `0` for a free session and for a failed wake. |
| `tokens_in`, `tokens_out` | Totals. |
| `wake_s` | Seconds from your request to a ready model, for the first wake. |
| `reason` | `stopped`, `time`, `idle`, `model_lost`, `wake_failed`, `wake_timeout` or `funding_error`. |

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
enough. A session cannot go past 240 minutes in total.

### Stop a session

```
POST /api/sessions/{id}/stop
```

No body. Ends the session now and returns it with its `receipt`. Needs the session's owner: the wallet that
started it, through its sign-in or one of its API keys, or for a free try the browser that started it. The
session id alone is not enough: the answer is `404 session_not_found`.

A paid session is billed by the second, with a one-minute minimum once the model is awake. Stopping a session
during its first wake costs nothing, and for a paid session it counts against the wake budget. Stopping a
paused session costs the seconds used before the pause, with the same minimum. A session that ends because
the model was lost (`model_lost`) pays for its seconds only, with no minimum. Stopping an ended session
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
block is one error:

```
data: {"error": {"code": "session_ended", "message": "...", "type": "session_ended"}}
```

The code is `upstream_error` when the model stopped before it finished, and `session_ended` when the paid
time ran out. A stream without `[DONE]` is not a complete answer.

### What the gateway changes

Very little. `model` is filled in when you leave it out, and a `model` that is not the session's is refused
with `400 model_mismatch`. On a stream the gateway always asks the model for token usage, and drops that
chunk unless you asked for it. Every other field goes to the model untouched, including fields the gateway
does not know. `max_tokens` is not capped by the gateway.

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
`context_length`, `state`, `tier` and `price_usd_micro_per_min`. `context_length` is 16384 on every model in
v0.1. This list has no `tools_ok`: read that from `GET /api/models`.

## Chat with tools

```
POST /api/sessions/{id}/chat
```

This route runs the [tools](/docs/tools) on the server, so a model can look things up without your code
running anything. The server puts the `tool_system_note` from `GET /api/config` in front of the conversation.

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

These need a wallet: an API key or the browser sign-in.

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
  "listing_proof_line": "freeweight-owner: 0x1234567890abcdef1234567890abcdef12345678"
}
```

`perks.hold` is always `null` in v0.1. Perks are planned for staking only, and nothing is deployed.

`balance_usd_micro` is what you can spend now. `held_usd_micro` is held by live sessions and is not part of the
balance. `sessions` lists up to 5 live sessions. `listing_proof_line` is the line this wallet puts in a model's
README to [list it](/docs/listing). Without a wallet the same shape comes back with `address: null` and without
`listing_proof_line`.

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
| `tx_too_old` | An ETH transfer older than a few hours. It has to be credited by hand. |
| `amount_too_small` | The amount rounds to nothing. |
| `rpc_unavailable`, `price_unavailable`, `price_out_of_bounds` | The chain or the ETH price could not be read. Nothing was credited. Submit the same hash again later. |

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

`POST /mcp` is a Model Context Protocol endpoint with ten read-only research tools. It needs no session and no
key. See [tools](/docs/tools) and [agents](/docs/agents).

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
| 413 | `-32600` | The body is over 256 KiB. |
| 415 | `-32000` | `Content-Type` is not `application/json`. |
| 429 | `-32000` | More than 30 tool calls in a minute from one network address. Carries `Retry-After: 30`. |

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

The fixed limits:

| Limit | Value |
| ----- | ----- |
| Session length | 1 to 240 minutes |
| Idle end | 300 seconds without a request |
| Free try | 5 minutes, one per visitor per UTC day, with limits per network address and a daily total |
| API keys | 20 per wallet |
| Listing checks | 20 per wallet per day |
| Request body | 1 MB on `/api` and `/v1`, 256 KiB on `/mcp` |
| Chat messages | 200 per request on the chat route |
| `/mcp` | One message per request with at most one `tools/call`. 30 tool calls per minute per network address. Listing the tools is not counted. |

## Idempotency

There is no idempotency-key header. These calls are safe to repeat:

- `POST /api/sessions` returns your live session on that model instead of starting a second one.
- `POST /api/topups` credits a transaction once. Submitting the hash again returns the same credit with
  `already_credited: true`.
- `POST /api/sessions/{id}/stop` on an ended session returns it unchanged.
- `POST /api/listings` for a repository and commit that already has an open listing returns that listing.

These are not:

- `POST /api/sessions/{id}/extend` adds minutes each time it succeeds.
- `POST /api/keys` creates a new key each time.
- `/v1` requests run each time.

## Calling from a browser

`/v1` answers cross-origin requests from any origin, with a bearer token or a session header.

`/mcp` is for servers, command lines and SDKs, which send no `Origin` header. A browser page on another site is
refused with HTTP 403 unless its origin is on the operator's allow list.

`/api` is for the site itself and for server-side code.

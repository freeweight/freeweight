---
title: API
summary: The session endpoint and the public API.
order: 4
group: Build
---

> [!NOTE]
> This page is a stand-in. The full text is being written.

## Session endpoint

`POST /v1/chat/completions` and `POST /v1/completions` follow the OpenAI format, with streaming. `model` is the model id. The call needs a running session on that model. The always-awake model is the exception: `POST /v1/chat/completions` with its id needs no session and is paid per token.

## Public API

| Method | Path | Returns |
| ------ | ---- | ------- |
| GET | `/api/models` | The catalog |
| GET | `/api/awake` | Models that are awake now |
| GET | `/api/hosted` | The always-awake model, or `null` |
| GET | `/api/stats` | Public counters |
| POST | `/api/sessions` | A new session |
| GET | `/api/sessions/:id/events` | The wake and the clock, as server-sent events |

Errors are JSON: `{ "error": { "code": "snake_case", "message": "..." } }`.

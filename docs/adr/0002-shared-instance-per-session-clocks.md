# 0002: One shared instance per model, one clock per session

- Status: accepted
- Date: 2026-11-10

## Context

Two people can want the same model at the same time. Giving each of them a private GPU doubles the hardware and makes
the second person wait through a wake that the first one already paid for in time.

## Decision

A model has at most one running instance. Every session on that model uses it.

- `ModelDO` (one Durable Object per model id, in the gateway, not in this repository) owns the instance: it wakes it when the
  first session joins, keeps it alive while sessions are live, and puts it to sleep when the last session leaves.
- `SessionDO` (one Durable Object per session, in the gateway, not in this repository) owns one renter's clock, hold and
  receipt. Sessions do not know about each other.
- A session that joins a model that is already awake becomes active at once, with no wake.
- Which models are awake, since when and with how many sessions is public (`GET /api/awake`).

## Consequences

- The second renter of an awake model starts in seconds.
- Each renter pays the full class price for their own minutes. The price is for access to the model, not for a
  private GPU, and the pricing page says so.
- Throughput is shared. A model with many live sessions answers each of them more slowly. v0.1 sets no cap on
  sessions per model: this is an open item (see the gateway's threat model, not in this repository).
- Requests from different sessions are batched by the same inference engine. Sessions cannot read each other's
  prompts through the API, but there is no hardware isolation between renters of one model.
- The model sleeps only when every session has ended, so one long session keeps it awake for later joiners.

## Alternatives

- **A private instance per session.** Clean isolation and predictable speed, at one wake and one GPU per renter.
  Possible later as a separate, higher-priced option.
- **Split the price between live sessions.** Fair in theory, but the price of a minute would then depend on
  strangers, and the receipt could not be predicted when the session starts.

# 0003: Wake time is free

- Status: accepted
- Date: 2026-11-10

## Context

Waking a model takes from tens of seconds to several minutes: a GPU is assigned, a container starts, the weights load
and the engine warms up. The renter can do nothing during that time, and how long it takes is under the operator's
control, not theirs.

## Decision

The session clock starts when the lane reports the model ready, and not before.

- `SessionDO.onReady` sets `started_at` and derives `ends_at` from it. Until then the session is in state `waking`
  and its clock is null.
- A wake that fails or times out ends the session in state `failed`. Nothing is charged and the hold is released in
  full.
- A session stopped while it is still waking is also `failed` with nothing charged.
- A free try whose wake fails is given back: its row in `free_sessions` is removed, so the visitor can try again the
  same day.

## Consequences

- The receipt never contains time in which the model could not answer. It shows the wake time separately, for
  information.
- The operator pays for GPU seconds spent waking. That is a direct incentive to shorten wakes.
- A renter who starts sessions and stops them around the wake causes cost. Two rules bound it. A paid session is
  charged at least one minute once the model was ready for it, and by the second above that. A paid session that
  its renter stops before `ready` is an uncharged wake: an account gets 3 of those in a rolling hour and 10 in a
  day, then the next start is refused with `429 wake_budget`. A wake that failed on the lane's side never counts.
  The free try is limited per visitor, per network address and per day (see the threat model).

## Alternatives

- **Bill from the wake request.** Simple, and unfair: the slowest wakes would earn the most.
- **A flat wake fee.** Covers the cost, but adds a second price to explain and charges for failed wakes unless more
  rules are added.
- **A warm grace period.** Keeping a model up for a while after its last session would save the next wake. Not
  built in v0.1: it is on the roadmap.

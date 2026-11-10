# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository. Please do not open a public issue for anything that could put user balances, keys or sessions at risk.

Include what you found, how to reproduce it and what you think the impact is. You will get an acknowledgement within 72 hours.

## Scope

- The gateway (`apps/gateway`): authentication, sessions, billing ledger, top-up verification, the `/v1` proxy.
- The staking vault (`contracts`).
- The toolkit (`packages/tools`): outbound fetches and anything that handles untrusted pages.

## Ground rules

- The service never holds user private keys and never signs transactions for users.
- Sessions give access to model inference only. There is no code execution surface for users.
- Do not test against other users' sessions or balances.

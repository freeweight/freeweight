# Security

## Reporting

Report a vulnerability privately. Please do not open a public issue for anything that could put user balances,
keys or sessions at risk.

- On GitHub: the "Report a vulnerability" button under this repository's Security tab.
- By mail: hello@freeweight.xyz, with "security" in the subject.

Include what you found, how to reproduce it and what you think the impact is. You will get an acknowledgement
within 72 hours.

## Scope

- The service's API (its code is not in this repository): authentication, sessions, the billing ledger, top-up verification, the `/v1`
  proxy, the always-awake model's per-token path and the free try and free messages.
- The site (`apps/web`): the wallet sign-in, API keys, and anything that renders text from a model, a tool or a
  web page.
- The toolkit and `/mcp` (`packages/tools`): outbound fetches and anything that handles untrusted pages.
- The staking vault (`contracts`), which is not deployed.

## Ground rules

- The service never holds user private keys and never signs transactions for users.
- Sessions give access to model inference only. There is no code execution surface for users.
- Do not test against other users' sessions or balances, and do not run load against the service.

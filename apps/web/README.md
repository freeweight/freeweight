# Freeweight web

The site and the app: wake a model, talk to it, watch the clock, take the receipt. A static bundle that the gateway
serves from the same origin as the API, so every request is a relative `/api`, `/v1` or `/mcp` path.

Vite, React and TypeScript in strict mode. CSS is written by hand on custom properties. There is no UI kit, no
icon pack and no animation library; icons are drawn in `src/ui/bits.tsx`.

## Commands

Run these from `apps/web`, or from the repo root with `-w @freeweight/web`. Node 24. Install once from the repo
root with `npm ci`; the app is an npm workspace and shares the root lockfile.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on `127.0.0.1:5173`. Set `FW_API` to proxy the API to a running gateway. |
| `npm run dev:mock` | Dev server with the in-browser mock gateway. No network needed. |
| `npm run typecheck` | `tsc --noEmit` over the app, tests and scripts. |
| `npm test` | Unit tests (vitest, Node, no browser, no network). |
| `npm run build` | Typecheck, then build to `dist/`. This is what the gateway serves. |
| `npm run build:mock` | The same app with the mock gateway compiled in, to `dist-mock/`. |
| `npm run size` | Gzipped size of the landing route and of every lazy chunk. Fails over 100 kB of landing JS. |
| `npm run e2e` | Playwright tests against a mock build: the main path, layout shift, keyboard focus. Needs `npx playwright install chromium` once. |
| `npm run shots` | Screenshots of every screen and state at 390, 768 and 1440 px in both themes. |

`typecheck`, `test` and `build` need no secrets and no network, and CI runs all three. The browser tests are a
separate script and are not part of CI.

`FW_SITE=https://<public origin> npm run build` writes that origin into the social card address, because link
previews do not follow a relative one. `node scripts/brand.mjs` redraws the social card and the PNG icons in
`public/` from the mark; its output is committed.

### Against a live gateway

```sh
FW_API=https://<gateway origin> npm run dev
```

The dev server proxies `/api`, `/v1` and `/mcp` to that origin and rewrites cookies, so sign-in and sessions work as
they do in production. `FW_API` can also live in `.env.local`, which is ignored by git.

### Mock mode

`VITE_MOCK=1` swaps `fetch` for a fake gateway that runs in the page (`src/api/mock.ts`). It answers every path the
app calls, streams a wake with plausible stage timings, streams chat and keeps a clock. The flag is a build-time
constant: a normal build contains no mock code.

Options go in the address and stay for the tab, for example `/?mock=speed:8,hold:engine`:

| Option | Effect |
| --- | --- |
| `speed:N` | Replay speed. Times shown stay in model time. |
| `hold:<stage>` | Freeze the wake part-way through a stage (`queued`, `gpu`, `weights`, `engine`). |
| `fail:<stage>` | The wake fails during that stage. |
| `active:N` | Once the model is ready, jump N seconds into the session and freeze the clock. |
| `user:1` | Start signed in. |
| `topups:open`, `perks:1` | Show top-ups and perks as switched on. |
| `free:used` | Today's free session is spent. |
| `empty:1` | Nothing awake, counters at zero. |
| `slow:1`, `down:1` | Slow answers; a gateway that does not answer. |
| `model:<id>`, `min:N` | The model and length used by demo addresses. |

`src/api/mock.ts` lists the rest (a retried stage, a degraded wake, a paused session, a listing build).

Any session address that starts with `demo` makes its own session (`/s/demo`), and `/s/demo-ended` opens a finished
one, so every screen has a direct address.

## Layout

```
index.html            meta tags, font preloads, theme before first paint
public/               favicon, PNG icons, social card, robots.txt
scripts/vite-docs.ts  build plugin: docs index, lazy pages, llms.txt and openapi.yaml
scripts/shots.mjs     screenshot run
scripts/size.mjs      bundle report
scripts/brand.mjs     draws the social card and PNG icons from the mark
src/styles/           tokens.css (the design system), base.css (elements and shared classes), md.css
src/api/              types, the one API client, the SSE reader, the mock gateway
src/lib/              plain modules: formatters, wake rack, session store, chat, wallet, Markdown, docs
src/ui/               shared pieces: icons, tags, the wake box
src/views/            one file per screen, each with its own stylesheet
tests/                unit tests
e2e/                  browser smoke tests
```

Views are loaded on demand, and each view's stylesheet travels with it. The landing route loads React, the shell and
the home page. `viem` is loaded only when the sign-in flow opens (`src/lib/viem.ts` is the one module that imports it).

## Size

The landing route has a budget of 100 kB of gzipped JavaScript, and `npm run size` fails a build that goes over.
Measured on this tree:

| What | Gzip |
| --- | --- |
| Landing JS (shell and home 14.2 kB, React 67.4 kB) | 81.6 kB |
| Landing CSS | 5.8 kB |
| Session view (wake, room, receipt), on demand | 13.1 kB JS, 4.0 kB CSS |
| Sign-in (`viem`), on demand | 5.4 kB |
| Account, on demand | 5.1 kB |

The two fonts are 23 kB and 40 kB of woff2, preloaded, latin subset, one variable file each.

## Design

`DESIGN.md` has the tokens, the type scale, the plate motif and the list of things not to do.
`src/styles/tokens.css` holds every colour, space, radius and duration, for the dark theme and the light one. The
theme follows the system and can be pinned with the button in the header.

## Docs pages

`/docs/:slug` renders the Markdown in the repo's `docs/site/` directory. The build plugin reads each page's
front-matter (`title`, `summary`, `order`, `group`) into a small index that ships with the docs view; a page's text
is its own chunk, fetched when the page is opened. The renderer is `src/lib/markdown.tsx`: it builds React elements
and has no path that turns text into HTML, so raw HTML in a page shows as text.

Links between pages (`pricing.md`, `./api.md#errors`) are mapped onto site routes. `docs/site/llms.txt` and
`docs/api/openapi.yaml` are copied to the root of the build as `/llms.txt` and `/openapi.yaml` when they exist.
`src/docs/` holds short stand-in pages for slugs that have no page in `docs/site/` yet; a real page with the same
name replaces its stand-in. A checkout with no `docs/` directory still builds: the docs view then shows the
stand-ins only, and the two plain files are left out.

## What the gateway needs to do for this bundle

- Serve `dist/` at the site root, and answer any path that is not a file, `/api`, `/v1` or `/mcp` with `index.html`.
- Cache `/assets/*` for a long time (file names are content hashes); do not cache `index.html`.

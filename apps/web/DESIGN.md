# Design notes

The idea is calibrated mass: a model is a weight you put on a scale for a while. Three things carry it.

- **Plate.** The unit of the interface is a small rectangle with a 2 px radius. The mark is three of them, each
  narrower than the one above, the top one brass. Tiers, progress, the roadmap and the 404 are drawn from the same
  plates.
- **Scale.** Time and money sit on graduated rules with ticks, like the beam of a balance. The wake view is one:
  each stage is a row on a shared time axis, and the axis grows when a wake runs long.
- **Mass.** Weight class is font weight: Light 300, Medium 500, Heavy 800, in one variable typeface.

## Tokens

Everything is a custom property in `src/styles/tokens.css`. Views take their colours, spaces and durations from there.

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `--bg`, `--surface`, `--raised` | Three steps. Depth comes from hairlines, not shadows. |
| Lines | `--line`, `--line-2`, `--field` | 1 px. `--field` is the edge of a control and holds 3:1 on every surface. |
| Ink | `--ink`, `--ink-2`, `--ink-3` | Text, secondary text, captions. All three pass 4.5:1 on `--bg`. |
| Accent | `--accent`, `--accent-ink`, `--accent-wash`, `--on-accent` | Brass. `--accent-ink` is the text-safe variant in the light theme. |
| Failure | `--danger`, `--danger-wash` | Only for something that failed. |
| Inverse | `--inv-*` | The receipt: a paper ticket on the dark theme, an iron one on the light theme. |
| Space | `--s1` to `--s10` | 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 px. |
| Radius | `--r-1`, `--r-2` | 2 px and 4 px. Nothing rounder. |
| Motion | `--fast`, `--base`, `--slow`, `--ease` | 120, 200 and 400 ms. Off under `prefers-reduced-motion`. |

Two themes share the names: dark ("iron") is the default, light ("paper") follows the system or the header button.

## Type

Mona Sans for text, Geist Mono for anything measured: prices, times, ids, counters. Both are variable, latin subset,
served from the app.

| Use | Size / line | Weight |
| --- | --- | --- |
| Hero | fluid, 40 to 84, line 0.98 | 300 with one phrase at 800 |
| Section head (`.h2`) | 28 / 32 | 600 |
| Sub head (`.h3`) | 20 / 28 | 600 |
| Lead (`.lead`) | 18 / 28 | 400 |
| Body | 15 / 24 | 400 |
| Small (`.small`), labels | 13 / 20 | 400 or 500 |
| Micro (`.micro`), table heads | 11 / 16 mono, uppercase, tracked | 500 |
| Readouts | 20 / 28 mono, tabular figures | 500 |

Below the hero, line heights are multiples of 4 px so rows land on the grid.

## Colour has a meaning

- Brass means awake, live or under load, and nothing else. A sleeping model has no brass on it.
- Red means a failure. A warning that is not a failure is plain text.
- Something that is not switched on yet has a dashed outline and the tag "at launch". It never looks clickable.

## Do not

- Add a second accent, a gradient, a glow or a drop shadow on a panel.
- Round anything past 4 px, or use a pill.
- Use an icon pack or an illustration. Icons are drawn in `src/ui/bits.tsx`.
- Promise a duration. A wake shows what it has measured and the elapsed time, never a countdown.
- Animate layout. Motion is for state (a plate filling, a row settling), and the page must not shift while it runs.
- Write a price, a time or a count in the text face, or a sentence in the mono face.

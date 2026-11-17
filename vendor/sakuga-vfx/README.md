# Sakuga VFX

Ordinary UI controls that react like anime. At rest they are plain. Use one and it squashes and overshoots on springs, and throws drawn effects around itself: smoke puffs, impact bursts, crystal chips, slashes, splashes and smoke rings, with manga sound-effect lettering (ドン!, カチッ, ズザッ). No characters, just the way a key animator would sell a hit.

Every effect is drawn in code on one canvas over the page. The lettering was painted with GPT Image and traced to paths, and the toggle is 43 painted frames; both live inside the component files, so there is nothing else to fetch. No dependencies, no build step for you, MIT licensed.

## The twelve

| | element | what happens |
|---|---|---|
| [Button](button/) | `<sakuga-button>` | Press and it squashes flat. Let go and it inverts for one frame, a burst goes off behind it, clouds roll off the corners and ドン! lands. `done()` puts a check on it. The secondary variant is a small squash and three wedges. |
| [Toggle](toggle/) | `<sakuga-toggle>` | A drawn animation: the knob smears across, slams into the end and throws up a splash, and the track floods and settles. |
| [Slider](slider/) | `<sakuga-slider>` | The thumb stretches into a teardrop and lags on a spring. Drag fast and cumulus rolls up behind it; let go and a crescent flies on ahead. |
| [Checkbox](checkbox/) | `<sakuga-checkbox>` | Two crescents swing round the box, crystals fly, the tick draws itself, ズザッ in dotted letters. |
| [Radio](radio/) | `<sakuga-radio>` | The dot springs in, a fan of wedges, two puffs and a hollow ポン. |
| [Input](input/) | `<sakuga-input>` | Every key kicks up dust where the caret is. |
| [Tabs](tabs/) | `<sakuga-tabs>` | The raised tab slides, stretching, and lands with wedges and a puff. |
| [Progress](progress/) | `<sakuga-progress>` | A storm cloud rides the leading edge, pebbles lift off the ground, ゴゴゴゴ; at the end a burst, ドン! and a check. |
| [Rating](rating/) | `<sakuga-rating>` | Stars pop in one after another; five gets a burst. |
| [Toast](toast/) | `<sakuga-toast>` | Streaks in as a smear, lands in dust with ズザッ, leaves by shrinking. |
| [Tooltip](tooltip/) | `<sakuga-tooltip>` | The hint springs out like a speech bubble with puffs and カチッ. |

## The look

White paper, two-tone effects (white, lavender and a violet line), pink accents, and an impact burst on every confirm. The controls' colours are `--sk-*` CSS variables (`--sk-ink`, `--sk-card`, `--sk-pri`, `--sk-acc` and so on), and a page's own `:root { --sk-acc: ... }` wins over the defaults.

## Try them

Live: https://sakuga-vfx.vercel.app

Or run it yourself:

```sh
python3 -m http.server 8000     # from this folder
# open http://localhost:8000/
```

That opens the gallery, with all twelve live.

## Use one

Each is a single file that defines an element. Install it with the shadcn CLI, which puts the file in `public/sakuga-vfx/`:

```sh
npx shadcn add finktheartist/sakuga-vfx/button
npx shadcn add finktheartist/sakuga-vfx/toggle
npx shadcn add finktheartist/sakuga-vfx/slider
# ...checkbox, radio, input, tabs, progress, rating, toast, tooltip
```

Or copy the file into your project by hand. Then load it with a plain script tag and use its element:

```html
<script src="button.js"></script>
<sakuga-button>Confirm</sakuga-button>

<script src="toggle.js"></script>
<sakuga-toggle label="Notifications"></sakuga-toggle>

<script src="progress.js"></script>
<sakuga-progress label="Uploading"></sakuga-progress>   <!-- then el.set(0.4) -->
```

Each folder's README lists the attributes, properties and events. The value controls (toggle, slider, checkbox, radio, input, rating) work inside a `<form>` like the native ones.

**How the files share.** Each file carries its own copy of the core (springs, the effects layer, the lettering, about 40 KB). The first one loaded sets `window.SakugaFX` and the others reuse it, so any mix of them on a page shares one canvas and one animation loop. The toggle is about 500 KB because its frames are inside it.

For agents, [llms.txt](llms.txt) lists every file and what it is. In the gallery each control has its install line and a "Copy a prompt for your agent" button; the prompt points a coding agent at the real file and tells it to wire it in, not redraw it.

## Make your own

`skills/sakuga-vfx/` is the workflow these were made by, written as a skill for a coding agent. Install it with:

```sh
npx skills add finktheartist/sakuga-vfx
```

Or copy the folder into your agent's skills folder by hand (for Claude Code, `~/.claude/skills/`). It has four files:

- `SKILL.md` is the workflow and the rules.
- `core.js` is the core every component is built on.
- `starter.html` is the smallest whole example, a like button.
- `look.mjs` stops the clock, steps a reaction to chosen moments and saves the frames side by side.

An agent with the skill gets a reasonable first pass. These took many rounds of looking at frames and fixing them, and yours will too.

## Working on this repo

- `core.js` is the source of the shared core. After editing it, run `node tools/build.mjs`, which copies it into every component file (between the `// >>> sakuga core` markers) and into the skill. `node tools/build.mjs --check` exits 1 if any file is out of date.
- `art/words/` holds the six painted sound-effect words. `tools/trace.py` traces them into paths and writes them into `core.js` (`uv run --with potracer --with pillow --with numpy python tools/trace.py`).
- `toggle/frames.webp` is the toggle's sprite sheet (43 frames, 8 across, 300 by 325 each). The build writes it into `toggle.js`.
- `node tools/test.mjs http://localhost:8000/gallery/` drives every control with real touch and key events at phone width, checks form values and sideways scroll, and exits 1 on a failure. `node tools/shot.mjs URL OUT W H SCALE` takes a full-page screenshot. Both need Chrome or Chromium (`CHROME=...` if it is somewhere unusual).

## Limits

- **Checked in headless Chromium,** with real touch and key events and frame-by-frame sheets. Not yet tried in Safari or Firefox, on a real phone, or with a screen reader.
- **The effects canvas sits on top of everything,** at the highest z-index, and ignores the pointer. Effects can fly over a modal or a sticky header.
- **Effects behind a control are drawn inside it** (the button's and the progress bar's bursts, the five-star burst) and are cut off by a parent with `overflow: hidden`.
- **Reduced motion** turns every effect off; the springs and the state changes stay.

## License

MIT. See [LICENSE](LICENSE). The sound-effect lettering and the toggle frames were generated with GPT Image (through Higgsfield) for this project.

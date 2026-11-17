# Toggle

A switch whose flip is a drawn animation, not a simulation. Turn it on and the knob smears across the track with a torn tail, slams into the end and throws up a splash crown, and the track floods, sloshes and settles with a glint. Turn it off and the dash plays back.

The 43 frames were painted with GPT Image (through Higgsfield) from a sheet of twelve keyframes, in three parts of 16 frames, aligned on the housing and played at 30 a second. They are inside `toggle.js` as one sprite sheet, so there is still only one file.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/toggle/
```

## Use it

```html
<script src="toggle.js"></script>
<sakuga-toggle label="Notifications"></sakuga-toggle>
<sakuga-toggle label="Dark mode" checked name="dark"></sakuga-toggle>
```

```js
el.addEventListener('change', () => console.log(el.checked));
el.checked = true;    // from code: jumps to the end, no animation
el.flip();            // from code, with the animation
```

| attribute | what it sets | default |
|---|---|---|
| `label` | what a screen reader calls it | Toggle |
| `checked` | on | off |
| `name`, `value` | sent with its form when on, like a checkbox | value `on` |
| `disabled` | can't be flipped | off |

- **It is a `role="switch"` button** inside a shadow root, so Space and Enter flip it and `aria-checked` follows.
- **It takes more room than it looks.** The switch is 108 by 54 pixels, but the drawing is 150 by 162 and the splash rises above it, so the element has a margin of 89 pixels above, 20 below and 21 at the sides. Override `margin` if you know your layout has the room.
- **Only a person flipping it plays the drawing.** Setting `checked` from code goes straight to the end.

## The frames

`toggle/frames.webp` is the sheet (8 across, 300 by 325 pixels each, 346 KB). `node tools/build.mjs` writes it into `toggle.js`. The originals were 480 by 520; they were halved here, which is still twice the size they are shown at.

## Limits

- **It is about 500 KB,** most of it the frames. The other components are about 45 KB.
- **The art is painted,** so the `--sk-*` colours do not reach it.
- **Reduced motion** skips to the last frame.

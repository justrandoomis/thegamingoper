# Button

A button that reacts like an anime impact frame. Press it and it squashes flat, with wedges above it. Let go and it inverts for one frame and tilts, a spiky burst goes off behind it with crystals and four clouds, and ドン! lands above it. Then it springs tall and three smoke rings drift off. When the action has worked, `el.done()` lands a check on it with a glint.

The secondary variant is quieter: a small squash and three wedges at the corner.

One of eleven files in this repo. Same idea in each (an ordinary control, anime reactions), different control.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/button/
```

`?embed=1` hides the heading.

## Use it

`button.js` is the whole component: one file, no dependencies.

```html
<script src="button.js"></script>
<sakuga-button>Confirm</sakuga-button>
<sakuga-button variant="secondary">Cancel</sakuga-button>
```

```js
const el = document.querySelector('sakuga-button');
el.addEventListener('click', async () => {
  await save();
  el.done();          // a check lands on it, with a glint, and goes after 1.8 seconds
});
el.done(0);           // ...or stays until the next click
el.impact();          // play the click reaction without a click
el.disabled = true;
```

| attribute | what it sets | default |
|---|---|---|
| `variant` | `secondary` for the quiet one | primary |
| `type` | `submit` submits the form it is in | button |
| `disabled` | like a button's | off |

- **The text inside is the label.** It is a real `<button>` in the shadow root, so it takes focus, Space and Enter, and its click reaches your listener.
- **`done()` is yours to call.** The click plays the impact whatever happens next; the check is the part that says it worked, so call it only when it did.
- **Styling:** `sakuga-button::part(button)` reaches the button.

## What happens

| you | it |
|---|---|
| press | squashes to half height and a quarter wider; three wedges above, wobble marks either side, a short line under it |
| let go | an impact frame: ink background for 0.19 s, a 5° tilt, a pop to 124%. A 98-pixel burst goes off behind it, eleven crystals fly, four clouds roll off the corners, ドン! lands above |
| 0.2 s later | it springs tall, wobble marks either side, three smoke rings of falling size drift up and right, chips drop off the bottom |
| `done()` | a pink check grows on the end of the label, with a glint and two wedges at the corner |

## Limits

- **The burst behind it can be clipped.** It is drawn on a canvas inside the element that reaches 160 pixels past each edge; a parent with `overflow: hidden` cuts it off. Everything else is on the page-wide canvas and is not clipped.
- **One label size.** The padding and the type are fixed; it does not have small or large sizes.
- **Checked in headless Chromium** with real touch and key events. Not tried in Safari or Firefox, or with a screen reader.

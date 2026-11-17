# Tooltip

A help button whose hint springs out of it like a speech bubble, with puffs either side, a ring off the top of the button, wedges at the corner and a hollow カチッ.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/tooltip/
```

## Use it

```html
<script src="tooltip.js"></script>
<sakuga-tooltip text="We only use this to send your receipt." label="Why we ask"></sakuga-tooltip>
<sakuga-tooltip text="Keyboard shortcuts">i</sakuga-tooltip>
```

```js
el.show(); el.hide(); el.open;
```

| attribute | what it sets | default |
|---|---|---|
| `text` | the hint | Helpful hint! |
| `label` | what a screen reader calls the button | Help |

- **It opens on hover (with a mouse), on focus and on tap,** and Escape closes it. The hint is linked to the button with `aria-describedby`.
- **Whatever is inside the element replaces the "?"** on the button.
- **The hint is up to 220 pixels wide** and wraps. It opens above the button; the element keeps 60 pixels above it for that.

## Limits

- **Always above.** It does not flip when there is no room.
- **It can't point at something else.** The button is the trigger.

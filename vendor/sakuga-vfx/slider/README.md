# Slider

A range slider with a cloud behind the thumb. The value rides in a bubble that leans with the drag. The thumb stretches into a teardrop and lags behind your finger on a spring. Drag fast and a bank of cumulus rolls up behind it with speed lines and chips, and シュッ. Let go while it is still moving and a crescent flies on ahead, with a small burst, and two puffs are left where it came from.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/slider/
```

## Use it

```html
<script src="slider.js"></script>
<sakuga-slider value="30" label="Volume"></sakuga-slider>
<sakuga-slider min="0" max="10" step="0.5" value="4" unit="" label="Spice" name="spice"></sakuga-slider>
```

```js
el.addEventListener('input', () => console.log(el.value));    // while it moves
el.addEventListener('change', () => console.log(el.value));   // when it is let go
el.value = 80;
```

| attribute | what it sets | default |
|---|---|---|
| `value`, `min`, `max`, `step` | like `<input type="range">` | 50, 0, 100, 1 |
| `label` | what a screen reader calls it | Slider |
| `unit` | shown after the number in the bubble | `%` |
| `name` | sent with its form | none |
| `disabled` | can't be moved | off |

- **Underneath is a real range input,** stretched over the track and transparent, so the keyboard, touch and screen readers get the native control. `value` is a string, like an input's; `valueAsNumber` is the number.
- **Size:** 230 pixels wide; set `--sk-slider-width` to change it. It keeps 30 pixels above for the bubble.

## Limits

- **The effects need speed.** A slow drag only moves the thumb; the cloud starts above about a third of the track per second.
- **Horizontal only.**

# Checkbox

Tick it and two crescents swing round the box, crystals fly, the tick draws itself, a glint follows and ズザッ lands in dotted letters. Untick it and it goes out in a small puff.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/checkbox/
```

## Use it

```html
<script src="checkbox.js"></script>
<sakuga-checkbox name="remember">Remember me</sakuga-checkbox>
```

```js
el.addEventListener('change', () => console.log(el.checked));
el.checked = true;    // from code: no effects
```

| attribute | what it sets | default |
|---|---|---|
| `checked` | ticked at the start | off |
| `name`, `value` | sent with its form when ticked | value `on` |
| `disabled` | can't be changed | off |

- **The text inside is the label,** and clicking it ticks the box. Underneath is a real checkbox.
- **Parts:** `::part(label)` and `::part(box)`.

## Limits

- No indeterminate state.

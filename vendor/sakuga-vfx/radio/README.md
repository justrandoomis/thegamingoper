# Radio

A radio group. The picked dot springs in, a fan of wedges goes off it, two puffs drift away, and a hollow ポン pops up beside it.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/radio/
```

## Use it

List the choices as `<option>`s inside it:

```html
<script src="radio.js"></script>
<sakuga-radio label="Plan" name="plan">
  <option value="free" selected>Free</option>
  <option value="pro">Pro</option>
</sakuga-radio>
```

```js
el.addEventListener('change', () => console.log(el.value));
el.value = 'pro';     // from code: no effects
```

| attribute | what it sets | default |
|---|---|---|
| `label` | what a screen reader calls the group | Options |
| `value` | which one is picked (overrides `selected` on the options) | the `selected` option |
| `name` | sent with its form | none |
| `disabled` | can't be changed | off |

- **The options are read once,** when it first appears. Changing them afterwards does nothing; replace the element instead.
- **Underneath are real radio inputs,** so the arrow keys move between them.

## Limits

- One column only.

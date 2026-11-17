# Input

A text field that kicks up dust. Focus it and three wedges fly off the corner. Every key throws a puff of dust, and now and then a chip, from where the caret is, and the box gives a little.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/input/
```

## Use it

```html
<script src="input.js"></script>
<sakuga-input label="Email" type="email" placeholder="you@example.com" name="email"></sakuga-input>
```

```js
el.addEventListener('input', () => console.log(el.value));
el.value = 'hello';
```

| attribute | what it sets | default |
|---|---|---|
| `label` | what a screen reader calls it | Text |
| `placeholder`, `value` | like an input's | empty |
| `type` | text, email, search, url, tel or password | text |
| `autocomplete` | like an input's | off |
| `name` | sent with its form | none |
| `disabled` | can't be typed in | off |

- **Size:** 230 pixels wide; set `--sk-input-width` to change it. `::part(input)` reaches the input.
- In a password field the dust still follows the caret, measured over dots.

## Limits

- **No validation styles.** `required`, `pattern` and the like are not passed through, and there is no invalid look.
- One line only; there is no textarea.

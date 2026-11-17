# Rating

Five stars that pop in one after another. The last one lit gets a fan of wedges, a glint and a hollow ポン; five stars gets a burst behind it as well.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/rating/
```

## Use it

```html
<script src="rating.js"></script>
<sakuga-rating label="Rate this recipe" name="stars"></sakuga-rating>
```

```js
el.addEventListener('change', () => console.log(el.value));   // 0 to 5
el.value = 3;   // from code: no effects
```

| attribute | what it sets | default |
|---|---|---|
| `label` | what a screen reader calls the group | Rating |
| `value` | 0 to 5 | 0 |
| `name` | sent with its form (nothing when 0) | none |
| `disabled` | can't be changed | off |

- **Clicking the lit star again clears it** to 0.
- **It is a radio group of five buttons,** and the arrow keys move the score.

## Limits

- Always five stars. No half stars.

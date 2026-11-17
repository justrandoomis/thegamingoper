# Progress

A loading bar with a storm cloud riding the leading edge. The cloud grows as the bar fills and its top drags back when the load surges; wisps tear off it and speed lines trail it. A ground line draws itself out under the bar, and pebbles lift off it as the edge passes over them. ゴゴゴゴ rumbles once it is under way. At the end a burst goes off behind the bar with ドン!, a check lands above it, and two small clouds are left on the ground.

## Run it

```sh
python3 -m http.server 8000     # from the repo folder
# open http://localhost:8000/progress/
```

The page plays a pretend load. Drag the slider under it to drive it yourself.

## Use it

```html
<script src="progress.js"></script>
<sakuga-progress label="Uploading photos"></sakuga-progress>
```

```js
upload.onprogress = (e) => el.set(e.loaded / e.total);
el.addEventListener('sakuga:done', () => showResult());
el.set(0.5, true);   // straight there, no easing
el.reset();          // back to 0 for the next task
el.value; el.done;
```

| attribute | what it sets | default |
|---|---|---|
| `label` | what a screen reader calls it | Loading |
| `value` | progress from 0 to 1 | 0 |
| `done-label` | the words at the end | Complete ✓ |
| `demo` | plays a pretend load on a loop; click restarts it | off |

- **One number drives it.** The bar eases toward what you give it (at least 12% a second, at most 90%), so a jump still gets ridden by the cloud. The cloud's speed and drag come from how fast the bar is actually moving, so a stalled upload sits still.
- **`sakuga:done` fires once,** when the bar itself reaches the end, a moment after you `set(1)`. Going backwards (a lower number) clears it.
- **Size:** 280 pixels wide (`--sk-progress-width`). It keeps 70 pixels above the bar for the cloud and about 110 below for the ground and the number.
- **Off screen it stops drawing.** The bar still fills.
- **Don't ship `demo`.**

## Limits

- **No indeterminate look.** Without numbers it sits at 0.
- **No failed look.** If the task fails, show that next to it and `reset()`.

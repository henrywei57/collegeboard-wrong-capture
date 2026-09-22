# College Board — Wrong Answer Capture

A Chrome extension (Manifest V3) for reviewing a graded multiple-choice test on
College Board. It walks the review one question at a time, checks whether the
question was marked incorrect, screenshots the ones that were, and drops every
image into a single folder inside your Downloads.

## How "incorrect" is detected

It looks for College Board's score badge inside the question container:

```html
<span class="performance_icon">
  <i class="x-mark-big" aria-hidden="true"></i>
  <span data-test-performance-icon-score="true" class="label">0/1</span>
  <span class="label"> MC point</span>
  <span class="sr-only">Incorrect answer</span>
</span>
```

Three checks, in order — the first one that matches wins:

1. the `.sr-only` text says **Incorrect** (this is the most reliable signal),
2. the icon contains `.x-mark-big` (or any `x-mark`-ish class),
3. the score reads `0/1` — more generally, earned `<` possible.

Badges inside a sidebar or question navigator are ignored, so the list of icons
for *other* questions can't trigger a false capture.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder you cloned this into — the one
   containing `manifest.json`, not a folder inside it.
4. Pin the extension so the toolbar button is easy to reach.

## Use

1. Open your graded MCQ test on College Board and go to **question 1** of the
   review.
2. Click the extension button.
3. Optional: press **Test page** first. It reports which container it found,
   the verdict for the current question, and whether it can see a Next button —
   a quick way to confirm the selectors work before running the whole test.
4. Press **Start**, then leave the tab alone.

Images land in:

```
Downloads/collegeboard-wrong/<run timestamp>/q007-incorrect.png
```

One folder per run, one PNG per wrong question, numbered by the question number
shown on the page (falling back to walk order if the page doesn't show one).

### Settings

| Setting | What it does |
| --- | --- |
| Download folder | Parent folder inside Downloads. Each run gets a timestamped subfolder. |
| Navigation | `Auto-detect` picks a Next button if there is one, otherwise clicks through the question list. Force either with `next` / `nav`. |
| Image | PNG (lossless) or JPEG (much smaller files). |
| Page wait | Pause after moving to a new question, so it can render before the screenshot. Raise it on a slow connection. |
| Max questions | Safety stop. |
| Screenshot area | `Whole page`, or `Just one element` to crop every screenshot to one part of the question. See below. |
| Full-page screenshot | Scrolls the question and stitches the slices into one tall image, so long passages aren't cut off. Uncheck for a single viewport shot. (Hidden when capturing a single element, which handles its own scrolling.) |
| Capture every question | Saves correct answers too, suffixed `-correct`. |
| Advanced selectors | Override the question container and Next button if College Board's markup differs from what the built-in list expects. |

## Capturing one element instead of the page

If you only want the question itself — no site header, no navigator, no
whitespace — set **Screenshot area** to *Just one element*, then:

1. Click **Pick…**. The popup closes and the page enters picking mode.
2. Move the mouse: the element under the cursor is outlined, with its size and
   a preview of its selector.
3. Click the part you want. Press **Esc** to cancel.
4. Reopen the extension — the selector is filled in. **Test page** reports the
   pixel size it would capture.

The same selector is reused for every question, so pick something structural
(the question panel) rather than a one-off. The generated selector prefers
`data-test` attributes and stable class names, and skips framework-generated
ones like `css-1a2b3c` that change between page loads. You can always edit it by
hand, or type one in directly without using the picker.

An element taller than the window is captured in bands and stacked, so nothing
is cut off. If the selector doesn't match on some question, that one falls back
to a full-page screenshot and the log says so.

## Things worth knowing

- **Keep the tab active and the window in front.** Chrome's screenshot API can
  only capture the visible tab; switching tabs mid-run makes captures fail.
- Screenshots are rate-limited by Chrome to roughly two per second, so a
  full-page capture of a long question takes a few seconds. That's the "Page
  wait" and internal gap timing, not a hang.
- Sticky headers and footers are hidden during a stitched capture so they don't
  repeat in every slice. They're restored afterwards.
- Chrome won't ask where to save each file, but it may create the folder on the
  first download of a run.
- **"Either the '&lt;all_urls&gt;' or 'activeTab' permission is required"** — Chrome's
  screenshot API refuses a site-specific host permission. The extension now
  declares `activeTab`, which Chrome grants when you open the popup, so press
  Start from the popup rather than expecting a run to continue after a full page
  reload. If the review does a real navigation mid-run and the grant lapses, use
  **Grant always** at the bottom of the popup — that requests the optional
  all-sites permission, which doesn't expire.
- If nothing gets captured, run **Test page**: verdict `none` means it didn't
  find a score badge inside the container it chose — set a **Question container
  selector** in Advanced (right-click the question area → Inspect to find a
  stable class or `data-test` attribute).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — permissions limited to `*.collegeboard.org`. |
| `content.js` | Walks the questions, reads the verdict, drives the scroll-and-capture loop. |
| `background.js` | Service worker: `captureVisibleTab`, stitches slices on an `OffscreenCanvas`, hands the result to `chrome.downloads`. |
| `popup.html` / `popup.js` | Settings, start/stop, live log. |

Nothing is sent anywhere — captures go straight to your own Downloads folder.

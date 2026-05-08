InkMark — spec
A single-file HTML markdown editor where you write markdown and ink directly on top of the rendered document. No split pane. The document is the canvas. Ink strokes anchor to the most recent heading so they ride along when content reflows. Strokes are compressed via velocity-adaptive sampling and stored as `point + vector` pairs in a fenced JSON block within the markdown source itself.
Goal: a working prototype, single `inkmark.html`, no build step. Aim for ~600 lines of clean code.
The mental model
There is one document view. It has two modes:

* Write mode — a textarea styled with the document typography. Source is editable. Ink layer is hidden.
* Ink mode — the rendered markdown is locked. A transparent SVG overlay covers the entire document and captures pointer input. Drawing produces strokes that get anchored to whichever heading is closest above the stroke's centroid.
A floating toolbar toggles between modes. There is no separate "preview" pane. What you see IS the document. What you save IS what you saw.
Stack

* Single `inkmark.html`, no build, no bundler
* `marked` from cdnjs for markdown parsing
* `perfect-freehand` from a CDN for stroke rendering — load it as global, ESM module, or vendor inline; whichever works
* Vanilla JS
Visual design
Use the Anthropic-style design language:

* Light mode — cream canvas (`#faf9f5`), warm dark ink text (`#141413`), coral accent (`#cc785c`) for active toolbar state, hairline borders (`#e6dfd8`)
* Dark mode — warm dark canvas (`#181715`), cream text (`#faf9f5`), same coral accent, dark elevated surfaces (`#252320`) for the toolbar
* Display type: a serif (Cormorant Garamond, EB Garamond, or whatever loads cleanly from Google Fonts) at weight 400 with negative letter-spacing for headings. Sans body (system stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`). JetBrains Mono for code.
* Section spacing 96px between major heading regions, generous body line-height (1.7). The document should read like a literary page, not a SaaS dashboard.
* Ink color matches the active text color (warm dark on cream, cream on warm dark). Coral is reserved for UI chrome only — active mode button, focus rings, save indicator.
A theme toggle in the toolbar. Default to system preference via `prefers-color-scheme`.
Layout
A single centered column, max-width ~720px, generous horizontal padding. The document scrolls vertically. A floating toolbar (bottom-center) carries:

* Mode toggle: Write / Ink
* Theme toggle: Light / Dark
* Save (.md)
* Load (.md)
* Per-mode contextual tools: in Ink mode, an Undo button and a stroke counter; in Write mode, an "Insert section" button that adds a `## `line at the cursor
The toolbar is `position: fixed`, never pushes the document down. Subtle hairline border, no shadow.
Editing model
Write mode shows a textarea styled with the document's typography (serif headings won't render in a textarea — accept this; the body styling is enough). Source-of-truth is always the textarea content. Ink mode swaps the textarea out for rendered HTML + SVG overlay.
Both views must be the same width and use the same body fonts so toggling doesn't reflow the eye. Test the transition specifically.
The ink anchoring system
Each stroke is anchored to the most recent heading (h1 or h2) that appears above the stroke's vertical centroid in the rendered document at the time the stroke is completed.
Heading IDs
When markdown is rendered, every `h1` and `h2` gets a stable ID derived from a hash of the heading text, e.g. `## Implementation notes` → `h-implementation-notes-a3f2`. The hash suffix disambiguates duplicate heading text. These IDs are written into the rendered HTML as `id` attributes and referenced in the ink block via the stroke's anchor field.
Anchor data
A stroke's anchor consists of:

* `heading` — the text of the heading (for human-readable matching and fallback)
* `id` — the stable ID hash
* `offsetY` — pixel offset from the heading's top edge to the stroke's reference point at draw time
When the document re-renders (after edits, theme change, viewport resize), each stroke is re-positioned by:

1. Finding the element with `id === anchor.id`
2. If found: positioning the stroke at `headingTop + offsetY`
3. If not found: fall back to fuzzy matching on heading text
4. If still not found: stroke goes to an "orphaned strokes" tray (a small UI affordance — show a count, let the user view and either re-anchor manually or delete)
Coordinate normalization
Stroke X coordinates: store as fraction of the document column width (0-1). The column is fixed max-width, so fractions translate cleanly across viewport changes.
Stroke Y coordinates: store as pixels offset from the anchor heading's top edge, NOT normalized. Reasoning: section heights vary wildly with content edits — a section that was 200px tall yesterday could be 800px today. Normalized Y would drift unpredictably. Pixel offsets stay correct as long as the content above the stroke doesn't change. When content above DOES change, the stroke moves with the heading, which is the desired behavior.
Strokes attach to "this heading, X pixels down, Y fraction across" — exactly the intuition of "I drew this near the top of the Implementation section."
Stroke compression
Raw pointer events fire at 60-240Hz. Storing every point bloats the markdown file fast. Compress in three steps.
Step 1: Velocity-based decimation during capture
Skip time-based filtering — it samples a slow careful curve at the same rate as a fast straight line, when you want the opposite. Sample based on how much the stroke has changed since the last recorded point.
For each new pointer event:

1. Compute distance from the last recorded point: `d = hypot(x - lastX, y - lastY)`
2. Compute the angle change from the previous segment: `Δθ = angle(current_segment) - angle(previous_segment)`, normalized to `[-π, π]`
3. Record the point if any of:
   * `d > 12px` (the hand has moved far — sample to keep the line continuous)
   * `|Δθ| > 0.15 rad` (~8.5°, the hand is curving — sample to capture the bend)
   * `|Δp| > 0.1` (pressure has changed meaningfully — captures pressure variation during a pause)
   * It's the first or last point of the stroke
Always record the very first `pointerdown` and the very last point at `pointerup` regardless of thresholds.
This naturally produces:

* Fast straight strokes → very few points (angle stays constant, distance threshold rarely fires before stroke ends)
* Slow detailed curves → dense points (small motions still trigger the angle threshold every time direction changes)
* Hesitations / corners → guaranteed sample (large angle change at a corner)
Thresholds are tuning knobs. Start at `12px` / `0.15 rad` / `0.1 pressure`. If strokes look polygonal, lower the angle threshold to `0.1 rad`. If files are still too big, raise the distance threshold to `16px`.
Step 2: Adaptive simplification on stroke end (Ramer-Douglas-Peucker)
When the user finishes a stroke, run RDP simplification with `epsilon = 0.8px`. This removes points that lie close to the line between their neighbors. Curves keep density, straight segments collapse.
Velocity decimation and RDP are complementary: decimation throws out points that don't matter to the curve's shape during drawing; RDP throws out points that don't matter to the curve's final geometry.
Step 3: Convert to point + vector representation
After simplification, transform each point into `[x, y, vx, vy, p]`:

* `x, y` — point coordinates (anchor-relative)
* `vx, vy` — outgoing tangent vector to the next point (zero for the last point)
* `p` — pressure (0-1)
Why store vectors explicitly: at render time, you can use the tangent vectors for Catmull-Rom-style smoothing before handing to `perfect-freehand`, giving smoother curves at lower point density. Vectors are computed once at stroke-end, not per pointer event.
Storage format

```json
{
  "v": 1,
  "strokes": [
    {
      "anchor": {
        "heading": "Implementation notes",
        "id": "h-implementation-notes-a3f2",
        "offsetY": 124
      },
      "size": 3,
      "points": [
        [0.12, 8, 0.04, 0.6, 0.5],
        [0.16, 14, 0.05, 0.4, 0.7],
        [0.21, 18, 0, 0, 0.6]
      ]
    }
  ]
}

```

`x` is fraction of column width. `y` is pixels from anchor top. `vx, vy` are tangent components in matching units (column-fraction and pixels respectively). `v` is a format version for future migration.
A typical sketch should compress to 10-30% of raw point count. A 200-stroke document should be a few KB of JSON.
Source format
All strokes for a document live in one fenced ink block at the very end of the markdown source. The block carries all strokes; anchoring data inside the JSON tells each stroke where it belongs.

```markdown
# My notes

## Implementation notes

Some notes here.

## Open questions

More notes.

```ink
{"v":1,"strokes":[...]}
```

```

This is cleaner than scattering ink blocks inline:

* Strokes are anchored by heading, not by source position
* Editing prose doesn't need to step around inline ink blocks
* The ink block at the end is a natural "appendix" humans can ignore when reading source
The renderer parses the ink block, extracts strokes, overlays them on the rendered HTML using anchor data. If the user edits the source manually and breaks the JSON, show the ink layer empty with an error toast — don't crash.
Drawing flow
In Ink mode:

1. SVG overlay is `position: absolute` over the document content, full document height, `pointer-events: auto`. Textarea is hidden.
2. `pointerdown` on the SVG: start a new stroke. Capture the pointer.
3. `pointermove`: apply velocity-based decimation (Step 1). Append surviving points to the in-progress stroke. Render a live preview path on each `requestAnimationFrame`.
4. `pointerup`: finalize. Run RDP. Compute tangent vectors. Determine the anchor heading by walking back from the stroke centroid to the nearest preceding `h1` or `h2`. Store the stroke. Update the ink block in the source. Re-render the ink layer.
Pointer coordinate mapping: the SVG overlay covers the full scrollable document, so `e.offsetX` / `e.offsetY` work directly. Only convert to anchor-relative form when serializing.
Switching modes
Mode toggle is global state.
Ink → Write:

* Hide the SVG overlay
* Show the textarea
* Sync textarea scroll position to where the user was looking
Write → Ink:

* Re-parse the source
* Render markdown to HTML
* Re-position strokes against new heading positions
* Show the SVG overlay with all strokes drawn
If the user edits the source in Write mode and a stroke's anchor heading no longer exists, that stroke shows up in the orphaned tray on next switch to Ink mode.
Save / load

* Save: serialize textarea content (already contains the up-to-date ink block at the end) to a `.md` file via blob URL download
* Load: file picker accepting `.md`, read as text, replace textarea content, re-render
No autosave for v1. Show a small "unsaved changes" indicator (coral dot near Save) when the source has changed since last save or load.
Initial content
When the page loads with no file, populate the textarea with a brief demo:

```markdown
# InkMark

Markdown notes you can ink directly over. Headings anchor your strokes — when you edit prose, ink rides along.

## How it works

Switch to **Ink** mode in the toolbar. Draw on the page. Switch back to **Write** mode to edit the markdown.

## Try it

Draw something in this section. Then go to Write mode, add a paragraph above. Switch back. Your ink stays anchored here.

```ink
{"v":1,"strokes":[]}
```

```

Out of scope

* Multiple ink colors / brushes / sizes (single-color, single-size; color matches active text color)
* Eraser as a separate tool (Undo only)
* Pan/zoom of the document
* Inline images
* Math/LaTeX
* Syntax highlighting in code blocks (just monospace + background)
* Heading levels beyond h1 and h2 as anchor targets
* Multi-document tabs
* Autosave
* Undo across mode switches (per-mode undo stacks; switching modes commits)
* Mobile-specific gesture handling beyond what pointer events give for free
If you finish early: harden the orphaned-strokes tray, add keyboard shortcuts (cmd+S save, cmd+E toggle mode), improve iPad touch experience.
Definition of done

1. Open `inkmark.html`, see demo document in Write mode with serif headings on cream
2. Toggle to dark mode — colors invert, document still legible
3. Toggle to Ink mode — toolbar updates, document becomes non-editable, draw on it with mouse
4. Strokes appear with pressure-like variable width
5. Toggle back to Write mode, see the ink block at the bottom of the source has been updated with compressed stroke data — verify points are sparse (decimation + RDP working) and include vector components
6. Add a new paragraph at the top of the document in Write mode
7. Switch to Ink mode — your strokes are still in the right section, just pushed down by the new content
8. Delete a heading in Write mode that had strokes anchored to it
9. Switch to Ink mode — orphaned strokes counter appears, strokes are not visible
10. Save the file, reload the page, load the file — everything restores correctly including theme-appropriate ink color
11. Touchscreen drawing works; palm rejection isn't perfect but `pointerType` filtering keeps it usable
When done, the file should feel like one piece, not features stitched together. The aesthetic should evoke the Anthropic style document — warm cream, generous serif, restrained chrome.
Implementation notes for whoever builds this
Biggest risk: anchoring math during re-render. Read heading top positions AFTER fonts have loaded and layout has settled — `await document.fonts.ready` then a `requestAnimationFrame` before measuring. Otherwise stroke positions jitter on first paint.
Second biggest risk: the Write/Ink mode transition feeling janky. Both views must be the same width and use the same body fonts so switching doesn't reflow the eye. Test specifically.
Third risk: RDP simplification with too aggressive an epsilon flattens curves into polygons. Start at 0.5px and tune up only if file size is a problem. Visual quality first.
Pressure on non-pen devices: mouse and most touchscreens report `pressure: 0.5` or `0`. Use `simulatePressure: true` in `perfect-freehand` for these — it derives variable width from velocity. Detect via `e.pointerType === 'pen'` to disable simulation only when real pressure is available.
Taste calls Claude Code can decide:

* Toolbar position (bottom-center recommended; top-right also fine)
* SVG vs canvas for ink overlay (SVG simpler and DOM-inspectable; fine for prototype)
* Exact serif font choice (any of Cormorant Garamond, EB Garamond, Lora — pick one that loads cleanly)


design lang ## Overview

Claude.com is the warmest, most editorial interface in the AI-product category. The base atmosphere is a **tinted cream canvas** (`{colors.canvas}` — #faf9f5) — distinctly warm, deliberately not the cool gray-white that every other AI brand uses. Headlines run a **slab-serif display** ("Copernicus" / Tiempos Headline) at weight 400 with negative letter-spacing, paired with **StyreneB / Inter** body sans. The combination feels like a literary publication, not a SaaS marketing page.

Brand voltage comes from the **cream + coral pairing** — coral (`{colors.primary}` — #cc785c) is the signature Anthropic accent, used on every primary CTA, on the brand wordmark, and on full-bleed callout cards. The coral is warm, slightly muted, never cyan/blue — a deliberate counter-positioning against OpenAI's cool slate, Google's saturated blue, and Microsoft's corporate cyan.

The system has three surface modes that alternate page-by-page:
1. **Cream canvas** (`{colors.canvas}`) — default body floor
2. **Light cream cards** (`{colors.surface-card}`) — feature card backgrounds
3. **Dark navy product surfaces** (`{colors.surface-dark}`) — code editor mockups, model showcase cards, pre-footer CTAs, footer itself

The dark surfaces are where Claude shows its product chrome — code blocks, terminal output, model comparison tables, agentic-flow diagrams. The cream-to-dark contrast is the page's pacing rhythm.

**Key Characteristics:**
- Warm cream canvas (`{colors.canvas}` — #faf9f5) with dark warm-ink text (`{colors.ink}` — #141413). The brand's defining color choice.
- Coral primary CTA (`{colors.primary}` — #cc785c). Used scarcely on individual buttons, generously on full-bleed coral callout cards.
- Slab-serif display headlines via Copernicus / Tiempos Headline at weight 400 with negative letter-spacing. Pairs with humanist sans body for a literary editorial voice.
- Dark navy product mockup cards (`{colors.surface-dark}` — #181715) carrying code blocks, terminal panels, model comparison data — the brand shows the product chrome at scale rather than abstract marketing illustrations.
- Light cream feature cards (`{colors.surface-card}` — #efe9de) — slightly darker than canvas, used for content-driven feature explanations.
- Anthropic radial-spike mark — a small black asterisk-like glyph (4-spoke radial) — appears as the brand wordmark prefix and as a content marker.
- Border radius is hierarchical: `{rounded.md}` (8px) for buttons + inputs, `{rounded.lg}` (12px) for content + product cards, `{rounded.xl}` (16px) for the hero illustration container, `{rounded.pill}` for badges.
- Section rhythm `{spacing.section}` (96px) — modern-SaaS standard. Internal card padding stays generous at `{spacing.xl}` (32px).

## Colors

### Brand & Accent
- **Coral / Primary** (`{colors.primary}` — #cc785c): The signature Anthropic warm coral. Used on every primary CTA background, on full-bleed coral callout cards, on the brand wordmark accent. The most-recognized Anthropic color outside of the spike-mark logo.
- **Coral Active** (`{colors.primary-active}` — #a9583e): The press / hover-darker variant.
- **Coral Disabled** (`{colors.primary-disabled}` — #e6dfd8): A desaturated cream-tinted disabled state.
- **Accent Teal** (`{colors.accent-teal}` — #5db8a6): Used sparingly on secondary product surfaces (terminal status indicators, "active connection" dots in connectors page).
- **Accent Amber** (`{colors.accent-amber}` — #e8a55a): A small companion warm-tone used on category badges and inline highlights.

### Surface
- **Canvas** (`{colors.canvas}` — #faf9f5): The default page floor. Tinted cream — warm, deliberately not pure white.
- **Surface Soft** (`{colors.surface-soft}` — #f5f0e8): Section dividers, very-soft band backgrounds.
- **Surface Card** (`{colors.surface-card}` — #efe9de): Feature cards, content cards. One step darker than canvas.
- **Surface Cream Strong** (`{colors.surface-cream-strong}` — #e8e0d2): A strongest-cream variant used on selected category tabs and emphasized section bands.
- **Surface Dark** (`{colors.surface-dark}` — #181715): Code editor mockups, model showcase cards, footer. The dominant dark surface.
- **Surface Dark Elevated** (`{colors.surface-dark-elevated}` — #252320): Elevated cards inside dark bands (settings panels in mockups).
- **Surface Dark Soft** (`{colors.surface-dark-soft}` — #1f1e1b): Slightly lighter dark, used for code block backgrounds inside larger dark cards.
- **Hairline** (`{colors.hairline}` — #e6dfd8): The 1px border tone on cream surfaces. Same hex as `{colors.primary-disabled}` — borders feel like one elevation step rather than ink lines.
- **Hairline Soft** (`{colors.hairline-soft}` — #ebe6df): Barely-visible divider used inside the same band.

### Text
- **Ink** (`{colors.ink}` — #141413): All headlines and primary text. Warm dark, slightly off-pure-black.
- **Body Strong** (`{colors.body-strong}` — #252523): Emphasized paragraphs, lead text.
- **Body** (`{colors.body}` — #3d3d3a): Default running-text color.
- **Muted** (`{colors.muted}` — #6c6a64): Sub-headings, breadcrumbs, footer-adjacent secondary text.
- **Muted Soft** (`{colors.muted-soft}` — #8e8b82): Captions, fine-print, copyright lines.
- **On Primary** (`{colors.on-primary}` — #ffffff): Text on coral buttons.
- **On Dark** (`{colors.on-dark}` — #faf9f5): Cream-tinted white used on dark surfaces (echoes the canvas tone).
- **On Dark Soft** (`{colors.on-dark-soft}` — #a09d96): Footer body text, secondary labels in dark mockups.

### Semantic
- **Success** (`{colors.success}` — #5db872): Green status dots, "available" indicators.
- **Warning** (`{colors.warning}` — #d4a017): Warning callouts (rare on marketing surfaces).
- **Error** (`{colors.error}` — #c64545): Validation errors.

## Typography

### Font Family
The system runs **Copernicus** (or **Tiempos Headline** as substitute) as the slab-serif display face for headlines, and **StyreneB** (or **Inter** as substitute) as the humanist sans for body, navigation, and UI labels. **JetBrains Mono** handles code blocks. The fallback stack walks `Tiempos Headline, Garamond, "Times New Roman", serif` for display and `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` for body.

The display/body split is editorial:
- Copernicus serif (weight 400, negative tracking) → h1, h2, h3, hero display
- StyreneB sans (weight 400-500) → body, navigation, buttons, captions, labels
- JetBrains Mono → all code blocks and terminal text

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-xl}` | 64px | 400 | 1.05 | -1.5px | Homepage h1 ("Meet your thinking partner") — Copernicus serif |
| `{typography.display-lg}` | 48px | 400 | 1.1 | -1px | Section heads — Copernicus |
| `{typography.display-md}` | 36px | 400 | 1.15 | -0.5px | Sub-section heads, model names — Copernicus |
| `{typography.display-sm}` | 28px | 400 | 1.2 | -0.3px | Pricing tier names, callout headlines — Copernicus |
| `{typography.title-lg}` | 22px | 500 | 1.3 | 0 | Pricing plan size labels — StyreneB |
| `{typography.title-md}` | 18px | 500 | 1.4 | 0 | Feature card titles, intro paragraphs |
| `{typography.title-sm}` | 16px | 500 | 1.4 | 0 | Connector tile titles, list labels |
| `{typography.body-md}` | 16px | 400 | 1.55 | 0 | Default running-text — StyreneB |
| `{typography.body-sm}` | 14px | 400 | 1.55 | 0 | Footer body, fine-print |
| `{typography.caption}` | 13px | 500 | 1.4 | 0 | Badge labels, captions |
| `{typography.caption-uppercase}` | 12px | 500 | 1.4 | 1.5px | Category tags, "NEW" badges |
| `{typography.code}` | 14px | 400 | 1.6 | 0 | Code blocks — JetBrains Mono |
| `{typography.button}` | 14px | 500 | 1.0 | 0 | Standard button labels |
| `{typography.nav-link}` | 14px | 500 | 1.4 | 0 | Top-nav menu items |

### Principles
Display sizes use weight 400 (regular), never bold. Negative letter-spacing (-0.3 to -1.5px) is essential — Copernicus without it reads as off-brand. The serif character is what gives Anthropic its literary, considered voice; switching to a sans-serif display would make Claude feel like every other AI tool.

Body type stays at weight 400 for paragraphs, weight 500 for labels and emphasized phrases. The sans body is humanist (StyreneB) — never geometric. Inter is an acceptable substitute because of its similar humanist proportions; Helvetica or Arial would be too neutral and break the warm-editorial feel.

### Note on Font Substitutes
If Copernicus / Tiempos Headline is unavailable, **Cormorant Garamond** at weight 500 with -0.02em letter-spacing is the closest open-source approximation. **EB Garamond** is a fallback. For StyreneB, **Inter** is the closest match — both are humanist sans designed for screen reading. **Söhne** is another close alternative if licensed.

## Layout

### Spacing System
- **Base unit:** 4px.
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 96px.
- **Section padding:** `{spacing.section}` (96px) — modern-SaaS rhythm.
- **Card internal padding:** `{spacing.xl}` (32px) for feature cards, pricing tier cards, model comparison cards; `{spacing.lg}` (24px) for code-window cards and connector tiles.
- **Callout / CTA bands:** `{spacing.xxl}` (48px) inside coral callout cards; 64px inside the larger dark CTA band.

### Grid & Container
- **Max content width:** ~1200px centered.
- **Editorial body:** Single 12-column grid; hero often uses 6/6 split (h1 left, illustration right).
- **Feature card grids:** 3-up at desktop, 2-up at tablet, 1-up at mobile.
- **Connector tile grids:** 4-up or 6-up at desktop, 2-up at tablet, 1-up at mobile.
- **Pricing grid:** 3-up at desktop (Free / Pro / Team / Enterprise often), 1-up at mobile.

### Whitespace Philosophy
The cream canvas + serif display + generous internal padding create an editorial pacing — Claude reads like a long-form magazine column rather than a marketing template. Whitespace between bands stays uniform at 96px; whitespace inside cards is generous (32px), letting type breathe.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Body sections, top nav, hero bands |
| Soft hairline | 1px `{colors.hairline}` border | Inputs, sub-nav, occasionally on cards |
| Cream card | `{colors.surface-card}` background — no shadow | Feature cards, content cards |
| Dark surface card | `{colors.surface-dark}` background — no shadow | Code editor mockups, model showcase cards |
| Subtle drop shadow | Faint shadow at low alpha | Hover-elevated states (the system uses `0 1px 3px rgba(20,20,19,0.08)` rarely) |

The elevation philosophy is **color-block first, shadow rare**. Most depth comes from the cream-vs-dark surface contrast. Shadows are minimal. The dark surface mockups have their own internal product chrome (code editor scrollbars, line numbers, syntax highlighting) which adds detail without needing external shadows.

### Decorative Depth
- The Anthropic spike-mark glyph (4-spoke radial asterisk) appears as a small black mark in the brand wordmark and inline as a content marker.
- Code editor mockups carry their own internal depth: syntax-highlighted text in muted blues / oranges / grays, line numbers in `{colors.muted-soft}`, status bars at the bottom in `{colors.surface-dark-elevated}`.
- Some hero illustrations use simple line-art with coral and dark-navy strokes on cream — minimal, hand-drawn-feeling, never photorealistic.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 4px | Reserved for badge accents and tiny dropdowns |
| `{rounded.sm}` | 6px | Small inline buttons, dropdown items |
| `{rounded.md}` | 8px | Standard CTA buttons, text inputs, category tabs |
| `{rounded.lg}` | 12px | Content cards (feature, pricing, code-window, model-comparison) |
| `{rounded.xl}` | 16px | Hero illustration container, the larger marquee components |
| `{rounded.pill}` | 9999px | Badge pills, "NEW" tags |
| `{rounded.full}` | 9999px / 50% | Avatar substitutes, icon buttons |

### Photography & Illustrations
Claude's hero rarely uses photography. Instead it uses:
- Simple line-art illustrations with coral + dark-navy strokes on the cream canvas
- Code editor mockups (the dominant "hero" treatment on developer-focused pages)
- Terminal output mockups with monospace text on dark
- Model comparison cards (Opus / Sonnet / Haiku) with abstract geometric thumbnails

When photography is used (rare — mostly testimonials), avatars crop to perfect circles at 40px diameter.

## Components

### Top Navigation

**`top-nav`** — Cream nav bar pinned to the top of every page. 64px tall, `{colors.canvas}` background. Carries the Anthropic spike-mark + "Claude" wordmark at left, primary horizontal menu (Product, Solutions, Use Cases, Pricing, Research, Company) center-left, right-side cluster with "Sign in" text-link, "Try Claude" `{component.button-primary}` (coral). Menu items in `{typography.nav-link}` (StyreneB 14px / 500).

### Buttons

**`button-primary`** — The signature coral CTA. Background `{colors.primary}` (#cc785c), text `{colors.on-primary}` (white), type `{typography.button}` (StyreneB 14px / 500), padding 12px × 20px, height 40px, rounded `{rounded.md}` (8px). Active state `button-primary-active` darkens to `{colors.primary-active}` (#a9583e).

**`button-secondary`** — Cream button with hairline outline. Background `{colors.canvas}`, text `{colors.ink}`, 1px hairline border, same padding + height + radius as primary.

**`button-secondary-on-dark`** — Used over `{colors.surface-dark}` cards. Background `{colors.surface-dark-elevated}` (#252320), text `{colors.on-dark}`. Stays dark — the system never inverts to a light secondary on dark surfaces.

**`button-text-link`** — Inline text button, no background. Used for "Sign in" in the top nav and inline CTA links.

**`button-icon-circular`** — 36px circular icon button. Background `{colors.canvas}`, hairline border, ink-color icon. Used for carousel arrows, share, "view more".

**`text-link`** — Inline body links in `{colors.primary}` (the coral). Underlined on press; the coral inline link is one of the system's most distinctive small details.

### Cards & Containers

**`hero-band`** — Cream-canvas hero with a 6-6 grid: h1 + sub-headline + button row on the left, hero illustration card or product mockup card on the right. Vertical padding `{spacing.section}` (96px).

**`hero-illustration-card`** — A larger card holding the hero's right-side artifact — sometimes a coral-stroke line illustration on cream background, sometimes a dark code editor mockup. Background `{colors.canvas}` or `{colors.surface-dark}` depending on context, rounded `{rounded.xl}` (16px).

**`feature-card`** — Used in 3-up feature grids. Background `{colors.surface-card}` (#efe9de — slightly darker cream), rounded `{rounded.lg}` (12px), internal padding `{spacing.xl}` (32px). Carries a small icon at top, an `{typography.title-md}` headline, and a body description in `{typography.body-md}`.

**`product-mockup-card-dark`** — Dark navy card showing actual Claude product chrome (chat interface, code editor, agent controls). Background `{colors.surface-dark}`, rounded `{rounded.lg}`, internal padding `{spacing.xl}` (32px). Carries text labels in `{colors.on-dark}` and product UI fragments below.

**`code-window-card`** — A specialized dark card showing a code editor with line numbers, syntax-highlighted code in `{typography.code}` (JetBrains Mono), and sometimes a "Run" button or terminal output panel below. Background `{colors.surface-dark}` with `{colors.surface-dark-soft}` for the inner code block, rounded `{rounded.lg}`, padding `{spacing.lg}` (24px). The signature visual element of Claude Code product pages.

**`model-comparison-card`** — Used on the homepage's "Which problem are you up against?" section comparing Opus / Sonnet / Haiku. Background `{colors.canvas}` with hairline border, rounded `{rounded.lg}`, internal padding `{spacing.xl}` (32px). Carries the model name, a short capability blurb, and a `{component.text-link}` to learn more.

**`pricing-tier-card`** — Standard tier card. Background `{colors.canvas}` with hairline border, rounded `{rounded.lg}`, padding `{spacing.xl}` (32px). Carries the plan name in `{typography.title-lg}` (StyreneB), price in `{typography.display-sm}` (Copernicus serif!), feature checklist in `{typography.body-md}`, and a `{component.button-primary}` at the bottom.

**`pricing-tier-card-featured`** — The featured tier (typically "Pro" or "Team"). Background flips to `{colors.surface-dark}`, text inverts to `{colors.on-dark}`. The dark surface IS the featured-tier signal.

**`callout-card-coral`** — A full-bleed coral card carrying a major call-to-action. Background `{colors.primary}` (#cc785c), text `{colors.on-primary}` (white), rounded `{rounded.lg}`, padding `{spacing.xxl}` (48px). The coral surface IS the voltage; the CTA inside uses an inverted button style (cream/canvas button on coral).

**`connector-tile`** — Used on the connectors page's integration grid. Background `{colors.canvas}` with hairline border, rounded `{rounded.lg}`, padding 20px. Each tile carries a logo at top, a `{typography.title-sm}` connector name, and a short description.

### Inputs & Forms

**`text-input`** — Standard text input. Background `{colors.canvas}`, text `{colors.ink}`, type `{typography.body-md}`, rounded `{rounded.md}` (8px), padding 10px × 14px, height 40px. 1px hairline border in `{colors.hairline}`.

**`text-input-focused`** — Focus state. Border thickens or shifts to `{colors.primary}` (coral) for emphasis. Carries a 3px coral-at-15%-alpha outer ring.

**`cookie-consent-card`** — Bottom-right floating dark cookie banner. Background `{colors.surface-dark}`, text `{colors.on-dark}`, rounded `{rounded.lg}`, padding `{spacing.lg}` (24px). One of the few places dark surface appears at small scale on cream pages.

### Tags / Badges

**`badge-pill`** — Small pill label used for category tags. Background `{colors.surface-card}`, text `{colors.ink}`, type `{typography.caption}` (13px / 500), rounded `{rounded.pill}`, padding 4px × 12px.

**`badge-coral`** — Coral-fill badge for "NEW", "BETA", featured highlights. Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.caption-uppercase}` (12px / 500 / 1.5px tracking), rounded `{rounded.pill}`, padding 4px × 12px.

### Tab / Filter

**`category-tab`** + **`category-tab-active`** — Used in sub-nav rows on solutions / connectors pages. Inactive: transparent background, `{colors.muted}` text. Active: `{colors.surface-card}` background, `{colors.ink}` text. Padding 8px × 14px, rounded `{rounded.md}`.

### CTA / Footer

**`cta-band-coral`** — A pre-footer "Try Claude" CTA card. Full-width coral fill, white type, rounded `{rounded.lg}`, padding 64px. Carries an h2 in `{typography.display-sm}` (still serif!), a sub-line, and a cream-button CTA.

**`cta-band-dark`** — Alternative pre-footer band on developer-focused pages. Background `{colors.surface-dark}`, text `{colors.on-dark}`, rounded `{rounded.lg}`, padding 64px. Often pairs with a code-window card.

**`footer`** — Dark navy footer that closes every page. Background `{colors.surface-dark}` (#181715), text `{colors.on-dark-soft}`. 4-column link list at desktop covering Product / Company / Resources / Legal. Vertical padding 64px. The Anthropic spike-mark + "Anthropic" wordmark sits at the top in `{colors.on-dark}`. The footer never inverts.

## Do's and Don'ts

### Do
- Anchor every page on the cream canvas. Pure white reads as "any other AI tool"; the warm tint is the brand differentiator.
- Use Copernicus serif for every display headline. Pair with StyreneB sans body. Negative letter-spacing on display sizes is non-negotiable.
- Reserve `{colors.primary}` (coral) for primary CTAs and full-bleed `{component.callout-card-coral}` moments. Don't paint accent moments coral elsewhere.
- Use `{component.product-mockup-card-dark}` and `{component.code-window-card}` to show actual Claude product chrome. Don't paint marketing illustrations of code when you can show real code.
- Pair `{component.feature-card}` (cream) with `{component.product-mockup-card-dark}` (navy) in alternating bands. The cream-to-dark rhythm is the brand's pacing mechanism.
- Use the Anthropic spike-mark glyph as the brand wordmark prefix. Never invert the mark to white-on-dark within the wordmark itself.
- Apply `{spacing.section}` (96px) between major bands.

### Don't
- Don't use cool grays or pure white for canvas. Cream is the brand.
- Don't bold serif display weight. Copernicus at 700 reads as bombastic; the system stays at 400.
- Don't use cool blue or saturated cyan as a brand accent. The coral is the brand voltage.
- Don't put coral everywhere. The coral is scarce on individual elements and generous only on full-bleed coral callout cards.
- Don't use Inter for display headlines. The serif character is the brand voice.
- Don't repeat the same surface mode in two consecutive bands. The pacing alternates: cream → cream-card → dark-mockup → cream → coral-callout → dark-footer.
- Don't add hover state styling beyond what the system already encodes — primary darkens on press; nothing else changes.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 768px | Hamburger nav; hero h1 64→32px; hero-illustration-card stacks below content; feature grids 1-up; connector tiles 2-up; pricing 1-up; footer 4 cols → 1 |
| Tablet | 768–1024px | Top nav stays horizontal but tightens; feature cards 2-up; connector tiles 3-up; pricing 2-up |
| Desktop | 1024–1440px | Full top-nav with all menu items; 3-up feature cards; 4-up or 6-up connector tiles; 3-up pricing tiers |
| Wide | > 1440px | Same as desktop with more outer breathing room; max content width caps at 1200px |

### Touch Targets
- `{component.button-primary}` at minimum 40 × 40px.
- `{component.button-icon-circular}` at exactly 36 × 36 — slightly under WCAG 44 but visually centered.
- `{component.text-input}` height is 40px.
- Connector tile entire card area is tappable; effective tap area >> 44px.

### Collapsing Strategy
- Top nav collapses to hamburger at < 768px; menu opens as a full-screen cream sheet.
- Hero band's 6-6 grid collapses to single-column on mobile — h1 + sub-head + buttons first, then the illustration / mockup card below.
- Feature grids reduce columns rather than scaling cards down.
- Pricing tier cards collapse 4 → 2 → 1; featured-tier dark surface stays visually distinct at every breakpoint.
- Code-window cards retain code legibility at every breakpoint by allowing horizontal scroll within the card rather than wrapping code lines.

### Image Behavior
- Code blocks inside dark mockups stay at fixed font-size; horizontal scroll on mobile rather than wrapping.
- Hero illustrations scale proportionally; line-art strokes thin slightly on mobile.
- Avatar photos in testimonials crop to circles at every breakpoint.

## Iteration Guide

1. Focus on ONE component at a time. Reference its YAML key (`{component.feature-card}`, `{component.code-window-card}`).
2. Variants of an existing component (`-active`, `-disabled`, `-focused`) live as separate entries in `components:`.
3. Use `{token.refs}` everywhere — never inline hex.
4. Never document hover. Default and Active/Pressed states only.
5. Display headlines stay Copernicus serif 400 with negative tracking. Body stays StyreneB / Inter 400. The split is unbreakable.
6. Cream + coral + dark navy is the trinity. Don't introduce a fourth surface tone (no purple cards, no green sections).
7. When in doubt about emphasis: bigger Copernicus serif before bolder weight.

## Known Gaps

- Copernicus and StyreneB are licensed Anthropic typefaces and not available as public web fonts. Substitutes (Tiempos Headline / Cormorant Garamond / EB Garamond for serif; Inter / Söhne for sans) are documented in the typography section.
- The Anthropic radial-spike-mark is a brand glyph rendered as inline SVG; it's not formalized as a system token here. Treat it as a logo asset.
- Animation and transition timings (chat message reveal, code block typewriter effect on the homepage, agentic-flow diagram animations) are not in scope.
- Form validation states beyond `{component.text-input-focused}` are not extracted — error / success states would need a sign-up or feedback flow to confirm.
- The actual Claude product surface (claude.ai chat interface) shares some tokens with the marketing site but adds many product-specific components (chat bubbles, message tools, file upload chips, conversation history sidebar) that are out of scope for this marketing-surface document.
- The "agent" / "computer use" demo cards on certain pages display animated Claude controlling a browser — the static screenshot doesn't fully capture the animation chrome.

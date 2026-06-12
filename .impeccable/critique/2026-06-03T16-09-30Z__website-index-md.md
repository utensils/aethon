---
target: website/index.md
total_score: 35
p0_count: 0
p1_count: 0
timestamp: 2026-06-03T16-09-30Z
slug: website-index-md
---

# Re-critique: website/index.md (Aethon docs landing) — post-fix pass

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                               |
| --------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 3         | Version chip + "Early development" banner + lastUpdated; no interactive status on a landing.            |
| 2         | Match System / Real World       | 4         | Mythic framing + plain mechanism nouns land the thesis in the reader's terms.                           |
| 3         | User Control and Freedom        | 4         | n/a for static landing; nav/back/search standard.                                                       |
| 4         | Consistency and Standards       | 3         | Featured-card title was off-scale (fixed to Display 1.4rem); glyph icons inconsistent in weight.        |
| 5         | Error Prevention                | 4         | n/a — no forms.                                                                                         |
| 6         | Recognition Rather Than Recall  | 3         | "Get started" vs "Quick start" are near-synonyms; labels don't self-disambiguate.                       |
| 7         | Flexibility and Efficiency      | 3         | Two clear CTAs + search; no copy-paste install command on the page.                                     |
| 8         | Aesthetic and Minimalist Design | 3         | Clean and rationed now (gradient + glow gone, grid de-templated), but still the VitePress home chassis. |
| 9         | Error Recovery                  | 4         | n/a — no error states.                                                                                  |
| 10        | Help and Documentation          | 4         | This IS the docs entry; guide/reference/troubleshooting one click away.                                 |
| **Total** |                                 | **35/40** | **Good** — shippable; remaining items are quality/polish.                                               |

## Anti-Patterns Verdict

**Does it look AI-generated? No (borderline, residue remains).** The P0/P1 fixes did real work: the banned gradient hero text is gone (solid `--vp-c-brand-1`), the ambient glow blob is removed (Glow-Is-Earned), CTAs dropped to a disciplined two, and the featured-first-card breaks the dead four-identical-cards row. Residue: it is still recognizably the VitePress `home` chassis with an Ember/Paper coat, the alchemical glyph icons read as decorative emoji, and the single demonstration (the screenshot) sits below the fold on a product whose whole pitch is "show, don't tell."

**Deterministic scan:** `detect.mjs` over the markup returns 0 findings — a coverage gap, not a clean bill (the page's slop signals live in theme CSS / build-time layout, not source markup).

**Detector vs LLM, reconciled:** the design review raised an OG-image finding (`config.ts` `og:image` → `aethon-hero.svg` "missing"). **False positive** — `website/public/aethon-hero.svg` exists on disk. Corrected against file truth.

## Fixes applied this pass (post first critique)

- **[P0]** Gradient hero name → solid `--vp-c-brand-1`; ambient hero glow removed.
- **[P1]** Feature grid de-templated: first feature promoted to a full-width featured card (3-up row beneath). A first attempt used an inner `1.1fr 1fr` grid that left an empty right column (the card has one child); corrected to centered, measure-capped content at the Display type scale.
- **[P2]** Three co-equal CTAs → one brass primary + one alt (GitHub kept in top-nav).
- **[P3]** All em dashes removed.
- **[P3]** "Three palettes" → seven shipped themes; reconciled with `themes.css`. Stale "three-palette" comment in the theme CSS header also corrected.
- Screenshot shadow dialed from `--shadow-5` depth to settled `--shadow-3`.

## What's Working

- **Hero discipline:** solid brass name + no glow + two CTAs executes the Glow-Is-Earned / One-Flame stance correctly.
- **Featured-card IA:** promoting "Agent-rendered UI" encodes the product hierarchy structurally, not just typographically.
- **Voice and candor:** the Αἴθων etymology and the plain pre-1.0 banner hit "blazing, precise, mythic" and the honest-early brief.

## Priority Issues (remaining — all quality/polish; no P0/P1)

**[P2] "Show, don't tell" underserved.** The page asserts agent-rendered UI in prose; the only demonstration is one static screenshot below the fold. PRODUCT.md's success metric is "demonstrated rather than asserted." Fix: a live/looping A2UI render or a layout-as-payload snippet above the fold, or move the screenshot up. (A custom hero was de-scoped this pass.)

**[P2] CTA labels don't self-disambiguate.** "Get started" (→ installation) and "Quick start" (→ quick-start) are near-synonyms. Fix: concrete verbs, e.g. "Install" + "Quick start" or "Get started" + "5-minute tour."

**[P3] Alchemical glyph icons are decorative, not communicative.** 🜲🜔🜕🜖 carry no semantic mapping and render inconsistently across OS emoji fonts. Fix: brand-tinted line icons that depict each mechanism, or drop icons and let titles carry.

**[P3] Inline `style=` blocks hardcode geometry.** The prose/screenshot/banner divs hardcode spacing/radius rather than consuming tokens (they do read tokens for color). Minor token-discipline gap.

## Persona Red Flags

- **Jordan (first-timer):** "Get started" vs "Quick start" fork with no signpost; wants to _see_ the UI but reads prose before the one screenshot.
- **Riley (stress-tester):** featured-card layout now has no empty column; OG image resolves. Edge to watch: the 3-up sibling row at the 768px breakpoint is tighter than VitePress's native 2-up there.
- **Casey (mobile):** clean — below 768px everything falls back to VitePress's native single-column stack; no custom breakage. Screenshot detail is inherently small on a phone.
- **Terminal-native dev:** finds the mechanism nouns in the cards and respects the pre-1.0 candor, but there is still no copy-paste install command on the landing; the primary CTA clicks through to `/guide/installation`.

## Questions to Consider

1. The thesis is "the agent decides what you see," yet the page tells it in prose and shows it in one static frame below the fold. What stops a single live/looping A2UI render in the hero or featured card?
2. Strip the Ember/Paper palette and the myth paragraph: is CSS-promoting one card enough de-templating, or does the page need a genuinely custom hero/section component?
3. Should the primary CTA carry the literal install command for the terminal-native audience, rather than clicking through to the guide?

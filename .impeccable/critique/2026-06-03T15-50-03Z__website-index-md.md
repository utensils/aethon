---
target: website/index.md
total_score: 34
p0_count: 1
p1_count: 1
timestamp: 2026-06-03T15-50-03Z
slug: website-index-md
---
# Critique: website/index.md (Aethon docs landing)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Static page; `lastUpdated` + version dropdown give light status. No strong "you are here" beyond nav. |
| 2 | Match System / Real World | 4 | Mythology framing + plain mechanism nouns map to the audience's mental model well. |
| 3 | User Control and Freedom | 4 | n/a for static landing — nav, back, search all present; nothing traps the user. |
| 4 | Consistency and Standards | 3 | Em dashes throughout violate the project's own copy rule; "three palettes" undersell vs. seven shipped. |
| 5 | Error Prevention | 4 | n/a for static landing — no forms to mis-fill. |
| 6 | Recognition Rather Than Recall | 3 | Three action buttons compete with no visual ranking between the two alts. |
| 7 | Flexibility and Efficiency | 3 | Local search + version menu help experts; no copy-paste install command above the fold. |
| 8 | Aesthetic and Minimalist Design | 2 | Gradient text + 4 identical cards + glow blob = the template aesthetic the brief explicitly bans. |
| 9 | Error Recovery | 4 | n/a for static landing — no error states. |
| 10 | Help and Documentation | 4 | This *is* docs; clear paths to guide/reference, GitHub, troubleshooting. |
| **Total** | | **34/40** | **Good** (functional and credible, but visually template-bound) |

## Anti-Patterns Verdict

**Does this look AI-generated? Mild yes — a well-disguised case.**

**LLM assessment:** This is the generic VitePress `home` layout with brand tokens swapped in. The bones are the template: gradient-filled hero name, three stock action buttons, a four-up identical-card feature grid, blurred glow blob behind the hero image. The category-reflex test fails the wrong way — "dev tool docs landing" predicts exactly this composition. The brass-on-warm-black palette, the alchemical-symbol icons, and the mythology paragraph lift it above a fresh `vitepress init`, but a designer clocks the VitePress skeleton in under two seconds. The page's own DESIGN.md names "generic VitePress default" and "decorative gradients" as bans, and the hero violates both.

**Deterministic scan:** `detect.mjs` over `website/index.md` returned 0 findings (exit 0), no false positives. This is a coverage gap, not a clean bill: the page's actual rendered slop (gradient hero text, the 4-card grid) is produced by the theme CSS and VitePress's build-time `home` layout, neither of which a source-markup scan inspects. The LLM review caught what the deterministic scanner structurally cannot see for a VitePress frontmatter-driven page.

**Visual overlays:** Not run. No dev server was up and the target is markdown VitePress compiles at build time; no reliable user-visible overlay is available for this pass.

## Overall Impression

The token system is genuinely good and on-brand; the *composition* is template-default. The single biggest opportunity: the product's entire thesis is "the agent decides what you see" (layout-as-payload), yet the landing page is the most templated layout VitePress ships. The hero asserts the thesis in text instead of showing it, and the page's strongest moment (the Helios mythology paragraph + the real app screenshot) sits below the fold.

## What's Working

- **The token system is on-brand and well-executed.** Warm near-black Ember / warm near-white Paper grounds, rationed brass accent, status colors paired beyond hue. This is the part that isn't slop.
- **The mythology paragraph is real authorial voice.** It directly defeats the "sterile / personality-free" anti-reference and gives the page a reason to exist beyond a feature list.
- **Honest early-development callout.** The muted pre-1.0 warning delivers the brand's "earned confidence through candor," and the muted soft-bg treatment correctly subordinates it.

## Priority Issues

**[P0] Gradient text on the hero name — absolute ban, and the project's own.**
- Why it matters: `--vp-home-hero-name-color: transparent` + a linear-gradient background (style.css:57-62, 141-146) renders "Aethon" as gradient-filled text in both schemes. Gradient text is an Impeccable absolute ban and the loudest "AI made this" tell; DESIGN.md §6 lists it as a Don't and flags this exact hero as "a known exception to revisit." It is the first thing on the page.
- Fix: Kill the gradient — set the hero name to solid `--vp-c-brand-1` (or ink with the accent reserved for emphasis via weight/size). ~4-line CSS deletion.
- Suggested command: `/impeccable quieter`

**[P1] The composition is the VitePress default — it triggers the category reflex.**
- Why it matters: "Generic VitePress default" is PRODUCT.md's #1 anti-reference. Tokens are reskinned but the shape is unmistakably stock (hero + 3-button row + 4 identical cards + glow blob). A developer evaluating the project may read the docs as low-effort and infer the app is too. The brand's pitch is a layout-as-payload product, yet the landing is the most templated layout possible.
- Fix: Break the four-up grid into a deliberate, asymmetric arrangement (one large "Agent-rendered UI" feature paired with the screenshot, supporting features in a secondary row), or move the screenshot above the fold so it shows the thesis. At minimum, vary card sizing/weight so it stops reading as a generated grid.
- Suggested command: `/impeccable layout`

**[P2] Three co-equal CTAs; no single primary.**
- Why it matters: "Get started" (brand) sits beside "Quick start" and "View on GitHub," both styled identically as `alt`. The One Flame Rule wants exactly one brass primary; two identical alts split the decision and dilute the brass action. The terminal-native evaluator wants one obvious next step.
- Fix: Keep one brass primary ("Get started"), demote GitHub to a single ghost/text link, fold "Quick start" into the guide or make it visibly tertiary. Consider replacing one button with a copyable install one-liner.
- Suggested command: `/impeccable layout`

**[P3] Em dashes throughout the copy — violates the Impeccable copy rule.**
- Why it matters: Em dashes in every feature detail and both prose blocks ("The interface is not a fixed IDE — it is a canvas…", "Three palettes ship in the box — Ember, Paper, Æther.", "still settling — pin the release…"). A flagged AI-cadence tell; combined with the gradient text it compounds the "generated" read.
- Fix: Recast as periods, colons, or two sentences. "The interface is not a fixed IDE. It's a canvas the agent populates."
- Suggested command: `/impeccable clarify`

**[P3] Factual drift: "Three palettes ship" contradicts the seven shipped themes.**
- Why it matters: index.md:41 says "Three palettes ship in the box — Ember, Paper, Æther." DESIGN.md §2 "The Seven-Theme Contract" documents seven shipped themes (adds Brink, Daylight, Mist, Nocturne), confirmed against `src/styles/themes.css`. A factual undersell the project's own design doc contradicts; drift like this erodes the "this project knows what it is" credibility PRODUCT.md is chasing.
- Fix: "Seven themes ship in the box — Ember and Paper lead, with Æther, Brink, Daylight, Mist, and Nocturne." Reconcile against `themes.css` as source of truth.
- Suggested command: `/impeccable clarify`

## Persona Red Flags

- **Jordan (first-timer):** Two equally-styled "Get started" / "Quick start" buttons create a fork with no signpost — which is the front door? Must scroll past the fold to find out what Aethon looks like (the screenshot), the one thing that would orient them fastest.
- **Riley (stress-tester):** "Aethon" is short so no hero overflow, but the 3-button row wraps awkwardly at narrow widths, and the alchemical glyphs (🜲🜔🜕🜖) are obscure Unicode that may render as tofu/boxes where the symbol font is missing, leaving blank icon slots.
- **Casey (mobile):** The 4-card grid collapses to one column (fine), but the 1180px screenshot scaled to a phone makes the dashboard detail unreadable — decorative blur that undercuts "show, don't tell." Three stacked full-width buttons push real content far down.
- **Terminal-native developer (project persona):** Sees a polished-but-templated docs site, no copy-paste install command above the fold, and a "three palettes" claim they may already know is wrong from the repo. The honest pre-1.0 callout earns trust; the template composition spends it. Intrigued by the thesis, not yet convinced the execution matches the ambition.

## Minor Observations

- Hero `image` mapping (`light: /aethon-hero-dark.svg`, `dark: /aethon-hero-light.svg`) is correct, not a bug — SVG filenames describe artwork tonality; VitePress keys light/dark to the active scheme. Confusing naming; consider renaming to `-on-light` / `-on-dark`.
- All referenced assets exist on disk; no broken links.
- The hero `.image-bg` `blur(56–72px)` glow is pure decoration at rest — exactly the "ambient glow at rest" the Glow-Is-Earned Rule forbids.
- Inline `style="…"` attributes on the prose/screenshot/callout blocks hardcode `max-width`, `border-radius`, and `box-shadow` geometry rather than consuming tokens (they read tokens for color, good). Minor token-discipline gap.
- The screenshot uses `box-shadow: 0 24px 80px …` (`--shadow-5`-class depth) on settled content; DESIGN.md reserves that scale for toasts/modals.
- Version in nav is hardcoded `v0.3.3` (config.ts:47); easy to drift behind releases. Worth a build-time inject.

## Questions to Consider

1. The product's thesis is "the agent decides what you see" — agent-rendered, layout-as-payload. Why is the landing page for that product the least dynamic, most-templated layout VitePress ships? Could the hero literally be an A2UI payload, demonstrating the thesis instead of asserting it?
2. If you stripped the brass palette and the mythology paragraph, what would distinguish this from any other Tauri/Rust dev-tool docs site — and would a skim-reader feel the difference before they scroll?
3. The brief wants "illuminated rather than dazzled" and DESIGN.md bans gradient text as the dazzle tell — yet the first pixels are gradient-filled. If you fix only the hero gradient, is that enough to flip the verdict, or does the template composition carry the slop signal regardless?

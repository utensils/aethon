# Product

## Register

brand

> Aethon has two design surfaces. The **primary** surface this file anchors to
> is the **documentation website** (`website/`, VitePress) — a brand surface
> where the design IS the product. The **secondary** surface is the desktop
> app UI (`src/`), a _product_ register where design serves an agent-driven
> workflow. Both draw from one shared identity and the same token system
> (Ember / Paper / Æther), so brand decisions here flow to both; per-task work
> on the app can override the register to `product`.

## Users

Developers evaluating or running Aethon: people who live in a terminal and an
editor, are comfortable with agentic coding tools, and arrive at the docs to
answer one of two questions — "what is this and is it for me?" (the landing
page) or "how do I do X?" (the guide and reference). They read on a desktop
browser, often with a dark system theme, frequently while the app is open
beside the docs. They scan for the specific mechanism (share modes, devshell
wrap, layouts, slash commands) more than they read top to bottom. Aethon is
pre-1.0, so a meaningful slice are early adopters deciding whether the
foundations are sound enough to invest in.

## Product Purpose

Aethon is an agent-driven desktop shell: it embeds the pi coding agent inside a
Tauri 2 application and renders the agent's output as live, interactive UI via
the A2UI protocol. The interface is not a fixed IDE layout — it's a canvas the
agent populates, extensions extend, and themes color. The name is the Greek
Αἴθων, one of the horses that pulled Helios's sun chariot: the blazing one that
shapes what you see.

The website exists to make that thesis legible and credible. Success is a
developer landing on the site, grasping "the agent decides what you see" within
the first screen, seeing it demonstrated rather than asserted, and finding the
exact guide or reference entry they need without friction — leaving able to
install it, configure it, and trust that the project knows what it is.

## Brand Personality

Three words: **blazing, precise, mythic.** Confident expert voice that explains
real mechanisms in plain technical language and never reaches for hype. Warm
where it counts — the literary, mythological framing (Helios, the sun chariot,
"the blazing one") gives the brand its heat and its name — but the warmth serves
clarity, not decoration. Honest about being early: the docs state pre-1.0
status and breaking-change risk plainly rather than overselling. The emotional
goal is _earned confidence_ — a reader should feel the project is opinionated,
deliberate, and worth their time, illuminated rather than dazzled.

## Anti-references

- **Generic VitePress default.** Stock brand colors, untouched hero, the
  out-of-the-box template look. The site must never read as an unconfigured
  VitePress install; the Ember/Paper identity is the point.
- **Overwrought / loud.** Decorative gradients, glassmorphism, animation on
  everything, visual noise that competes with the content. The blazing accent
  signals illumination and clarity, not flash. Motion and color are spent
  deliberately, not sprayed.
- **Sterile / personality-free.** Cold, anonymous, generated-API-reference
  styling with none of the mythological warmth or authorial voice. Aethon has a
  name with a story; the docs should carry that, not strip it out.

## Design Principles

- **The agent decides what you see.** The core thesis is the spine of the brand.
  Lead with it, structure around it, and let every surface reinforce that the UI
  is a canvas, not a fixed layout.
- **Show, don't tell.** Demonstrate the agent-rendered UI, share modes, and
  devshell wrap with real screenshots and concrete examples rather than
  describing them in the abstract. The product's whole pitch is visual; the docs
  should be too.
- **Expert confidence, no hype.** Precise, mechanism-first language. Name the
  specific noun and the verb that says what the thing literally does. State the
  early-development status honestly; credibility comes from candor, not polish.
- **Illumination over decoration.** Warmth and the blazing accent exist to aid
  comprehension — guide the eye, mark what matters, set mood — never as flourish
  for its own sake. If a visual element doesn't help the reader understand
  faster, it's noise.
- **One identity, two surfaces.** Docs and app share one seven-theme token
  contract and the same brand. Keep them in sync (the docs theme CSS mirrors
  `src/styles/tokens.css` + `src/styles/themes.css`); a change to the brand on
  one surface should be reconciled with the other, not allowed to drift.

## Accessibility & Inclusion

Target **WCAG 2.2 AA**. Body text holds ≥4.5:1 contrast against its background,
large text ≥3:1 — verified in both the Paper (light) and Ember (dark) schemes,
since the site mirrors the OS theme. Fully keyboard-navigable. Honor
`prefers-reduced-motion`: every animation needs a reduced-motion alternative
(crossfade or instant). Don't rely on the blazing accent alone to carry meaning
(status, links) — pair color with text, weight, or shape so the site holds up
under color-vision deficiency.

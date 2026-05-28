---
layout: home

hero:
  name: Aethon
  text: An agent-driven desktop shell.
  tagline: The agent decides what you see.
  image:
    light: /aethon-hero-dark.svg
    dark: /aethon-hero-light.svg
    alt: Aethon hero
  actions:
    - theme: brand
      text: Get started
      link: /guide/installation
    - theme: alt
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/utensils/aethon

features:
  - icon: 🜲
    title: Agent-rendered UI
    details: The interface is not a fixed IDE — it is a canvas the agent populates. Extensions bring components, themes drive the palette, the agent emits the layout via the A2UI protocol.
    link: /guide/layouts
    linkText: How layouts work
  - icon: 🜔
    title: Tabs and PTY shells
    details: Top-strip agent tabs each own a pi conversation, model, and bash buffer. The bottom panel hosts xterm-powered PTY shells for vim, htop, fzf — fully theme-aware.
    link: /guide/agent-tabs
    linkText: Tab and shell guide
  - icon: 🜕
    title: Opt-in shell sharing
    details: Each shell tab carries a four-value share mode. Agents only see what you explicitly grant; the privacy floor is enforced Rust-side and cannot be widened by the agent.
    link: /guide/shells-and-share-modes
    linkText: Share modes
  - icon: 🜖
    title: Themes and extensions
    details: Three palettes ship in the box — Ember, Paper, Æther. Drop a `.ts` into `~/.aethon/extensions/` to add slash commands, components, or layouts. Project-local extensions auto-discover.
    link: /guide/themes
    linkText: Customize Aethon
---

<div style="max-width: 760px; margin: 4rem auto 0; text-align: center; color: var(--vp-c-text-2); font-size: 0.95rem;">

Aethon embeds the <a href="https://github.com/mariozechner/pi-coding-agent">pi coding agent</a> inside a Tauri 2 desktop shell and renders its output as live, interactive UI via the <a href="https://github.com/google/a2ui">A2UI protocol</a>. The name comes from Greek mythology: <em>Αἴθων</em>, one of the horses that pulled Helios's sun chariot. The blazing one that shapes what you see.

</div>

<p style="max-width: 1180px; margin: 3rem auto 0;">
  <img src="/aethon-app-screenshot.png" alt="Aethon workstation showing projects, the project dashboard, and file explorer" style="width: 100%; border: 1px solid var(--vp-c-divider); border-radius: 14px; box-shadow: 0 24px 80px color-mix(in srgb, var(--vp-c-black) 32%, transparent);" />
</p>

<div style="max-width: 760px; margin: 1.5rem auto 4rem; padding: 1rem 1.25rem; border-radius: 12px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: 0.86rem; line-height: 1.55;">

<strong style="color: var(--vp-c-warning-1)">Early development.</strong> Aethon is pre-1.0. The API surface and on-disk formats are still settling — pin the release you install and expect breaking changes between minor versions.

</div>

/**
 * Self-hosted fonts (@fontsource woff2, `font-display: swap`).
 *
 * Replaces the render-blocking Google Fonts stylesheet both surfaces
 * used to load in their HTML heads — an external network dependency on
 * the first-paint path that stalled boot on slow links and never
 * resolved offline (the iOS companion frequently launches with no route
 * to fonts.googleapis.com).
 *
 * Weights mirror the old `<link>`: 400/500/600/700 for UI + mono
 * families, 600/700 (+700 italic) for the Playfair wordmark.
 * `@fontsource/geist-sans` registers family "Geist Sans" — tokens.css
 * lists it right after "Geist" so a system-installed Geist still wins.
 */

import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/playfair-display/600.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/playfair-display/700-italic.css";

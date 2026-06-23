# Chat Rendering Performance Baseline

Date: 2026-06-23
App: Aethon dev build at `http://localhost:1420/`
Branch: `fix/misc-fixes`
Scope: session switching, transcript rendering, upward scroll, thinking/tool-call visibility modes

## Summary

The sluggishness is not explained by "too many total transcript messages" alone. The current `react-virtuoso` list keeps the mounted row count reasonably bounded, but the visible rows are extremely expensive: a single viewport can mount 40 to 50 message rows and 130 to 150 tool-card DOM subtrees while Virtuoso is still correcting measured heights.

The clearest baseline signal is row-height instability:

- Switching to large restored sessions produced 25 to 34 ms frame gaps.
- Upward scrolling with tool calls shown produced repeated 21 to 32 ms frame gaps and one 37 ms sample in an earlier run.
- In several synthetic scroll runs, `scrollHeight` changed by thousands of pixels during the first upward scroll, and the scroll position jumped between top, bottom, and middle. That matches the long-standing "scrollbar looks wrong until you scroll" symptom.
- `toolCalls: group-block` cut the visible DOM dramatically and made the test transcript fit in the viewport: 1323 total DOM nodes, 14 virtual rows, 6 tool-card elements, no scroll range.
- `toolCalls: hide` removed tool cards but still hit a 60 ms frame during the first upward scroll, which points to markdown/text row measurement and range replacement as a second bottleneck.

The most promising direction is not an immediate virtualizer swap. First fix the data model and measurement contract:

1. Cache transcript grouping/render metadata outside render so streaming and session switches do not rebuild the whole transcript.
2. Preserve per-tab Virtuoso measurement state or provide per-row `heightEstimates`.
3. Flatten expanded tool groups into virtual rows rather than rendering many tool cards inside one measured item.
4. Reduce imperative bottom-pinning to one owner and test whether Virtuoso's native chat APIs or scroll modifiers can replace custom rAF/timeouts.

## Implementation Status In This Branch

This report is the pre-change baseline that drove the current branch work. The branch now implements the first low-risk renderer changes:

- `TranscriptModel` rows are flattened before rendering, with collapsed summary rows and expanded child rows represented as separate virtual items.
- Tool-card metadata is cached per message object for grouping and collapsed peeks.
- Virtuoso receives typed `heightEstimates`, top-biased overscan, and a dev-only transcript performance snapshot hook.
- Expanded grouped tool calls and folded turns now render as flatter virtual rows instead of one large nested measured item.
- Missing tool-call visibility now defaults to `group-block`, keeping old tool-heavy turns collapsed by default while leaving explicit malformed config values on the conservative `show` fallback.

The remaining recommendations below are still the next performance backlog: preserving measurement state per tab, reducing custom bottom-pinning, and comparing a chat-native virtualizer after this data-shape cleanup.

## Method

I used the dev-only Aethon debug server and executed JavaScript inside the running Tauri webview. The harness did not send prompts to agents. It rendered idle transcripts, measured frame deltas around state switches and scroll steps, sampled DOM volume, and toggled transcript visibility settings.

Main benchmark dimensions:

- Session switch: replace the active rendered tab with an idle transcript and wait five animation frames.
- Upward scroll: settle near the bottom of the Virtuoso scroller, then move upward in coarse steps while sampling frame deltas and DOM counts.
- Visibility modes:
  - `thinking: hide`, `toolCalls: show`
  - `thinking: hide`, `toolCalls: group-block`
  - `thinking: hide`, `toolCalls: hide`

Important caveat: the first all-in-one benchmark exceeded the debug helper timeout. Because the harness used `window.__AETHON_SET_STATE__`, it also exercised normal frontend state effects and disturbed the in-memory background tab-bucket mirror. I stopped using that mirror for broad corpus claims after that point. The active session was restored to:

- `activeTabId`: `0c1d4ad9-7771-40aa-aabd-f923f58e36a8`
- `messageCount`: 168
- `transcriptVisibility`: `{ thinking: "hide", toolCalls: "show" }`

Before using this same running dev instance as tab-bucket ground truth, refresh or restart it.

## Corpus

The running app and session files exposed a good stress corpus:

| Session | Messages | Tool cards | Thinking msgs | Text chars | Notes |
|---|---:|---:|---:|---:|---|
| `Debug Aethon Context` | 196 | 113 | 36 | 37,327 | No-project session, heavy tool history |
| `Merge Green PR` | 168 | 90 | 31 | 27,911 | Active Aethon workspace session |
| `Fix 3D pool extension toggle` | 96 | 60 | 34 | 42,329 | Heavy thinking/text mix |
| `Ping Check` | 3 | 0 | 1 | 262 | Small control |

Earlier in-memory inspection before the synthetic mirror issue also saw these Aethon workspace transcripts:

| Session | Messages | Tool cards | Thinking msgs |
|---|---:|---:|---:|
| `Merge PR` | 134 | 66 | 29 |
| `Merge PR If Green` | 107 | 54 | 19 |
| `Merge When Green` | 127 | 66 | 25 |
| `list available models` | 78 | 19 | 32 |

## Baseline Results

### Session Switch

| Session / mode | Duration | Max frame | Frames >20 ms | DOM nodes after switch | Rows | Tool-card elems |
|---|---:|---:|---:|---:|---:|---:|
| `Debug Aethon Context`, current visibility | 218 ms | 26 ms | 2 / 5 | 2966 | 24 | 84 |
| `Merge Green PR`, current visibility | 162 ms | 26 ms | 2 / 5 | 2966 | 24 | 84 |
| `Merge Green PR`, tools shown | 129 ms | 27 ms | 2 / 5 | 3323 | 42 | 132 |
| `Merge Green PR`, group-block | 93 ms | 15 ms | 0 / 5 | 1323 | 14 | 6 |
| `Merge Green PR`, tools hidden | 170 ms | 34 ms | 4 / 5 | 1438 | 29 | 0 |

Interpretation:

- Tool-call grouping is a major lever. `group-block` reduced DOM volume by about 60 percent versus tools shown and removed switch-frame drops in this sample.
- Hiding tools is not automatically faster on switch. It removed tool DOM but expanded many normal markdown rows, producing 34 ms max frame.
- Current session switching remounts the virtualizer by `key={tabId}`, so measured row sizes are rebuilt instead of reused.

### Upward Scroll

For `Merge Green PR` with tools shown:

- Scroll aggregate max frame: 32 ms
- Scroll aggregate p95 frame: 28 ms
- First three upward scroll steps: 131 ms, 120 ms, 88 ms action windows
- DOM moved through 2873 to 3890 total nodes and 138 to 150 tool-card elements
- `scrollHeight` shrank from 11838 to 5439 px as rows were measured and replaced

For `Merge Green PR` with `group-block`:

- Transcript fit in the viewport after grouping.
- 1323 total DOM nodes, 14 virtual rows, 4 turn-block rows, 6 tool-card elements.
- Max frame during no-op scroll sample: 11 ms.

For `Merge Green PR` with tool calls hidden:

- First upward scroll step hit a 60 ms frame.
- DOM was only about 1580 nodes and zero tool-card elements, so this is not tool-card DOM alone.
- `scrollHeight` shrank from 6098 to 2540 px during early upward scroll.

Interpretation:

- The most visible scroll problem is measurement correction while scrolling, not just React render count.
- Tool cards amplify the problem, but markdown/text rows still cause large height corrections.
- The scrollbar/scroll-position instability is measurable: `scrollHeight` can shrink by thousands of pixels after interaction.

## Code Hot Spots

The peer-review explorer independently called out these same areas:

- `src/extensions/default-layout/virtual-message-feed.tsx`
  - `groupMessages(messages, visibility.toolCalls)` recomputes for the whole transcript when `messages` identity changes.
  - `VirtualMessageFeed` is keyed by tab id, isolating state but discarding Virtuoso measurement cache on every tab switch.
  - `defaultItemHeight` was removed again after it made the scrollbar worse. The issue is real, but a single global 120 px estimate is too blunt.

- `src/utils/toolCardGrouping.ts`
  - Grouping modes allocate and scan whole transcripts.
  - `group-block` is very effective when collapsed, but expanded groups currently render all children inside one Virtuoso row.

- `src/extensions/default-layout/message-groups.tsx`
  - Expanded tool groups and turn blocks render many nested messages/tool cards inside a single measured row. That defeats virtualization exactly when the user is inspecting a heavy turn.

- `src/extensions/default-layout/message-row.tsx`
  - Mounted rows still parse markdown, split thinking blocks, normalize display text, render branch actions, attachments, and nested A2UI.

- `src/extensions/default-layout/useScrollFollowController.ts`
  - Bottom pinning is imperative and repeated: `scrollToIndex`, `scrollTo`, direct `scrollTop`, rAF, and delayed timeouts. This may preserve past sticky-scroll behavior, but it increases scroll/layout churn.

- `src/styles/chrome.css`
  - The chat scroller uses inverse/reapplied CSS `zoom` around measured rows. Because Virtuoso measures DOM geometry, this should be treated as a measurement-risk multiplier.

## Library/Engine Options

### Stay on `react-virtuoso`, but use it more fully

This is the lowest-risk path because Aethon already has tests around Virtuoso behavior.

Evaluate:

- Per-row `heightEstimates` rather than one global `defaultItemHeight`.
- `restoreStateFrom` plus `getState` per tab to preserve measured item sizes when switching sessions.
- Top-biased `increaseViewportBy` or `minOverscanItemCount` for upward scrolling.
- `logLevel: DEBUG` in a dev-only run to collect item measurement reports.
- `scrollIntoViewOnChange` or `followOutput` callback experiments to reduce custom bottom-pin loops.

Relevant docs:

- Virtuoso says `defaultItemHeight` avoids probe rendering when the first item is an outlier, but a bad estimate can still mislead the list.
- Virtuoso has `heightEstimates` for widely varying item heights.
- Virtuoso has `restoreStateFrom`/`getState` for restoring measured item sizes after unmount/remount.
- Virtuoso supports `increaseViewportBy`, `minOverscanItemCount`, and `overscan` for slow dynamic content.

Sources:

- https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/

### Evaluate `@virtuoso.dev/message-list`

This is likely the best "feels native to chat" option if the commercial license is acceptable. It is built for human/chatbot conversations, with virtualized rendering, declarative scroll control, automatic scroll behavior for new/updated messages, and customizable scroll-to-bottom UI.

Potential upside:

- Less custom scroll-follow code.
- Better support for bottom-pinned chat semantics.
- Purpose-built scroll modifiers instead of imperative rAF/timeouts.

Risk:

- Commercial license.
- Migration still requires Aethon's grouping/row model to be cleaned up, or the same huge-row issue will follow.

Source:

- https://virtuoso.dev/message-list/

### Evaluate `@tanstack/react-virtual`

This is the best open-source alternative if Aethon wants direct ownership of scroll math. TanStack Virtual exposes dynamic measurement hooks such as `measureElement`, scroll-element observation, offset observation, and explicit virtual rows.

Potential upside:

- More explicit control over measurement, overscan, and row flattening.
- Easier to make "message group summary plus expanded child rows" a first-class virtual data model.

Risk:

- Aethon would own more chat semantics: bottom pinning, anchor preservation, smooth session switching, and scroll correction.
- Migration may take longer than tuning Virtuoso.

Source:

- https://tanstack.com/virtual/latest/docs/api/virtualizer

### Do not lead with `react-window`

`react-window` is appealing because it is small and fast, and current docs mention fixed, variable, and dynamic row heights. But Aethon's transcript has highly dynamic markdown, tool cards, expandable groups, late measurements, bottom-pinned chat behavior, and per-tab restoration. That is exactly the hard case where `react-window` tends to require custom measurement/reset code.

Source:

- https://react-window.vercel.app/

## Recommendations

### Phase 1: Make the current renderer measurable and less unstable

1. Add a dev-only transcript performance panel or debug command that reports:
   - active tab id
   - message count
   - group count
   - mounted row count
   - mounted tool-card count
   - scroller `scrollTop`, `scrollHeight`, `clientHeight`, bottom gap
   - last 10 frame deltas during scroll

2. Add a regression fixture with a heavy transcript:
   - 150+ messages
   - 80+ tool-card messages
   - thinking blocks
   - markdown/code blocks
   - grouped and hidden tool modes

3. Measure with scripted flows:
   - switch session
   - settle at bottom
   - wheel/scroll upward
   - toggle thinking
   - toggle tool modes

### Phase 2: Fix data shape before swapping libraries

1. Build a `TranscriptModel` cache keyed by tab id and message identity.
   - Cache `isToolCard`, `toolCardTitle`, normalized display text, thinking segments, and turn ids.
   - Append-only updates should touch only the current turn.
   - Visibility mode changes should transform cached group metadata, not rescan full message objects from scratch.

2. Flatten expanded groups into virtual rows.
   - Collapsed turn block: one row.
   - Expanded turn block: summary row plus each child message/tool card as its own virtual row.
   - This keeps virtualization effective when the user expands historical tool-heavy turns.

3. Replace one global row estimate with typed estimates.
   - user text row
   - agent text row
   - tool-card row
   - collapsed tool group
   - collapsed turn block
   - thinking block row

4. Preserve measurement state per tab.
   - Experiment with `getState` on unmount/switch and `restoreStateFrom` on remount.
   - Guard it behind tests because earlier sticky-scroll work avoided fragile restore timing.

### Phase 3: Revisit scroll ownership

1. Try reducing `scrollToBottom()` to one path.
2. Test Virtuoso `followOutput` callback or `scrollIntoViewOnChange`.
3. Keep one explicit user-scroll-intent gate, but remove duplicate `scrollToIndex + scrollTo + el.scrollTop` calls if native APIs cover the case.
4. Re-test terminal open/close and live footer behavior, since those are the reasons the custom controller exists.

### Phase 4: Library decision

Only after Phase 2, compare:

- Tuned `react-virtuoso`
- `@virtuoso.dev/message-list`
- `@tanstack/react-virtual`

Use the same heavy transcript fixture and same scripted benchmark. The target should be:

- Session switch max frame under 20 ms after warm measurement state.
- Upward scroll p95 frame under 16 to 20 ms.
- No scroll-height collapse greater than 10 percent during the first upward scroll after switching.
- No top/bottom jump during coarse wheel scrolling.

## Open Questions

- Is a commercial dependency acceptable for Aethon's core chat surface?
- Should the default transcript mode for completed agent/tool-heavy turns become `group-block` or `group-turn`?
- Can CSS `zoom` be removed from the measured chat subtree and replaced with transform/font scaling outside the scroller?
- Should session switch keep hidden Virtuoso instances mounted for the most recent N tabs, or is state restore enough?

## Bottom Line

The fastest path to "less bleh" is probably not replacing React. It is making the transcript renderer less hostile to any virtualizer:

- stable row estimates,
- preserved measurements,
- flattened expanded groups,
- cached grouping metadata,
- less imperative scroll correction.

If that still feels bad, evaluate `@virtuoso.dev/message-list` first for chat-native behavior, then `@tanstack/react-virtual` if Aethon wants to own the scroll engine.

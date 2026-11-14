# Plan — On-screen annotations during REC + screenshot in transcription mode

Date: 2026-09-22 · Status: **proposed** (open decisions at the end)
New track (AN) — parallel to the Jev Stages (E1–E5 of
[PLAN-JEV-CU.md](./PLAN-JEV-CU.md)); consumes their infrastructure in buildContext/MCP.

## Objective

While recording (or dictating), the user **points at and marks the screen** — laser, brush,
eraser, undo/redo — and the marks become **context consumable by the
agent**: vectors with timestamps + burned-in screenshots at the marked moments. In
transcription mode (dictation/session transcribing), a screenshot of the screen attaches to the session
— and, since in transcription-only mode **there is no screen video**, annotating there
triggers an **automatic burned-in screenshot** (visual record of what was marked).

## Design decisions (recommendations)

**D1 — Vectorial from day 1.** A mark = an event in the session's `annotations.jsonl`,
in **physical px** (DPI 1.53 lesson from F0) and **t relative to startedAt**
(consistent with `meta.markers` in seconds). Everything derives from the log: replay of
the state, undo/redo, burned PNG render, summary for the agent.

```jsonl
{"t":132.4,"seq":18,"type":"stroke","tool":"brush","color":"#ff4444","width":4,"points":[[x,y,ms],…]}
{"t":133.9,"seq":19,"type":"laser","points":[[x,y,ms],…]}   // ephemeral visual trail, PATH persisted (maintainer's decision)
{"t":140.1,"seq":20,"type":"erase","mode":"stroke","target":17}
{"t":141.0,"seq":21,"type":"erase","mode":"area","points":[[x,y],…],"radius":12}
{"t":150.0,"seq":22,"type":"clear"}
{"t":152.2,"seq":23,"type":"undo"}
{"t":155.0,"seq":24,"type":"redo"}
{"t":160.0,"type":"marker","id":3,"frame":"frames/marker-3.png","strokes":[15,17,18]}
```

**D2 — WYSIWYG: the marks END UP in the recorded video.** The annotation layer is
an overlay window on the screen (evolution of the region overlay already proven in F0);
since the capture records the screen, what the user sees is what the video has. The system
cursor does NOT come out in the desktopCapturer capture — the **laser is THE way to point
at the video**. The alternative (clean video + marking only for the user) would require
burning in post from the vector log — it stays as a future evolution, not v1 (see open item #1).

**D3 — Laser: ephemeral visual, persisted history** (maintainer's decision,
2026-09-22). The trail disappears from the screen (~600ms fade), but the **path stays in
`annotations.jsonl` like any other tool** — the context knows THAT
attention was pointed and WHERE: `{"type":"laser","points":[…]}`. Each laser "pass"
= 1 event with the simplified path (point decimation so the log doesn't
bloat). In the marker's burned screenshot, the laser goes in if it was active at that instant.

**D4 — Overlay either draws OR lets through; never both.** Two modes:
**draw** (overlay captures the mouse and draws) and **pass-through**
(`setIgnoreMouseEvents(true, {forward:true})` — the user interacts with the app
being demonstrated). Toggled by shortcut/palette; Esc returns to pass-through. Without
this the user can't operate the app they are demonstrating.

**D5 — History = replay of the log.** Undo `Ctrl+Z`, redo `Ctrl+Shift+Z`
(or `Ctrl+Y`); unlimited within the session; the `undo`/`redo` events are
also recorded (the log is the source of truth, the stack is derived state).

**D6 — Marker becomes a context anchor.** `Ctrl+M` (already exists) now:
captures the frame at that instant + **burns in the active strokes** (and laser, if
on) → `frames/marker-N.png` + `marker` event in the jsonl. Today the marker is just a
timestamp; with this it becomes the agent's "look here" (GLM reads PNG natively).

**D7 — Annotating in transcription-only mode ⇒ automatic burned-in screenshot**
(maintainer's decision, 2026-09-22). The annotation overlay is also
available during **dictation (F9)** — mic-only, no video. Since there is no
video there recording the screen, each **annotation burst** fires an automatic
screenshot: a stroke/laser finished and ~2s passed with no new events → capture
the frame + burn in the accumulated strokes → `frames/print-<t>s.png` in the
dictation session (same format as the manual screenshot; `print` event in the jsonl with the
strokes included). Pending flush on dictation stop. Without annotation in the dictation,
no screenshot — the automatic one only exists when the user marked something.

## v1 tools

| Tool | Behavior |
|---|---|
| **Laser** (G) | Pointer with a trail that fades (~600ms) to point at the video; path persisted in the log as its own event (attention context) |
| **Brush** (B) | Freehand; 4 colors (red, yellow, green, cyan) × 3 thicknesses; vector stroke |
| **Eraser — stroke mode** (E) | Removes the entire touched stroke (hit-test on the log) |
| **Eraser — normal mode** (E·double) | Erases by proximity: splits/removes segments within the radius |
| **Clear** (C) | Erases everything (`clear` event — undoable) |
| **Undo/Redo** | `Ctrl+Z` / `Ctrl+Shift+Z` + buttons on the palette |

Compact palette during REC (sister of the REC bar, corner):
tools, colors, thickness, undo/redo, mode indicator (draw/pass-through).
**MAINTAINER'S REVIEW (2026-09-23): the palette no longer opens together with
REC/dictation** — it is hidden by default and appears on demand via
`Ctrl+Alt+H` (the overlay stays alive in pass-through: D6/D7 screenshots, Ctrl+Alt+P
and hotkeys keep working without the palette). The standalone panel
(Ctrl+Alt+H outside a session) keeps opening with the palette visible.
Global shortcuts during REC: `Ctrl+Alt+G/B/E/C` tools, `Ctrl+Alt+Space`
toggles draw↔pass-through (proposal — see open item #2). Laser moved from
`Ctrl+Alt+L` to `Ctrl+Alt+G` (maintainer, 2026-09-22: whole cluster in the
left half — right hand off the keyboard).

## Screenshot in transcription mode (AN.5)

During **dictation (F9) in recording/transcribing** or a **session in REC**:

- **Manual** — `Ctrl+Alt+P` → `desktopCapturer.getSources` full-res in the main process →
  `frames/print-<t>s.png` in the current session (the dictation's or the recording's) →
  listed in buildContext. No active session: ignored with a log. (Same mechanism
  as the marker, without strokes.)
- **Automatic in dictation** (D7) — annotation used during
  transcription-only mode → burned screenshot of the burst (debounce ~2s) + flush on
  stop; one visual record per marked moment, not per stroke.

In screen REC the automatic one does NOT fire (the WYSIWYG video already records the
marks; screenshot there stays via marker or manual).

## Context for agents (AN.4)

`buildContext` comes to include:

```
Marcações: 6 (laser 01:40 · pincel 02:13 · borracha 02:20 · laser 04:30 · pincel 04:51 · clear 05:02) — vetoriais com timestamps em annotations.jsonl
Prints c/ marcação: frames/marker-2.png · frames/marker-3.png
```

(The literal buildContext lines above are emitted by the app in Portuguese: "Marks: 6 (laser … · brush … · eraser … · clear …) — vectorial with timestamps in annotations.jsonl" / "Screenshots w/ marks: …")

The Stage 3 MCP (E3) exposes `annotations {dir,name}` alongside
`session_get`. Evolutions: automatic ±3s clip per marker; semantic
summary of the marks via Jev (relevance score per segment).

## Sub-milestones

- **AN.1 — Annotation overlay + palette** (window, draw/pass-through modes,
  shortcuts; laser and brush working on screen, no REC yet). Acceptance:
  draw/point over any app, toggle pass-through, Esc clears the mode.
- **AN.2 — Events + history**: strokes/eraser/clear/undo/redo in
  `annotations.jsonl` (physical px, relative t); eraser in both modes.
  Acceptance: deterministic replay of the state from the log (unit test).
- **AN.3 — Burned marker**: Ctrl+M → frame + strokes → `frames/marker-N.png`
  (canvas composite in the overlay renderer). Acceptance: screenshot with the
  marks visible listed in buildContext.
- **AN.4 — Context**: lines in buildContext + field in the MCP (with E3).
- **AN.5 — Screenshot in transcription**: `Ctrl+Alt+P` during dictation/REC →
  `frames/print-*.png`; **auto burned screenshot** when annotating in
  transcription-only mode (D7). Acceptance: screenshot appears in the dictation
  session's context; annotating in dictation without a manual screenshot produces at least 1 burned screenshot.
- **AN.6 — Scroll-through**: in draw mode the mouse wheel is forwarded to the
  window below (koffi/user32: `WM_MOUSEWHEEL` on the `WindowFromPoint` of the
  point, overlay shifted off-screen via `SetWindowPos` at the instant of the
  query). Acceptance: a real page scrolls with the laser active; Ctrl+wheel keeps
  zoom; pass-through unchanged.

Sequence: AN.1 → AN.2 → AN.3 → (AN.4 with E3) → AN.5 → AN.6. AN.1/AN.2 are the
base of everything; AN.5 is independent and cheap (can move together with AN.3).

## Risks and countermeasures

- **DPI 1.53**: everything in physical px from day 1 (the region overlay already
  proved the CSS×physical math).
- **Performance during REC**: the overlay is a light 2D canvas (RAM ~50–80MB more,
  vs 566MB current peak); measure in AN.1.
- **Overlay in the video when it shouldn't be** (user forgets draw mode):
  clear indicator on the palette + Esc returns to pass-through.
- **Multi-display**: v1 on the recorded display (the same as the session); evolution.
- **Focus stealing**: the overlay never takes focus except in active draw mode;
  global shortcuts, not local ones.

## Decisions CLOSED by the maintainer (2026-09-22, confirmed in a questionnaire)

1. **Marks in the video: WYSIWYG** — they end up in the video (D2 as written). The system
   cursor doesn't come out in the capture; the laser is the pointer. Burning in post stays as
   a future evolution via the vector log.
2. **Shortcuts: the proposed ones** — `Ctrl+Alt+G/B/E/C` tools (laser moved from
   L to G on 2026-09-22, left hand),
   `Ctrl+Alt+Space` draw↔pass-through, `Ctrl+Alt+P` screenshot,
   `Ctrl+Z`/`Ctrl+Shift+Z` history.
3. **Fixed palette** — 4 colors (red, yellow, green, cyan) × 3 thicknesses;
   customization stays for v2.
4. **Screenshot: dictation AND session in REC** — `Ctrl+Alt+P` attaches to the current session in
   both modes.

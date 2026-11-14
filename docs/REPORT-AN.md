# Report AN.1/AN.2 — On-screen annotations + auto-print/burned marker

Date: 2026-09-22 · Plan: [PLAN-SCREEN-ANNOTATIONS.md](./PLAN-SCREEN-ANNOTATIONS.md)
Validity: engine + persistence + screenshots validated on real Windows (`--anotest`
and `--autotest`); interactive UX (drawing with the mouse) pending a human pass.

## Summary

| Item | Verdict |
|---|---|
| Pure engine (`src/shared/annotations.ts`): log fold, undo/redo, stroke/area eraser, decimation, per-segment hit-test | ✅ 16 tests |
| Main engine (`src/main/annotations.ts`): fullscreen overlay, Ctrl+Alt+* hotkeys, jsonl, seq/t, 2s auto-print debounce (D7), burned marker (D6), manual screenshot (AN.5), dictation buffer | ✅ |
| Renderer (`AnnotationApp`): canvas, laser with fade, palette (tools/colors/thicknesses/undo-redo), draw↔pass-through mode, frame+marks composite | ✅ loads and composes |
| **Auto-print D7 validated on Windows**: synthetic burst (stroke+laser) → `frames/print-5_1s.png` with stroke AND laser burned in (visual check by vision) | ✅ |
| **Marker D6 validated on Windows**: `--autotest` → `frames/marker-1.png` + print event kind=marker in the real session's jsonl | ✅ |
| Dictation persistence: log (3 events) + buffered screenshot saved on detach to the session dir | ✅ |
| Full suite | ✅ 39 tests + build |

## Files

New: `src/shared/annotations.ts` (pure engine), `src/main/annotations.ts`
(main engine), `src/renderer/annotation.html` + `annotation-main.tsx` +
`AnnotationApp.tsx` (overlay), `tests/annotations.test.ts`.
Changed: `ipc.ts` (annotation channels + canonical `VcInternalBridge` — the
per-renderer `declare global` collided), `preload/index.ts`, `windows.ts`
(exports dist/preload/wireLogging), `capture.ts` (attach on start, detach on
finalize/cancel/remux-error, burned marker), `ditado.ts` (attach/detach with
the saved session dir), `index.ts` (registerAnnotationIpc + `--anotest`),
`vite.config.ts` (annotation input), AGENTS.md.

## Implementation decisions

- Session and dictation share the buffer→flush pattern: the dir only exists at the end,
  so jsonl/screenshots accumulate in memory and persist on detach (cancel
  discards).
- `Ctrl+Z`/`Ctrl+Shift+Z` are NOT global (it would steal the undo of the app underneath):
  they apply with the overlay in draw mode (focusable) and via the palette buttons.
- Pass-through = `setIgnoreMouseEvents(true, {forward:true})` +
  `setFocusable(false)`; palette hover temporarily re-enables the window's
  mouse; `Esc` returns to pass-through.
- Composite is a main↔overlay ping-pong (frame dataURL → canvas + strokes +
  recent lasers → PNG b64); 4s timeout; lasers burned in if they just happened
  (<1.5s).
- Eraser hit-test against SEGMENTS (strokes are decimated — the test caught
  the mid-stroke bug before it went to Windows).

## How to validate (Windows)

```powershell
& $env:LOCALAPPDATA\voicecast\src\node_modules\electron\dist\electron.exe `
  $env:LOCALAPPDATA\voicecast\src --anotest     # jsonl + auto burned screenshot
# REC with marker: --autotest (records 8s, marks, burns frames/marker-1.png)
# Interactive UI: --anoui (overlay open 90s to drive real mouse/keyboard)
```

## REAL agent-driven UI validation (2026-09-22) ✅

The missing UX pass was executed without a human: synthetic mouse
(SetCursorPos + mouse_event via WSL→Windows interop) over the real overlay,
with per-step screenshots read visually + main log as evidence.

| Step | Result |
|---|---|
| Hotkey `Ctrl+Alt+B` (synthetic input) | ✅ entered draw mode (`modo desenho` ["draw mode"] in the log) |
| **Click on the "Pincel" ["Brush"] palette button** (pass-through → hover → click) | ✅ `annotationMouse from:draw` → draw mode + cmd tool brush |
| Drag on screen (brush) | ✅ pointerdown/move/up on canvas → **red stroke visible in the screenshot** + stroke in the jsonl |
| `Ctrl+Alt+L` + drag (laser) | ✅ ephemeral trail + path in the log |
| `Ctrl+Alt+E` + drag (eraser) | ✅ works; radius hit-test was borderline → **25% slack added** |
| Palette status | ✅ "desenhando · Esc solta o mouse" ["drawing · Esc releases the mouse"] ↔ "pass-through · Ctrl+Alt+Espaço desenha" ["Ctrl+Alt+Space draws"] |
| `Esc` | ✅ returns to pass-through (`modo pass-through` ["pass-through mode"] in the log) |

**Bugs found and fixed by the UI validation:**

1. **Palette buttons didn't activate drawing** — they changed only the
   renderer's local state; the main process (owner of
   `setIgnoreMouseEvents`/`focusable`) wasn't notified. Fixed: palette →
   `annotationMouse {from:"draw"}` → `cmdTool`.
2. **Palette hover in pass-through never arrived** — `forward:true`
   (forwarded mousemove) doesn't deliver hover events reliably on this
   machine. Fixed with the deterministic pattern: **the main process polls the
   cursor** (100ms) and enables the window's mouse when the cursor is over
   the palette rectangle (reported by the renderer). Log
   `poll cursor → mouse da janela ON` ["window mouse ON"] confirms the transition.
3. **Palette cut off by the taskbar** — `bottom:18` → `bottom:48`.

Method (to reproduce): `--anoui` hooks (90s overlay) + PowerShell driver
(`SetCursorPos`+`mouse_event`), per-step screenshots (CopyFromScreen) read
as images, `annotations.jsonl` and main.log as structured evidence.
Honest limitation: "feel of use" (stroke smoothness, shortcut ergonomics in
real use) only the maintainer can assess — everything else is validated.

### Jev verdict on the evidence (jev-1.13.0, 772ms)

- `verdicto_ux` (score 0–4): **3.05** (conf 0.96) — "funciona de ponta a
  ponta; ajustes menores ou cosméticos pendentes" ["works end to end; minor or cosmetic adjustments pending"] (Jev's verdict text, kept verbatim)
- `bloqueante` (noul): **0.17** — nothing requiring a fix before normal use

## Pending items

- ~~Human UX pass~~ **functional validation by agent completed** (section
  above); subjective feel of use stays with the maintainer.
- **AN.4**: annotation lines in `buildContext` + MCP exposure (with E3).
- Laser burned in the screenshot only when recent (<1.5s) — calibrate if needed.
- Always-visible palette during REC (WYSIWYG D2) — the palette does NOT go into
  burned screenshots (only frame+marks), but DOES go into the recorded video (it's a
  window on screen). If it bothers in the video: hide the palette outside hover (evolution).

## Demands from the 2026-09-22 0933 video + maintainer follow-up (implemented)

The session `2026-09-22/0933-7329b0fb` (transcribed after the hosted ASR — see
REPORT-ASR-HOST.md) registered 3 demands; the maintainer asked for 2 extras on the
same day. Everything implemented and validated (fix 3 with log-based E2E; 1, 2 and extras
with green build+suite and the usage pass owned by the maintainer):

1. **"Quando eu clico no laser, meu mouse some"** ["When I click the laser, my mouse disappears" — verbatim demand from the session transcript] — the renderer hid the
   cursor (`cursor:none`) in draw mode with laser. Now no tool hides the mouse (crosshair on all).
2. **"Movimentar a janela de pintura como o indicativo de gravação"** ["Move the painting window like the recording indicator" — verbatim demand from the session transcript] — the
   palette got a `⠿` grip + drag via pointer events (clamped to the screen). Since the
   overlay is fullscreen, `-webkit-app-region` doesn't fit (it would move the window);
   in pass-through the drag held the window mouse ON via
   `annotation:mouse from:"drag"` (cursor poll frozen during the drag)
   and the bounds are re-reported on every move.
3. **"Ao parar o vídeo ou a transcrição, a janela de pintura não sai"** ["When stopping the video or the transcription, the painting window doesn't go away" — verbatim demand from the session transcript] —
   REAL leak confirmed in the 09:33 log: the `catch` of `toggleDitado`
   (ASR failure) didn't detach — the overlay stayed stuck. Fix: detach in the
   catch. For video, extra hardening: stop without a recorder blob within 20s →
   discard + cleanup (otherwise `finalizeSession` never runs and neither does the detach).
   E2E: `--ditado-test` with a dead `VOICECAST_ASR_URLS` → error and `detach` 3ms
   later (13:26:50.381 → .384).
4. **Hide the palette (maintainer's request)** — `⏷ ocultar` ["hide"] button on the palette and
   hotkey `Ctrl+Alt+H` (toggle by the engine, single state in the main process). When hidden,
   it reports `null` bounds (hover poll doesn't turn the mouse on) and drawing keeps
   working via hotkeys. Comes back on the next attach.
5. **Screenshot embedded in the palette (maintainer's request)** — `📷 Print` button calls the same path as `Ctrl+Alt+P` (frame without marks → `frames/`,
   `manual` count).

Usage validation (drag, hide/show, screenshot, laser with visible mouse):
~2 min pass by the maintainer — synthetic input was dropped in that round
(machine in use).

## Standalone panel (2026-09-22, maintainer's request)

"It would be nice to be able to open the panel before starting a recording, and the
hide/show shortcut to work outside transcription/recording":

- **Ctrl+Alt+H became a global app shortcut** (registered in `whenReady`, outside the
  per-session hotkey list): without overlay → opens the **standalone panel**; with
  overlay → hides/shows the palette (as it already did in a session).
- Standalone panel = annotation as a draft, no session. `✕ fechar` ["close"] button
  on the palette closes and discards. `Ctrl+Alt+H` again hides/shows; the panel
  also serves to prepare drawing BEFORE recording.
- **Adoption**: `beginSession` (capture.ts and ditado.ts) — if the standalone
  panel is open when REC/dictation starts, the session adopts it: the overlay
  isn't recreated, events/seq preserved, pre-REC strokes go into
  `annotations.jsonl` (t keeps counting from the panel opening, no
  negatives). Hotkeys are not re-registered (`hotkeysOn` guard).
- TS detail: `open()` can't reference `this.overlay` after the
  early-return (narrowing to `null` ignores the `createOverlay()` mutation)
  — mode cmd send isolated in `sendMode()`.

## AN.6 — Scroll-through (mouse wheel in draw mode) + laser Ctrl+Alt+G (2026-09-22)

Maintainer's requests: in draw mode (laser/brush/eraser) the mouse wheel
died in the overlay (the page underneath didn't scroll) and, when scrolling, the screen "seemed
to freeze". Also, the laser `Ctrl+Alt+L` sits in the right half of the keyboard.

**Root cause (two, discovered in the wheeltest)**:

1. In draw mode the overlay is a normal OS window covering the screen — the
   Windows hit-test delivers the wheel to it and nobody handled it
   (Electron's `forward:true` only covers mousemove). Fix: renderer listens
   to `wheel` → IPC `annotation:wheel` → main injects `WM_MOUSEWHEEL` via
   **koffi/user32** into the window UNDER the point.
2. The initial repost landed **on the overlay itself**: `WindowFromPoint` returned the overlay's
   **child** HWND (Chrome_RenderWidgetHostHWND), and toggling
   `WS_EX_TRANSPARENT` doesn't exclude it from the hit-test — an Electron window is
   `WS_EX_NOREDIRECTIONBITMAP`, **not layered** (style-based skipping requires
   `WS_EX_LAYERED`). Every wheel came back to the overlay → burst of events =
   "freezing". Definitive fix: `SetWindowPos` pushes the overlay off-screen
   for an instant (without touching focus/z/style), `WindowFromPoint` finds the
   real window, and it comes back — all synchronous; **once per WHEEL burst** (returns 150ms after the last one — moving per event forced DWM recomposition dozens of times/s and choked the mouse; confirmed by the maintainer). Anti-loop
   safety: compares the target's `GetAncestor(GA_ROOT)` with the overlay's root.
   `Ctrl+wheel`/`Shift+wheel` still work (MK_* in wParam); an elevated window (UIPI)
   silently ignores the post (fail-soft).

**Shortcut**: laser `Ctrl+Alt+L` → **`Ctrl+Alt+G`** (maintainer's decision:
whole cluster in the left half — right hand off the keyboard). Other
shortcuts unchanged (B/E/C/X/Space/P/H are already on the left).

**Files**: `src/shared/wheel.ts` (pure engine: delta/wParam/lParam, 9
tests), `src/main/native-wheel.ts` (lazy koffi, fail-soft off Windows),
`annotation:wheel` channel (ipc + preload), listener in `AnnotationApp`
(outside React onWheel — passive), `--wheeltest` smoke (invisible).

**Validation**: local ci (typecheck + 55 tests + build); IPC→user32 chain
exercised on the host (post=true, target confirmed by log). **Human pass
pending**: scroll a real page with the laser active. Test rounds that
froze/gave `TypeError 7 vs 4 args` on the host were intermediate builds
mixed by robocopy during boot — solved with a restart; if it comes back,
always restart the app AFTER `dev:win` (scripts/ensure-app-win.ps1).

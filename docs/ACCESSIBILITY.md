# Accessibility release checks

Sibyl targets WCAG 2.2 AA for its core chat, scene, settings, model, persona,
and encrypted-vault flows.

## Automated gate

`npm run test:e2e` injects the pinned `axe-core` runtime into the built Electron
renderer and fails on serious or critical WCAG A/AA violations. It checks the
chat surface, scene-settings dialog, settings view, and vault unlock flow after
animations settle. The same test verifies that reduced motion, high contrast,
and 100/112.5/125% UI scaling persist and apply immediately.

## Keyboard pass

Run this checklist on both Windows and macOS:

1. Reach Chat, Discover, Models, and Settings using only Tab, Shift+Tab, Enter,
   and Space.
2. Create a solo thread and a multi-character scene without a pointer.
3. Select, rename, and delete a thread; expose message actions by keyboard
   focus; send, stop, regenerate, branch, and speak a response.
4. Open every drawer. Confirm focus enters it, Tab wraps inside it, Escape
   closes it, and focus returns to the opener.
5. Operate scene Play/Pause/Stop/Step and cast controls. Confirm focus remains
   visible at 125% scale.
6. Enable reduced motion and confirm decorative fades, shimmer, caret blink,
   and pulse animations stop.

## Screen-reader pass

Windows Narrator:

1. Start Narrator with `Win+Ctrl+Enter`.
2. Navigate the landmarks and thread list; confirm selected/current state is
   announced.
3. Open thread settings and confirm its dialog title, switches, descriptions,
   sliders, direction controls, and close behavior.
4. Generate one response. Confirm only state changes are announced—never every
   streamed token—and speech start/stop is announced once.
5. Lock and unlock the vault; confirm field labels and errors are announced
   without exposing the passphrase.

macOS VoiceOver:

1. Start VoiceOver with `Command+F5`.
2. Repeat the same chat, scene, dialog, generation, speech, and vault paths
   using VoiceOver navigation.
3. Verify native traffic-light spacing does not hide the first focus target.

Record the OS version, Sibyl version, screen reader, failed step, and screenshot
for any release-blocking defect. These manual passes are required before a
public release; automated success is not a substitute for assistive-technology
testing.

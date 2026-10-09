# Helper design and validation

The helper is a small top-edge command panel, with a calm navy surface, sharp rectangular controls and the existing particle orb. The design was built using the frontend-design skill; all artwork, particle paths and synthesized sounds are original. No character assets from another project are included.

## Visual system

| Token          | Value     | Purpose                                               |
| -------------- | --------- | ----------------------------------------------------- |
| Background     | `#091321` | One opaque color across HTML, body and native content |
| Surface        | `#112136` | Cards and controls                                    |
| Border         | `#29415b` | Quiet separation without shadows                      |
| Text           | `#edf5ff` | Primary reading contrast                              |
| Secondary text | `#a6bbd2` | Labels, model and activity                            |
| Accent         | `#8dd8ff` | Selected tab, focus and bottom edge                   |

Typography uses Segoe UI/system fonts: 12 px body, 11 px secondary labels, 10 px activity metadata, and slightly spaced NOVA wordmark. A 12 px alignment rail and 6–8 px gaps keep the 180 px panel readable. The orb occupies the left side of a 42 px header. Controls stay square; mini-orbs remain circular because they communicate integration state. Warning/critical colors appear only when data warrants attention.

`apps/web/src/components/helper/HelperUi.svelte` is the shared control catalog: button, tab, chip, text input and notification surface. `helper.css` defines their common tokens and layout. The wallpaper composer shares the same navy/sharp/accent language. Three initial tabs cover overview, chat and notifications; the plus adds existing weather/list data. Model labels use the actual `done.model` value, and unavailable services/calendar are explicitly labeled.

Keyboard focus remains visible. Native buttons support Enter/Space; Y/N applies only outside text editing. Confirmation cards cannot collapse while pending. Reduced-motion removes status pulsing and native resize animation, and reduces particle movement. A saved high-contrast mode and forced-colors styles preserve boundaries/focus. A 3 px native autohide strip avoids moving into a neighboring monitor.

## Screenshots and critique

Captured with Chromium at CSS sizes matching native targets, at device scales 1 and 2. Chat/confirmation/notification examples use bounded test fixtures, not production claims. Inspecting both scales led to reduced overview padding, a scrollable settings panel, explicit offline labels, a visible confirmation result, and consistent sharp controls.

| State        | 1x                                      | 2x                                      |
| ------------ | --------------------------------------- | --------------------------------------- |
| Compact      | [Image](img/helper-compact-1x.png)      | [Image](img/helper-compact-2x.png)      |
| Overview     | [Image](img/helper-overview-1x.png)     | [Image](img/helper-overview-2x.png)     |
| Chat         | [Image](img/helper-chat-1x.png)         | [Image](img/helper-chat-2x.png)         |
| Notification | [Image](img/helper-notification-1x.png) | [Image](img/helper-notification-2x.png) |
| Confirmation | [Image](img/helper-confirmation-1x.png) | [Image](img/helper-confirmation-2x.png) |
| Attachment   | [Image](img/helper-attachment-1x.png)   | [Image](img/helper-attachment-2x.png)   |
| Choices      | [Image](img/helper-choices-1x.png)      | [Image](img/helper-choices-2x.png)      |
| Weather      | [Image](img/helper-weather-1x.png)      | [Image](img/helper-weather-2x.png)      |
| Lists        | [Image](img/helper-lists-1x.png)        | [Image](img/helper-lists-2x.png)        |
| Settings     | [Image](img/helper-preferences-1x.png)  | [Image](img/helper-preferences-2x.png)  |
| Contrast     | [Image](img/helper-contrast-1x.png)     | [Image](img/helper-contrast-2x.png)     |

## Repeat the checks

With dependencies installed, install Chromium once using `npx playwright-core install chromium`. Start NOVA's dev server, then run `node scripts/check-helper.mjs`. `NOVA_HELPER_TEST_URL` optionally selects another local preview origin. The check mocks chat/TTS/confirmation requests and captures screenshots; it verifies draft/file retry, successful cleanup, model/ticker, optional views, snoozing, choice buttons, pause, confirmation persistence/Y-N behavior and autohide recovery.

API tests cover exact standing approvals, dangerous/schema/argument/revision changes, audit failure, guarded settings and backup exclusion. Cue tests verify all 15 signals are finite/bounded, low-gain, quiet-hour controlled and stopped by speech/listening. The PowerShell Docker check covers compilation, geometry/strip placement at several DPIs and negative coordinates, native MSG sizes, shortcuts and saved views.

Real Windows remains the release acceptance gap: resized Edge kiosk caption/bounds, minimum window height, monitor/DPI transitions, tray/shortcut conflicts, microphone/output devices and reopened-window notification delivery. Calendar, assistant mood and the shared night-mode producer belong to later phases. Production deployment waits for the phase approval required in the task file.

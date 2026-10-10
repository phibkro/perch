# Tern and OMP visual language in Perch

Updated 10 October 2026.

Perch now uses Tern's documented kit defaults for its native shell and OMP's
separation of conversation, activity, and metadata. This is a default appearance;
the phone does not yet receive the host's selected theme or program palette.

## Source decisions

| Source | Applied in Perch |
| --- | --- |
| [Tern kit variables][tern-tokens] | Neutral surface steps, cobalt action colors, semantic status roles, 6/8/12/16 px shape scale |
| [Tern chrome guidance][tern-chrome] | Distinct readable accent text and white-safe filled controls |
| [OMP Collab design tokens][omp-tokens] | Quiet borders, system sans text, monospace metadata |
| [OMP transcript styles][omp-transcript] | Assistant prose without a bubble; outlined user turns; compact activity rows |
| [OMP terminal theme][omp-theme] | Different colors for running, completed, interrupted, and failed tools |
| [assistant-ui native primitives][aui] | Existing thread, message, composer, scrolling and keyboard ownership |

The uploaded Tern 0.7 archive contains its executable, without loose theme or
font assets. The palette below comes from the public kit documentation, not a
dump of the user's configured desktop theme. OMP supports many themes as well;
its Collab colors and its default terminal theme are different designs.

The isolated Tern 0.7 runtime probe also supplied computed styles: Geist at
13.5 px for UI text and a Berkeley Mono family for terminal content, with compact
density. Its configured light theme produced different accent colors from the kit
defaults. This confirms that matching one palette cannot promise to match all
Tern appearances; live host-theme synchronization remains separate work.

## Native palette

| Role | Light | Dark |
| --- | --- | --- |
| App chrome | `#EFEFEC` | `#08080A` |
| Conversation panel | `#FBFBFA` | `#0F0F12` |
| Card | `#FFFFFF` | `#161619` |
| Raised surface | `#F4F4F2` | `#1D1D21` |
| Primary text | `#1B1C20` | `#EDEDED` |
| Accent text | `#2448C4` | `#9DBCFF` |
| Filled action | `#2F63F0` | `#2A5FE0` |

Colors live in [`src/ui/theme.ts`](../src/ui/theme.ts). The native registry uses
matching Uniwind variables in [`global.css`](../global.css). Update both when
changing a shared role.

`primary` is readable text and stroke color. `primaryFill` is the blue surface
behind white action text. Keeping these roles separate prevents the dark-mode
light-blue text token from becoming an unreadable white-text button.

Muted metadata uses Tern's text steps rather than its faint disabled color.
Light-mode success/error text uses darker semantic fills; warning text is also
darkened. Subtle card dividers remain quiet, while editable fields have stronger
borders. Labels and icons accompany status colors.

## Shape and reading rhythm

| Element | Treatment |
| --- | --- |
| Sidebar | Recessed chrome; selected row tint; 48 dp navigation rows |
| Main screen | New-chat page, existing sidebar navigation, bottom composer |
| Composer | 16 dp corner radius; stronger field edge; blue square send/stop controls |
| Tool activity | 12 dp card; colored edge, icon and written status; expandable output |
| Questions and plans | 12 dp cards; explicit choice and submit controls |
| Controls | 8 dp corners; 44–48 dp touch targets |
| Sheets | 16 dp upper corners |
| Metadata | System monospace; ordinary prose keeps system sans |

The Perch wordmark and feather remain. No font files or proprietary marks were
copied. Tern names Geist and Berkeley Mono in its stacks; this native adaptation
uses system fallbacks to avoid adding font distribution and loading requirements.

The refresh does not change the keyboard container, safe-area handling, scroll
ownership, approval preselection, artifact isolation, or command receipt rules.
Code panels retain a dark background while the existing syntax palette remains
dark-only. A light syntax theme should be implemented as a complete token pair,
not by changing only the background.

## Session details

[`SessionControls`](../src/ui/SessionControls.tsx) uses the same styles for
capability-gated host controls: title editing, thinking level, context use, branch
token usage, a read-only tool catalog, and a request to show the session in Tern.

Chat-setting actions stay disabled while offline, view-only, busy, opening a
session, or waiting for a question. The advertised Show in Tern action remains
available during work and questions, so the user can reach the host interface;
it remains unavailable while offline, view-only or opening another session.
Selected values come from host snapshots. Sending a command does
not optimistically claim that the host saved it. Cost, when present, is the host's
reported USD total for the current branch, not a provider subscription balance.
OMP records `usage.cost.total` as `costUsd` in its [session accounting][omp-cost]
and emits the same usage cost with `currency: "USD"` in its [ACP adapter][omp-acp].

## Verification scope

Palette contrast was calculated with the WCAG sRGB luminance formula. Against the
conversation panel, accent text is 7.25:1 in light mode and 10.09:1 in dark mode.
White text against filled actions is 5.04:1 and 5.51:1 respectively. These checks
cover the selected color pairs, not every possible rendered or disabled state.

Type checking passed. The [session-controls browser fixture][browser-fixture]
exercised the actual Expo 0.9.0 export in Chromium at 412 × 844 pixels in both
schemes. Its eleven scenarios passed using synthetic remote responses through
the real workspace manager, store and adapter. They cover host-confirmed values,
capability and connection guards, session replacement, focus during work and
questions, accessible progress/disclosure values, and long tool labels without
horizontal overflow. Six screenshots were also inspected.

Physical Android keyboard behavior, font scaling and screen-reader navigation
still require device verification. These browser fixtures do not launch a real
Tern/OMP process or make a model call.

[tern-tokens]: https://docs.stencil.so/tern/styles/variables.html
[tern-chrome]: https://docs.stencil.so/tern/guides/chrome.html
[omp-tokens]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/collab-web/src/styles/tokens.css
[omp-transcript]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/collab-web/src/components/transcript/transcript.css
[omp-theme]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/theme/dark.json
[omp-cost]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/agent-session.ts
[omp-acp]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/acp/acp-agent.ts
[aui]: https://www.assistant-ui.com/docs/react-native
[browser-fixture]: ../verification/remote/README.md

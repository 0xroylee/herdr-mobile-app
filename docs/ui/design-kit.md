# herdr mobile design kit

The source of truth for the app's look. [mockups.html](mockups.html) shows the screens and [design-kit.html](design-kit.html) shows these tokens and components side by side in both themes. When this file and a mockup disagree, this file wins.

The look follows herdr-app 0.1.10: the same theme names, fonts, status marks and list rules, read from its shipped `defaults/` folder (layouts, mods and themes) and its built-in Terminals layout.

## Principles

- **Color means status.** Chrome stays monochrome. Only the four states, focus and destructive actions get color.
- **The most urgent state wins.** blocked, then done, then working, then idle. A space, a tab and a group show their most urgent agent's state.
- **Watch by default.** Attach with `observe: true`. The phone never types into or resizes a Mac terminal unless the person takes it over.
- **Dense, but made for thumbs.** Every tap target is at least 44 × 44 pt, even where the drawn control is smaller.
- **Borders, not shadows.** Surfaces sit on 1 pt hairlines, as herdr's panes do.

## Themes

Two themes, named as herdr names them: **graphite** (dark) and **paper** (light). The app follows the system appearance until the person picks one in Settings: System, Graphite or Paper. The choice is stored in the kv store under `ui.theme`.

### Color tokens

| Token      | Use                                                     | graphite    | paper       |
| ---------- | ------------------------------------------------------- | ----------- | ----------- |
| `canvas`   | Screen background, behind groups and cards              | `#0e1012`   | `#f6f7f9`   |
| `chrome`   | Tab bar and other bars                                  | `#131619`   | `#fcfcfd`   |
| `surface`  | List groups, cards, chips, keys, composer               | `#17191c`   | `#ffffff`   |
| `raised`   | Pressed rows, selected segments, tab pills, step numbers | `#202225`   | `#f0f1f4`   |
| `border`   | Every hairline and separator                            | `#25282c`   | `#e5e7ec`   |
| `fg`       | Primary text, active tab                                | `#e8e9eb`   | `#252b37`   |
| `muted`    | Secondary text, idle titles, icon buttons               | `#a9adb3`   | `#5f6672`   |
| `dim`      | Tertiary text: subtitles, times, counts, placeholders   | `#8b8f95`   | `#89909d`   |
| `term-bg`  | Terminal pane background                                | `#111316`   | `#ffffff`   |
| `term-fg`  | Terminal default foreground                             | `#e6e7e9`   | `#252b37`   |
| `solid`    | Primary button background                               | `#e8e9eb`   | `#252b37`   |
| `solid-fg` | Primary button text and icon                            | `#131619`   | `#ffffff`   |
| `working`  | Working spinner and section label                       | `#8f84f5`   | `#7465db`   |
| `blocked`  | Needs you pill, `!`, section label, prompt card         | `#e2a03f`   | `#d79032`   |
| `done`     | Done dot and section label, connected dot               | `#3fb68b`   | `#39a380`   |
| `idle`     | Idle ring                                               | `#8b8f95`   | `#99a0ad`   |
| `danger`   | Destructive buttons, errors                             | `#ef6f6c`   | `#d14b45`   |
| `danger-fg` | Text and icon on a `danger` button                     | `#ffffff`   | `#ffffff`   |
| `focus`    | Keyboard focus ring (web and hardware keyboards)        | `#a7b4c6`   | `#5b6b82`   |

Tints are their own tokens, so no code applies an alpha by hand. React Native takes `#rrggbbaa`; where a tint sits on a known color, the token is the precomputed solid.

| Token           | Derived from                     | graphite    | paper       | Use                           |
| --------------- | -------------------------------- | ----------- | ----------- | ----------------------------- |
| `blocked-tint`  | `blocked` at 16 %                | `#e2a03f29` | `#d7903229` | Needs you pill, `!` background |
| `prompt-bg`     | `blocked` at 8 % over `surface`  | `#27241f`   | `#fcf6ef`   | Prompt card background        |
| `prompt-border` | `blocked` at 38 % over `border`  | `#6d5633`   | `#e0c6a5`   | Prompt card border            |
| `spinner-track` | `working` at 24 %                | `#8f84f53d` | `#7465db3d` | Spinner track                 |
| `scroll-track`  | `dim` at 18 %                    | `#8b8f952e` | `#89909d2e` | Horizontal scroll track       |
| `scroll-thumb`  | `dim` at 55 %                    | `#8b8f958c` | `#89909d8c` | Horizontal scroll thumb       |

### Terminal colors

The 16 ANSI colors per theme. Graphite uses herdr's shipped Atom One Dark palette with a lighter black; paper uses a One Light palette. Bold text uses the bright color when the program asks for it.

| Index | graphite  | paper     | Index | graphite  | paper     |
| ----- | --------- | --------- | ----- | --------- | --------- |
| 0     | `#454c59` | `#383a42` | 8     | `#767676` | `#696c77` |
| 1     | `#e06c75` | `#e45649` | 9     | `#e06c75` | `#ca1243` |
| 2     | `#98c379` | `#50a14f` | 10    | `#98c379` | `#448c27` |
| 3     | `#e5c07b` | `#c18401` | 11    | `#e5c07b` | `#986801` |
| 4     | `#61afef` | `#4078f2` | 12    | `#61afef` | `#2f5af3` |
| 5     | `#c678dd` | `#a626a4` | 13    | `#c678dd` | `#7f1d9e` |
| 6     | `#56b6c2` | `#0184bc` | 14    | `#56b6c2` | `#0b7a9e` |
| 7     | `#abb2bf` | `#a0a1a7` | 15    | `#e6e7e9` | `#252b37` |

Selection: graphite `#264f78`, paper `#cfe0ff`. Cursor: `term-fg`.

## Typography

Geist for the interface and JetBrains Mono for terminals, paths and keys. Both ship with herdr-app and load with expo-font from `@expo-google-fonts/geist` and `@expo-google-fonts/jetbrains-mono`. React Native needs one family per weight, so these are the only faces:

| Face                        | Family name            |
| --------------------------- | ---------------------- |
| Geist Regular (400)         | `Geist_400Regular`     |
| Geist Medium (500)          | `Geist_500Medium`      |
| Geist SemiBold (600)        | `Geist_600SemiBold`    |
| JetBrains Mono Regular (400) | `JetBrainsMono_400Regular` |
| JetBrains Mono SemiBold (600) | `JetBrainsMono_600SemiBold` |

Text styles. Size and line height in pt; tracking in em.

| Style        | Face          | Size / line | Tracking | Color   | Use                                       |
| ------------ | ------------- | ----------- | -------- | ------- | ----------------------------------------- |
| `largeTitle` | Geist 600     | 30 / 36     | −0.025   | `fg`    | Screen titles: Agents, Spaces, Settings   |
| `title`      | Geist 600     | 16.5 / 22   | 0        | `fg`    | Navigation title on an agent              |
| `pairTitle`  | Geist 600     | 28 / 34     | −0.025   | `fg`    | Pairing screen title                      |
| `headline`   | Geist 500     | 15.5 / 20   | 0        | `fg`    | Row titles, space names                   |
| `body`       | Geist 400     | 15 / 21     | 0        | `fg`    | Composer text, steps, paragraphs          |
| `callout`    | Geist 400     | 13.5 / 19   | 0        | `muted` | A blocked row's question, footnotes       |
| `button`     | Geist 500     | 13.5 / 18   | 0        | —       | Buttons, chips, segments                  |
| `section`    | Geist 500     | 13 / 16     | 0        | `dim`   | Section headers; status color in priority |
| `subhead`    | Geist 400     | 12.5 / 16   | 0        | `dim`   | Row subtitles, status strip               |
| `caption`    | Geist 400     | 12 / 16     | 0        | `dim`   | Times, counts, pane header                |
| `micro`      | Geist 600     | 11.5 / 14   | 0        | —       | Needs you pill                            |
| `tag`        | Geist 400     | 11 / 14     | 0        | `dim`   | Tags such as `vps`, `this Mac`            |
| `tabLabel`   | Geist 500     | 10.5 / 13   | 0        | —       | Tab bar labels                            |
| `terminal`   | JetBrains 400 | 10.6 / 16.4 | 0        | `term-fg` | Terminal cells at the default zoom      |
| `mono`       | JetBrains 400 | 11.5 / 16   | 0        | `dim`   | Paths, branches, sizes, keys              |

Titles truncate with an ellipsis on one line. A blocked row's question wraps to at most two lines. Respect Dynamic Type up to the largest accessibility size for every Geist style; the terminal follows pinch zoom instead.

## Space, size and shape

Spacing is a 2 pt scale used in these steps only: 2, 4, 6, 7, 8, 9, 10, 12, 13, 14, 16, 20, 24, 26, 32.

| Measure                      | Value              |
| ---------------------------- | ------------------ |
| Screen side padding          | 14                 |
| Group to group               | 14 above a section header |
| Row padding                  | 10 vertical, 14 horizontal; minimum height 58 |
| Space row minimum height     | 54                 |
| Icon to text in a row        | 12                 |
| Status bar safe area         | from `react-native-safe-area-context`, never hard-coded |
| Tab bar                      | 49 tall plus the bottom inset |
| Hairline                     | `StyleSheet.hairlineWidth` × 2, about 1 pt; color `border` |

| Radius | Value | Used by                              |
| ------ | ----- | ------------------------------------ |
| `xs`   | 5     | `!` mark, tags                       |
| `sm`   | 6     | Needs you pill                       |
| `md`   | 8     | Tab pills                            |
| `key`  | 9     | Keys, snippets                       |
| `btn`  | 10    | Buttons, icon buttons                |
| `seg`  | 11    | Segmented controls                   |
| `pane` | 12    | Terminal pane                        |
| `group`| 14    | List groups                          |
| `card` | 15    | Prompt card, pairing steps, big button |
| `field`| 17    | Composer                             |
| `full` | 999   | Chips, send button                   |

## Icons

UI glyphs are [Lucide](https://lucide.dev), as in herdr-app, drawn with `lucide-react-native` at stroke width 1.8 and colored by a token, never by a hex. Sizes: 15 in segments and chips, 17 in rows, 20 in title bars, 23 in the tab bar, 24 for back.

| Purpose        | Lucide name         |
| -------------- | ------------------- |
| Agents tab     | `bot`               |
| Spaces tab     | `layers`            |
| Settings tab   | `settings`          |
| Sort: priority | `clock`             |
| Sort: by space | `layers`            |
| Search         | `search`            |
| Back           | `chevron-left`      |
| Disclosure     | `chevron-right`, `chevron-down` |
| More           | `ellipsis`          |
| Cancel         | `x`                 |
| Selected row   | `check`             |
| Watching       | `eye`               |
| Send           | `arrow-up`          |
| New            | `plus`              |
| Branch         | `git-branch`        |
| Copy           | `copy`              |
| Scan           | `scan-line`         |

Program icons are herdr-app's own SVGs from `defaults/icons` (Simple Icons CC0, LobeHub MIT; keep their notices in `assets/icons/LICENSES.md`), shown at 18 in rows, 14 in pane headers and 13 in tab pills with `expo-image`. A program without an icon gets Lucide `bot` in `muted`.

## Motion

- **Working spinner.** herdr's ring: a full circle in `spinner-track` and a quarter arc in `working`, stroke 3.2 on a 24 viewBox, one turn every 900 ms, linear, on the UI thread with Reanimated. With Reduce Motion on, it stays still.
- **State changes.** A row that changes section moves without animation; its new mark fades in over 150 ms.
- **Press.** A pressed row or button takes `raised` for as long as it is held. No scale.
- **Sent.** After a send or a prompt button, show the Sent state at once; it clears when the agent reports `working` or after 20 s.
- **Haptics.** A light impact on send and on a prompt button, through `expo-haptics`.

## Components

Each component lists its parts, sizes and states. Names are the component names to use in code.

### `StatusMark`

The four marks herdr-app draws, sized for a row.

| State           | Drawing                                                                 | Size |
| --------------- | ----------------------------------------------------------------------- | ---- |
| `working`       | Spinner, see Motion                                                      | 14   |
| `blocked`       | Pill: `micro` text "Needs you", `blocked` on `blocked-tint`, radius `sm`, 7 horizontal padding | height 20 |
| `blockedCompact`| `!` in Geist 600 11, `blocked` on `blocked-tint`, radius `xs`              | 16 × 16 |
| `done`          | Filled circle, `done`                                                    | 8    |
| `idle`          | Ring, 1.6 stroke, `idle`                                                 | 8    |

Use `blockedCompact` where a header already says Needs you: the priority view's Needs you section and a space row. Use `blocked` everywhere else. `error` counts as `blocked`. A status the app doesn't know draws as `idle`.

### `AgentRow`

One agent. Parts, left to right: program icon (18), the text column, then the end group: time, an optional `Tag` for another machine, and the `StatusMark`. The text column holds:

1. The title in `headline`: the tab's name or the agent's live title, as herdr-app picks it. Idle titles use `muted` at weight 400.
2. The subtitle in `subhead`: `space · Program` in the priority view, `Program` in the by-space view. In the by-space view a blocked row appends ` · ` and the question.
3. Priority view only: a blocked row adds its question in `callout`, two lines at most, 7 above.

Time is how long the agent has been in its state: `<1m`, then whole minutes (`4m`), hours (`2h`) and days (`3d`), refreshed every 30 s. Tapping a row opens the agent. A long press offers Pin to the top, Copy address, and Take over.

Live Claude Code or Codex terminals without a status report, and other live terminals with a known program icon or a non-null `terminal.template`, also appear in Idle. Show `Waiting for status` in `caption` `dim` where the question would go. Move the row to its reported state after its first OSC 7501 report. Do not add finished terminals by this rule.

### `SectionHeader`

`section` text and a count in `dim` at weight 400, 7 apart, padding 14 top, 8 bottom, 4 sides. In the priority view the label is the state's name in its color: Needs you (`blocked`), Done (`done`), Working (`working`) and Idle (`dim`). In the by-space view the label is the space name in `dim`.

### `ListGroup`

A `surface` container with a `border` hairline and radius `group`, holding rows separated by hairlines. No inner shadow, no margin between rows.

### `ScreenHeader`

`largeTitle` on the left, icon buttons on the right, padding 6 top, 10 bottom, 4 sides, inside the screen padding. The Agents screen puts sort, search and `plus` in that order. Sort uses `clock` when sorted by priority and `layers` when by space. Tapping it toggles the sort, which is stored as `agents.sort`. The Agents header's `plus` opens `/start`. The Spaces header's `plus` keeps creating an empty space.

### `MachineChip`

A `full`-radius chip on `surface` with a hairline: an 8 dot, the machine's name in `button`, and `chevron-down` at 14 in `dim`. Dot colors: `done` connected, `blocked` reconnecting, `dim` offline. To its right, `subhead` text: `8 agents · 5 spaces`. Tapping the chip lists the paired machines.

### `IconButton`

A 36 visual square, 44 hit area, radius `btn`, icon in `muted`. `plain` has no fill; `boxed` has `surface` and a hairline. Pressed: `raised`.

### `NavHeader`

For an agent. Back (`chevron-left` 24), then a title column with `title` and a `subhead` of `space · machine`, then More (`ellipsis`). Height 50. More opens: Take over, Interrupt (sends `ctrl+c` after a confirm), Copy address, End terminal (after a confirm, in `danger`).

### `StatusStrip`

Under the header: on the left the state, on the right Watching (`eye` 15 and `subhead`). The state is the spinner and `Working · 4m` in `working` at weight 500, the `blocked` pill reading `Needs you · 1m`, a `done` dot and `Done · 12m`, or an `idle` ring and `Idle · 3h`. Padding 0 16, 10 bottom. After a takeover, Watching becomes `In control` in `fg`.

### `TerminalPane`

A `term-bg` card with a hairline and radius `pane`, 10 from the screen edges.

- **Header**, 34 tall with a hairline below: program icon (14), the program name in `caption` at weight 500 in `fg`, the folder in `caption` `dim` with the home folder shortened to `~`, then on the right the terminal size in `mono` at 10.5 (`120×36`).
- **Body**: the terminal grid in `terminal`, 10 × 12 padding. Cells keep the Mac terminal's columns and rows. The view starts at the left edge with the last non-blank row or visible cursor row at the bottom; an empty grid falls back to its last row. Wide lines scroll sideways. Pinch zoom ranges from the smaller of 8 pt and the width-fitting overview size up to 16 pt. When overview is below the default, double tap switches between overview and default; otherwise it returns to default. Take over sizes the Mac terminal at the larger of the current zoom and 8 pt.
- **Scroll indicator**: 3 tall at the bottom, `scroll-track` with a `scroll-thumb`, shown only when the grid is wider than the pane.

### `KeyBar` and `Key`

A row of keys above the composer, scrolling sideways when it doesn't fit. A key is 32 tall, at least 40 wide, 10 horizontal padding, `surface` with a hairline, radius `key`, `mono` 12 in `muted`. The keys and the `terminal.keys` names they send:

| Label | Sends    | Label | Sends   |
| ----- | -------- | ----- | ------- |
| esc   | `esc`    | ↓     | `down`  |
| ⌃C    | `ctrl+c` | ←     | `left`  |
| tab   | `tab`    | →     | `right` |
| ↑     | `up`     | ⏎     | `enter` |

Keys are hidden while watching an agent that is not yours to type into; they show in both Watching and In control, because `terminal.keys` doesn't resize.

### `Composer`

A `surface` field with a hairline and radius `field`, 9 padding (15 on the left), above the home indicator. Placeholder in `body` `dim`: `Message Claude Code…`, with the program's name. The send button is a 32 circle in `solid` with `arrow-up` 17 at stroke 2.2 in `solid-fg`, disabled at 40 % opacity while the field is empty. Send uses `terminal.send`. While sending, the button shows the spinner in `solid-fg`; then the field clears and a Sent line appears above it in `subhead`: `Sent · waiting for Claude Code`.

### `PromptCard`

Shown when a blocked agent's question is one the app recognizes. `prompt-bg` background, `prompt-border` hairline, radius `card`, 13 × 14 padding, 10 from the screen edges.

1. Header line, `subhead`: the `blocked` pill, the program name, and the time on the right.
2. The question in `headline`, wrapped.
3. Optional detail in `mono` 11.5: the file and its change, such as `docs/nav.md · +3 −1`.
4. Buttons, 8 apart, wrapping: the first choice as `Button solid`, the others as `Button outline`. Each sends that choice's keys.

After a tap the buttons give way to the Sent state. If the question isn't recognized, no card shows; the composer's placeholder becomes `Answer Claude Code…`.

### `StartForm`

The route `/start` is a modal. It fills the phone screen and appears as a centered card on web. The header has Cancel (`x`) on the left and `Start agent` in the center.

`Run` is a `ListGroup` of templates from `templates.list` and the built-in Claude Code and Codex programs. Each row has a `ProgramIcon` at 18, a name in `headline`, and a description in `subhead` `dim`. Built-ins use `Interactive session`. The selected row shows `check` at 17 in `fg`. When a space is preselected, the last row is `Empty tab` with the `terminal` icon.

`Where` is a `ListGroup` with a Space row and a Folder row. The space picker lists existing spaces and `New space`. An existing space defaults to its folder. A new space needs a folder. The folder picker suggests the selected space's layout `folder` first, then `cwd` values from terminals in that space, then the last five folders this phone used to start agents. Mark the default with a `Tag` reading `space folder`. `Other…` reveals a `TextInput` styled like `ManualEntry.tsx` in `mono` 13. The field accepts only absolute paths or paths that start with `~/`.

`First message` is a multiline field styled like `Composer`, with the placeholder `What should Claude Code do? Optional`. The footer shows the selected program, shortened folder, space and tab, for example `Claude Code · ~/src/herdr · Work › new tab`, above a `Button large` labeled `Start Claude Code`. This line and button confirm the start; do not show a second alert. While starting, disable the inputs and show the spinner in `solid-fg`. If the device has the Watch role, replace the form with an `EmptyState` message.

### `Button`

| Variant   | Height | Padding | Radius | Fill      | Text            |
| --------- | ------ | ------- | ------ | --------- | --------------- |
| `solid`   | 36     | 0 13    | `btn`  | `solid`   | `button`, `solid-fg` |
| `outline` | 36     | 0 13    | `btn`  | `surface` + hairline | `button`, `fg` |
| `danger`  | 36     | 0 13    | `btn`  | `danger`  | `button`, `danger-fg` |
| `large`   | 52     | 0 20    | `card` | `solid`   | Geist 600 16, `solid-fg`, optional icon 19 |

Pressed: 85 % opacity. Disabled: 40 % opacity.

### `TabPill`

A tab inside a space: 30 tall, 0 11 padding, radius `md`, `raised` fill, program icon (13), the tab's name in Geist 400 13, then a 6 dot in `blocked` or `done` when the tab is in that state, as herdr's tab bar draws it. Working and idle tabs have no dot. The last pill is `+` in `dim`. It opens `/start` with that space preselected. The `Run` list includes `Empty tab` as its last choice, which keeps the existing empty-tab action.

### `SpaceRow`

A space: its name in `headline`, then its branch in `mono` 11.5 `dim` with `git-branch` 12 and ahead or behind counts (`main ↑2`). On the right, its most urgent state as a `StatusMark`, compact for blocked, then `chevron-down` when open or `chevron-right` when closed, 17 in `dim`. An open space shows its `TabPill`s below, 14 from the sides and bottom. A space whose agents are all idle shows its name in `muted` at weight 400.

### `Tag`

`tag` text in `dim`, hairline, radius `xs`, 1 × 6 padding. Uses: a machine's name on another machine's agent (`vps`), `this Mac`, a machine's connection (`ssh`).

### `TabBar`

`chrome` background, hairline on top, three equal items: Agents (`bot`), Spaces (`layers`), Settings (`settings`). Icon 23 above a `tabLabel`, 4 apart. Active: `fg`; inactive: `dim`. Height 49 plus the bottom inset.

### `Banner`

A connection problem, shown under the screen header and above the content: `surface` with a hairline, radius `group`, 10 × 14 padding, `subhead` in `muted` with a leading mark: the spinner and `Reconnecting to MacBook Pro…`, or a `blocked` `!` and `Can't reach the bridge. Check that Tailscale is on.` with a Retry `Button outline`.

### `EmptyState`

Centered in the list area, `callout` in `dim`, 24 side padding. Agents: herdr's words, `No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.` Spaces: `No spaces yet. Spaces you make in Herdr show up here.`

### Pairing parts

`PairingSteps` is a `ListGroup` of steps: a 24 number circle on `raised` with Geist 600 12.5 in `muted`, the step in `body`, and an optional detail. `Snippet` is a `term-bg` box with a hairline, radius `key`, 9 × 11 padding, `mono` 12 text and a `copy` button. `ConnectionLine` is an 8 `done` dot and `subhead`: `Connected as my-iphone`.

### Notifications

Title: `<agent> needs you` or `<agent> is done`, where `<agent>` is the row title. Body: `<Program> in <space>: <question>` for blocked, `<Program> in <space> finished.` for done. Send them only for blocked and done, and only while the Mac's person is away. Tapping one opens that agent.

## Screens

Each screen is drawn in [mockups.html](mockups.html):

| #   | Screen                | Built from                                                         |
| --- | --------------------- | ------------------------------------------------------------------ |
| 1   | Agents, by priority   | `ScreenHeader`, `MachineChip`, `SectionHeader`, `ListGroup`, `AgentRow`, `TabBar` |
| 2   | Agent, watching       | `NavHeader`, `StatusStrip`, `TerminalPane`, `KeyBar`, `Composer`   |
| 3   | Agent, needs you      | the above and `PromptCard`                                         |
| 4   | Spaces                | `ScreenHeader`, `SpaceRow`, `TabPill`, `Tag`, `TabBar`             |
| 5   | Agents, by space      | screen 1 with the by-space sort, in paper                          |
| 6   | Pairing               | `PairingSteps`, `Snippet`, `ConnectionLine`, `Button large`        |
| 7   | Push                  | Notifications                                                      |
| 8   | Start agent           | `StartForm`, `ListGroup`, `Composer`, `Button large`               |

Settings has no mockup yet. It is a `ListGroup` of: Theme (System, Graphite, Paper), Notifications (Needs you, Done), Machines (paired machines with Remove), and About.

## Behavior

- **Order.** Priority view: Needs you, Done, Working, Idle; within a section, the most recent state change first. By-space view: spaces in the `herdr-app` document's order, agents in tab order.
- **Seen.** Done means it finished while nobody looked. Opening the agent on the phone shows it as idle from then on, until its next turn. The phone keeps this per terminal and turn in the kv store under `seen.<machine>.<terminal>`.
- **Watching.** Every attach is `observe: true`. Take over asks first, then attaches without `observe`, which makes the phone the active viewer and resizes the Mac's terminal to the phone.
- **Sending.** The composer uses `terminal.send`, which pastes and presses Enter once nobody has typed for about 3 s. Keys use `terminal.keys`.
- **Spaces.** Read from the `herdr-app` document with `doc.get`, falling back to the `herdr.space` and `herdr.tab` labels. The Spaces header `+` and `Empty tab` still use `herdr-app do` on the Mac, so they need Herdr running there; say so under the list. Agent starts support both window states: use `herdr-app do` when Herdr is open, and `terminal.run` with the `herdr.space` and `herdr.tab` labels when it is closed.
- **Offline.** Keep the last snapshot on screen, dimmed to 60 %, with the `Banner`. Never show a stale state as live.

## Building it with Uniwind

The app styles with Uniwind 1.13 and Tailwind 4: the tokens above become CSS variables, and components use utilities named after them, such as `bg-surface`, `text-dim`, `border-border` and `rounded-group`. These notes come from Uniwind's documentation (quickstart, theming, FAQ, `withUniwind`).

### Setup

`metro.config.js`, with Uniwind as the outermost wrapper:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./src/global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
```

Import `src/global.css` once, at the top of `src/app/_layout.tsx`. Metro generates `src/uniwind-types.d.ts`; run `uniwind generate-artifacts --css ./src/global.css --dts ./src/uniwind-types.d.ts` where typechecking runs without Metro.

### `src/global.css`

Graphite is Uniwind's `dark` theme and paper its `light` theme, so the built-in `system` theme follows the phone. Every theme defines the same variables.

```css
@import "tailwindcss";
@import "uniwind";

@theme {
  --font-sans: "Geist_400Regular";
  --font-sans-medium: "Geist_500Medium";
  --font-sans-semibold: "Geist_600SemiBold";
  --font-mono: "JetBrainsMono_400Regular";
  --font-mono-semibold: "JetBrainsMono_600SemiBold";

  --radius-xs: 5px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-key: 9px;
  --radius-btn: 10px;
  --radius-seg: 11px;
  --radius-pane: 12px;
  --radius-group: 14px;
  --radius-card: 15px;
  --radius-field: 17px;
}

@layer theme {
  :root {
    @variant dark {
      --color-canvas: #0e1012;
      --color-chrome: #131619;
      --color-surface: #17191c;
      --color-raised: #202225;
      --color-border: #25282c;
      --color-fg: #e8e9eb;
      --color-muted: #a9adb3;
      --color-dim: #8b8f95;
      --color-term-bg: #111316;
      --color-term-fg: #e6e7e9;
      --color-solid: #e8e9eb;
      --color-solid-fg: #131619;
      --color-working: #8f84f5;
      --color-blocked: #e2a03f;
      --color-done: #3fb68b;
      --color-idle: #8b8f95;
      --color-danger: #ef6f6c;
      --color-danger-fg: #ffffff;
      --color-focus: #a7b4c6;
      --color-blocked-tint: #e2a03f29;
      --color-prompt-bg: #27241f;
      --color-prompt-border: #6d5633;
      --color-spinner-track: #8f84f53d;
      --color-scroll-track: #8b8f952e;
      --color-scroll-thumb: #8b8f958c;
    }

    @variant light {
      --color-canvas: #f6f7f9;
      --color-chrome: #fcfcfd;
      --color-surface: #ffffff;
      --color-raised: #f0f1f4;
      --color-border: #e5e7ec;
      --color-fg: #252b37;
      --color-muted: #5f6672;
      --color-dim: #89909d;
      --color-term-bg: #ffffff;
      --color-term-fg: #252b37;
      --color-solid: #252b37;
      --color-solid-fg: #ffffff;
      --color-working: #7465db;
      --color-blocked: #d79032;
      --color-done: #39a380;
      --color-idle: #99a0ad;
      --color-danger: #d14b45;
      --color-danger-fg: #ffffff;
      --color-focus: #5b6b82;
      --color-blocked-tint: #d7903229;
      --color-prompt-bg: #fcf6ef;
      --color-prompt-border: #e0c6a5;
      --color-spinner-track: #7465db3d;
      --color-scroll-track: #89909d2e;
      --color-scroll-thumb: #89909d8c;
    }
  }
}
```

The terminal's 16 ANSI colors don't belong in CSS: the terminal renderer reads them from a typed table in code, keyed by theme, with the values in [Terminal colors](#terminal-colors).

### Rules

- **Theme.** Settings maps System, Graphite and Paper to `Uniwind.setTheme("system" | "dark" | "light")`. Uniwind doesn't remember the choice, so store it under `ui.theme` in the kv store and apply it before the first screen renders. Read the active theme with `useUniwind()` only where code needs it, such as picking the ANSI table.
- **Fonts.** Load the five faces with `useFonts` from `@expo-google-fonts/geist` and `@expo-google-fonts/jetbrains-mono`, using the family names above as keys, and keep the splash screen up until they load. Weights are families: use `font-sans-medium`, never `font-medium`.
- **Text styles.** One `Text` component with a `variant` prop for the styles in [Typography](#typography). Each variant maps to one complete class string, such as `"font-sans-medium text-[15.5px] leading-[20px] text-fg"`. Uniwind's styles don't cascade, so every `Text` sets its own font, size and color.
- **Class names.** Write every class name in full. Never build one by concatenation or interpolation (`bg-${state}`); choose from a lookup of complete strings instead.
- **Tints.** Use the tint tokens (`bg-blocked-tint`, `border-prompt-border`). Don't rely on opacity modifiers such as `bg-blocked/15`, which Uniwind doesn't document for theme colors.
- **Other components.** Wrap components that Uniwind doesn't style, once, at module level: `const Image = withUniwind(ExpoImage)` for expo-image and `withUniwind(FlashList)` for lists. Check both on iOS and Android.
- **Safe area.** Mount `SafeAreaListener` from `react-native-safe-area-context` at the root and call `Uniwind.updateInsets(insets)` in its `onChange`; then use `pt-safe` and `pb-safe`.
- **Spacing.** Tailwind's default scale already covers the steps above: `p-3.5` is 14, `gap-1.75` is 7, `px-2.5` is 10.
- **Inline styles.** An inline `style` beats a class, so reserve it for values computed at run time, such as the terminal's cell size at a zoom level.
- **Motion.** The spinner and other animation use Reanimated on the UI thread, not CSS transitions.

# Twordle

A Wordle-inspired two-player guessing game, with a solo mode that plays like the original. Playable in any browser — desktop or mobile. Two players can play in person (pass-and-play on one device) or asynchronously by sharing a URL or QR code between devices. Single self-contained HTML file, no build step, no server, deployed via GitHub Pages.

**Live URL:** https://rmukhopadhyay.github.io/twordle  
**Repo:** https://github.com/rmukhopadhyay/twordle

---

## Architecture

Everything lives in `index.html` — HTML, CSS, and a single `<script type="module">` in one file. UI is built with **Preact + HTM**, with a couple of small utilities, all loaded from `esm.sh` at runtime:

```js
import { h, render } from 'https://esm.sh/preact@10.22.0';
import { useReducer, useEffect, useState, useRef, useCallback, useMemo } from 'https://esm.sh/preact@10.22.0/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import qrcode from 'https://esm.sh/qrcode-generator@1.4.4';   // QR rendering for share URLs
import LZString from 'https://esm.sh/lz-string@1.5.0';        // compress game state for URLs
```

HTM gives JSX-like syntax via tagged template literals — no build step, no transpiler. Attributes follow HTML conventions (`class`, not `className`).

The file is ~195 KB; ~140 KB of that is the embedded word lists. First load fetches ~25 KB of Preact + HTM + qrcode + LZ-string from the CDN (then browser-cached).

The state machine lives in a single `useReducer` at the top of the `App` component. Every screen transition is a named action; the reducer is the source of truth. Components are pure functions of `(state, dispatch)`.

---

## Word Lists

Two lists are embedded as JS constants:

- **`ANSWERS`** (~3,082 words): The pool of possible solutions. Filtered to Zipf frequency ≥ 2.5 with bare plurals of 4-letter words removed (e.g. "crabs", "plans", "taxes" are excluded as answers but legal to guess).
- **`VALID_GUESSES_EXTRA`** (~12,653 words): All five-letter English words. Obscure words like "aahed" are legal guesses but will never be answers.
- **`ALL_VALID`**: A `Set` of both combined, used for guess validation.

To regenerate the word lists (not normally needed):
```bash
cd /tmp && npm install an-array-of-english-words
pip install wordfreq --break-system-packages
# then run the generation script from the original session
```

---

## Auth

Client-side password gate using the Web Crypto API. No server involved.

- **Salt** (baked into HTML): `2887189806cd0b6d11cfb3dab14548c1933e1205f23456f6bafeea6b52e5dbc0`
- **Expected hash** (`AUTH_HASH`): SHA-256 of `salt + password`, hex-encoded
- **Storage**: `localStorage` key `_wpa` — shared across all tabs/windows of the same origin
- **TTL**: 365 days, slid forward on each App mount via `writeAuth()`. An active user effectively never expires; an inactive user is kicked to login after a year.
- **Auth state** lives outside the reducer (separate `useState` in `App`) so it isn't part of the saved game state
- **Logout**: `clearAuth()` + `clearSaves()` removes `_wpa`, `_tw_games_v1`, `_tw_meta_v1`, and the legacy `_tw_save_v2` if it's still around. Then dispatches `RESET`.

To change the password, generate a new hash:
```python
import hashlib
salt = "2887189806cd0b6d11cfb3dab14548c1933e1205f23456f6bafeea6b52e5dbc0"
print(hashlib.sha256((salt + "new-password").encode()).hexdigest())
```
Then update `AUTH_HASH` in `index.html`.

---

## Game Modes

### Solo
Standard Wordle: 6 attempts, random word from `ANSWERS`. After the game ends, a summary screen shows the word, guess count, and a comment. From there the player can start a new game or return to the home screen.

### 2-Player ("Twordle")
Fixed 3-round match. Two delivery modes share **identical scoring and win conditions** — they only differ in how the device "passes" between players.

**Win conditions** (checked after each complete round, same in both modes):
- If one player solved their word and the other didn't → winner declared immediately, no more rounds
- If both solved or both stumped → tie that round, continue
- After all 3 rounds with no asymmetric stumping → compare **total guess counts** (lower wins)
- Equal total guesses → **tie** (the intended outcome is trash talk and a rematch)

Stumped players count as 6 guesses for the tiebreaker.

#### Pass-and-Play (mode `'l'`)

In-person on one shared device. Each "handoff" is a physical pass.

1. **Setup**: Enter both player names (Player 1 = device-holder/initiator, Player 2 = opponent)
2. **Mode chooser**: Pick Pass & Play (vs Remote)
3. **Word entry — Player 1 (initiator)**: Enters 3 secret words for Player 2 to guess. Words must be in `ANSWERS`. Inputs are masked (password type) with an eye toggle. All 3 must be different.
4. **Handoff**: Pass device to Player 2
5. **Word entry — Player 2**: Enters 3 words for Player 1
6. **Handoff**: Pass device back to Player 1 to start Round 1
7. **Each round**: Player 1 guesses → handoff → Player 2 guesses → round evaluated → handoff to Player 1 for next round → …

#### Remote (mode `'r'`)

Asynchronous, one device per player. Every device-handoff in pass-and-play becomes a URL share moment — the initiator and opponent send the same link (with the encoded game state in the URL hash) back and forth via WhatsApp / iMessage / SMS / AirDrop / QR. Each player accumulates their active games on the home screen in an active-games list.

The entry flow is the same as Pass-and-Play through the mode chooser; picking Remote just switches the placeholder game's `mode` to `'r'` and routes word entry through a share screen instead of an on-device handoff. On receipt the opponent's app decodes the URL, drops the entry into their on-disk games dict, and lands them on the right next-step screen (accept-challenge, game, round-summary, or game-over). See "Remote 2-player mode" below for the exact turn sequence and the `advanceRemoteAfterTurn` logic.

---

## State Shape

The reducer state is **pointer + dict**: one `currentGameId` and a `games` map keyed by id.

```js
{
  screen: 'home' | 'setup' | 'mode-chooser' | 'accept-challenge'
        | 'word-entry' | 'handoff' | 'share'
        | 'game' | 'solo-summary' | 'round-summary' | 'game-over',
  currentGameId: null | string,
  games: { [gameId]: Game },
  // transient UI (never persisted, never encoded):
  handoff: { badge, icon, title, desc, btnText, next } | null,
  pendingContinue: false,
  revealing: false,
  ui: { errorTick, errorMsg },
}

// Game (encodable):
{
  id, mode,                                // mode: 's' solo · 'l' local-2p · 'r' remote
  players: [p1, p2],
  challengeFor: [[w0,w1,w2], [w0,w1,w2]],  // [guesserIdx][roundIdx]
  results: [[r,r],[r,r],[r,r]],            // [roundIdx][playerIdx]
  round, turn, wordEntryPhase,
  target, guesses[], scores[][], current, over, won,
  turnFor, turnCounter,                    // remote-only
  myRole,                                  // per-device (0|1); stored in disk wrapper, NOT encoded
  _lastUpdate,                             // transient: sort key for the active-games list
}
```

Components read the active game via `getCurrentGame(state)`; reducer actions mutate it via `withCurrentGame(state, update)`. Summary screens (`SoloSummary`, `GameOver`, `RoundSummary`) compute their display data from the game directly — no separate state slices.

**Why validation lives in the reducer, not the Game component**: rapid keystrokes (typing the 5th letter and hitting Enter back-to-back) batch into one render cycle. A component-side validator reads `current` from a stale closure and rejects the guess. The reducer sees each dispatch's updated state, so `SUBMIT_GUESS` always validates against the latest `current`.

---

## Game encoding

`encodeGame(game) → LZ-string compressed JSON` is the **shared serialization** used both for the URL hash (remote shares) and for each entry in the on-disk games dict. Short keys, single-char score codes (`'a'`/`'p'`/`'c'`). Versioned via `v: 1`. The output of `LZString.compressToEncodedURIComponent` is already URL-component-safe — no separate base64 step needed.

`decodeGame` dual-decodes: tries the current LZ-string format first, falls back to the legacy plain `base64url(JSON)` format used in earlier versions so URLs and saves from before this commit still work. Typical URL payload sizes: ~217 chars (LZ) vs ~290 chars (legacy base64url) on a fresh challenge — about 25% smaller, with bigger savings on filled-out mid-game states. Real practical win is denser → sparser QR codes that scan better in poor lighting.

## Remote 2-player mode (mode `'r'`)

Same per-game shape as local 2P, but each device-handoff is replaced by sharing a URL. URL format: `<base>#r:<encodedGame>`. The hash is read once on App mount (after auth), dispatched as `LOAD_FROM_URL`, then stripped via `history.replaceState`.

Turn order (initiator = P1, plays first):
1. P1 enters both names → ModeChooser → picks Remote → WordEntry → enters 3 secret words for P2 → `WORD_ENTRY_DONE` for mode `'r'` → ShareScreen
2. P2 opens link → AcceptChallenge → enters their 3 words → `REMOTE_ACCEPT_DONE` → ShareScreen (sends back)
3. P1 opens link → game R1 → plays → `REVEAL_DONE` advances state for P2 → ShareScreen
4. P2 opens link → game R1 → plays → both rounds done, eval determines next → ShareScreen
5. … alternates through R2, R3 → game-over

`advanceRemoteAfterTurn(g, results, justWon)` computes the state updates that position the URL recipient *exactly* at the right step (their target, their turn). If P1 just played, swap to P2's turn for the same round. If P2 just played and round eval continues, advance to next round at P1's turn 0. If asymmetric stump or last round, mark over.

`turnFor` indicates which player the URL is meant for; `turnCounter` is a monotonic per-game counter (Phase 2 stores it but doesn't yet enforce divergence detection — see open work below).

### Open work / known gaps (deferred)

- **No "this link is stale" detection.** A receiver opening an older link silently overwrites their state.
- **No anti-peek for secret words.** A curious opponent can `atob()` the hash and see upcoming words.

## myRole (per-device perspective)

Each device tags every game with a `myRole` (0 or 1) — "which player am I in this match." Stored in the on-disk wrapper (`_tw_games_v1` entry → `myRole` field) alongside `savedAt`, **not** in the encoded game itself (each device has its own perspective; the URL shouldn't carry it). Set on game creation (initiator = 0) or first URL receipt (= `turnFor` at receive time).

Used by the active-games list to label `Your turn` vs `Waiting on Bob`, and by `RESUME_GAME` to pick the right screen.

## Active games list

Rendered on `Home` below the main buttons via the `ActiveGames` component. Shows every entry in the `games` dict that has a meaningful next step (blank/never-played solos are filtered). Each row:

- **Tap** → `RESUME_GAME({gameId})` — picks the right screen by mode and state (own turn → game/accept-challenge; waiting → share; over → game-over).
- **× button** → `DISMISS_GAME({gameId})` after a confirm prompt — manual cleanup (the 7-day TTL handles abandoned ones automatically).

Status labels are computed by `describeGame(g)`:

| Mode | State | Label |
|---|---|---|
| `s` | in-progress | "N/6 guesses" |
| `s` | over | "Solved" / "Stumped" |
| `l` | setup | "Setup in progress" |
| `l` | playing | "Round N of 3" |
| `r` | new challenge to me | "Accept the challenge" |
| `r` | my turn | "Your turn · Round N" |
| `r` | their turn | "Waiting on Bob" |
| `r` | over | "Match over" |

## Sharing UX

`ShareScreen` offers three ways to hand off the share URL:

1. **Web Share API** — `navigator.share({url, text, title})` opens the system share sheet (iOS/Android, macOS Safari). Feature-detected via `navigator.share` and `navigator.canShare({url, text})`; when available it's the primary green button. When unavailable (most desktop browsers), it's hidden entirely.
2. **Copy Link** — `navigator.clipboard.writeText(url)` plus a brief "Copied! ✓" state. Always shown. The URL text box is also tap-to-copy.
3. **QR code** — a "Show QR Code" toggle reveals an inline SVG QR generated by `qrcode-generator`. Single `<path>` with one `M-h-v-h-z` segment per dark module — fast to render, sharp at any size, on a white background so cameras pick it up against any UI theme. Useful for in-person handoff when you don't want to thumb a URL — Bali poolside scenario.

The encoded payload runs through LZ-string before going into the URL hash, which keeps the QR sparse enough to scan reliably even on a phone screen.

---

## Game State Persistence

Two `localStorage` keys:

- `_tw_games_v1`: `{ [gameId]: { value: <encoded>, savedAt } }` — the games dict. Each entry has its own TTL (7 days), so games age out independently.
- `_tw_meta_v1`: `{ currentGameId, screen }` — the "where am I" pointer (also TTL-wrapped).

State is saved on every reducer change via one `useEffect([state])` that calls `saveState(state)` → `writeGames` + `writeMeta`. Transient screens (`setup`, `word-entry`, `handoff`) fall back to `home` on rehydrate. `revealing` and `ui.errorTick` reset. Saved state is cleared on logout.

A finished game (`solo-summary` / `game-over`) is dropped from the dict when the user leaves it via Menu / Play Again / Change Mode — no UI path leads back into a finished game anyway. Blank solo games (started but never guessed) are also dropped on `GO_HOME`. Other in-progress games stay in the dict and surface in the active-games list on Home.

Legacy `_tw_save_v2` is migrated once on first boot of this version: its single state is decoded, converted into a new game entry, and the old key is removed.

Handoff `next` is stored as `{type: 'START_TURN', round, player}` (data, not a function) so the whole reducer state remains JSON-serializable.

---

## Components

| Component | Renders for screen | Notes |
|---|---|---|
| `App` | (root) | Manages auth state separately; loads/persists reducer state; parses incoming share URLs from `location.hash` |
| `Login` | (auth gate) | SHA-256 check via Web Crypto |
| `Home` | `home` | Mode selection + logout + active-games list |
| `Setup` | `setup` | 2-player name entry (step 1 of unified 2P entry flow) |
| `ModeChooser` | `mode-chooser` | Step 2 of 2P entry: pick Pass & Play vs Remote |
| `AcceptChallenge` | `accept-challenge` | Opponent's first turn after opening a fresh challenge link: enters 3 words, sends back |
| `WordEntry` | `word-entry` | 3 masked inputs, eye toggle per row (pass-and-play word entry) |
| `Handoff` | `handoff` | Reads `state.handoff.next` and dispatches it on click (pass-and-play only) |
| `ShareScreen` | `share` | URL + QR + Copy Link + (when available) Web Share API. Replaces `Handoff` for remote mode |
| `Game` | `game` | Board + keyboard. Owns reveal animation timing, dispatches `REVEAL_DONE` |
| `SoloSummary` | `solo-summary` | Result + word + Play Again / Change Mode + 2-Player CTA |
| `RoundSummary` | `round-summary` | Scoreboard. Local-2P button advances to handoff; remote-sender button advances to share; remote-receiver button advances to next round |
| `GameOver` | `game-over` | Stump / guess-total / tie outcome + final scoreboard |
| `Scoreboard` | (shared) | Used by RoundSummary and GameOver |
| `TopBar` | (shared) | Unified header on every screen except `login` & `home`. Owns the menu/home button. |
| `ActiveGames` | (shared, on Home) | List of in-progress games sorted by most recent activity; tap to resume, × to dismiss |

### TopBar and the menu confirmation rule

`TopBar` props: `state`, `dispatch`, optional `title`, `badge` (chip), `meta` (plain text under title), `right` (action node, e.g. solo's New Game). It renders a `⌂ Menu` button on the left that always goes home — but confirms first if a 2-player match is in progress.

"In progress" = `isInProgressMatch(state)`: `getCurrentGame(state)` exists, its `mode` is `'l'` or `'r'`, `players[0]` is set, and `screen !== 'game-over'`. That covers word-entry, accept-challenge, handoff, share, game (2P), and round-summary — every screen where bailing out would discard a live match. Pass-and-play setup is in 2P mode but `players[0]` is empty until SETUP_DONE creates the game, so it skips the confirm. Remote setup never has a current game yet, so it also skips. Game-over and solo-summary skip it because the match (or solo round) is already done.

---

## Reveal Animation

The reducer marks `state.revealing = true` when a guess is submitted. The `Game` component watches `guesses.length` and schedules:

1. Per-tile flips with a 300 ms stagger (CSS `animation-delay` driven by local `revealedCols` counter)
2. After the full reveal:
   - **Win (solo)**: toast a praise message, then `REVEAL_DONE` after 2.4 s (so the bounce animation can play)
   - **Win (2-player, both local & remote)**: toast + immediate `REVEAL_DONE`
   - **Loss (solo)**: toast the answer, then `REVEAL_DONE` after 3.6 s
   - **Loss (2-player, both local & remote)**: toast + immediate `REVEAL_DONE`
   - **Mid-game**: `REVEAL_DONE` right after the animation

`REVEAL_DONE` clears `revealing`, sets `over`/`won`, and routes by mode:
- **Solo**: transition to `solo-summary`.
- **Local 2P**: set `pendingContinue` (game screen shows a Continue overlay after a 1.8 s delay).
- **Remote 2P**: compute the next-player state via `advanceRemoteAfterTurn`, then go to `share` — or to `round-summary` first if both players just finished a round and round eval says continue.

---

## Mobile / Responsive

- Viewport meta includes `user-scalable=no, maximum-scale=1` to prevent double-tap zoom
- `touch-action: manipulation` on all keys and buttons to kill the 300 ms tap delay
- `overflow: hidden` + `overscroll-behavior: none` on html/body — keeps the game screen pinned (no rubber-banding while playing)
- **Scrollable non-game screens.** Because the body is `overflow: hidden`, every screen whose content can grow taller than the viewport (`#s-setup`, `#s-remote-setup`, `#s-accept-challenge`, `#s-word-entry`, `#s-home`, `#s-share`, `#s-handoff`, `#s-round-summary`, `#s-game-over`, `#s-solo-summary`) gets `height: 100dvh; overflow-y: auto` so it scrolls internally. The inner body containers use `justify-content: safe center` — short content vertically centers, overflowing content pins to flex-start so the top header and bottom action button are both reachable.
- `min-height: 100dvh` on `#s-game` to account for Safari browser chrome
- Tile size uses `clamp(44px, calc((100vw - 52px) / 5), 62px)` — scales on narrow screens
- Keyboard uses `flex: 1` keys with 2px side padding so keys fill the viewport width
- Keyboard layout is 3 rows: QWERTYUIOP / ASDFGHJKL / Enter · ZXCVBNM · ⌫ (action keys are 1.5× a letter key, via `.key.wide`)

---

## Deployment

GitHub Pages, served from the `main` branch root. After any change to `index.html`:

```bash
git add . && git commit -m "description" && git push
```

Pages redeploys automatically within ~60 seconds.

---

## Local development

`index.html` runs from the filesystem in any modern browser, but ES module imports require an HTTP origin. Serve it locally with:

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

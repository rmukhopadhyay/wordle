# Twordle

A two-player Wordle clone, playable in any browser — desktop or mobile. Single self-contained HTML file, no build step, no server, deployed via GitHub Pages.

**Live URL:** https://rmukhopadhyay.github.io/twordle  
**Repo:** https://github.com/rmukhopadhyay/twordle

---

## Architecture

Everything lives in `index.html` — HTML, CSS, and a single `<script type="module">` in one file. UI is built with **Preact + HTM**, loaded from `esm.sh` at runtime:

```js
import { h, render } from 'https://esm.sh/preact@10.22.0';
import { useReducer, useEffect, useState, useRef, useCallback, useMemo } from 'https://esm.sh/preact@10.22.0/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
```

HTM gives JSX-like syntax via tagged template literals — no build step, no transpiler. Attributes follow HTML conventions (`class`, not `className`).

The file is ~192 KB; ~140 KB of that is the embedded word lists. First load fetches ~10 KB of Preact + HTM from the CDN (then browser-cached).

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
- **Logout**: Clears both `_wpa` and `_tw_save_v2` from localStorage, dispatches `RESET`

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
Fixed 3-round match. Full flow:

1. **Setup**: Enter player names (Player 1, Player 2)
2. **Word entry — Player 2**: Enters 3 secret words (one per round) for Player 1 to guess. Words must be in `ANSWERS`. Inputs are masked (password type) with an eye toggle. All 3 must be different.
3. **Handoff**: Pass device to Player 1
4. **Word entry — Player 1**: Same, enters 3 words for Player 2
5. **Handoff**: Pass device to Player 1 to start Round 1

**Each round**: Player 1 guesses → handoff → Player 2 guesses → round evaluated

**Win conditions** (checked after each complete round):
- If one player solved their word and the other didn't → winner declared immediately, no more rounds
- If both solved or both stumped → tie that round, continue
- After all 3 rounds with no asymmetric stumping → compare **total guess counts** (lower wins)
- Equal total guesses → **tie** (the intended outcome is trash talk and a rematch)

Stumped players count as 6 guesses for the tiebreaker.

---

## State Shape

The reducer state is **pointer + dict**: one `currentGameId` and a `games` map keyed by id.

```js
{
  screen: 'home' | 'setup' | 'word-entry' | 'handoff' | 'game' | 'solo-summary' | 'round-summary' | 'game-over',
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
  turnFor, turnCounter,                    // remote-only (Phase 2)
}
```

Components read the active game via `getCurrentGame(state)`; reducer actions mutate it via `withCurrentGame(state, update)`. Summary screens (`SoloSummary`, `GameOver`, `RoundSummary`) compute their display data from the game directly — no separate state slices.

**Why validation lives in the reducer, not the Game component**: rapid keystrokes (typing the 5th letter and hitting Enter back-to-back) batch into one render cycle. A component-side validator reads `current` from a stale closure and rejects the guess. The reducer sees each dispatch's updated state, so `SUBMIT_GUESS` always validates against the latest `current`.

---

## Game encoding

`encodeGame(game) → base64url(JSON)` is the **shared serialization** used both for the URL hash (remote shares) and for each entry in the on-disk games dict. Short keys, single-char score codes (`'a'`/`'p'`/`'c'`). Versioned via `v: 1`.

## Remote 2-player mode (mode `'r'`)

Same per-game shape as local 2P, but each device-handoff is replaced by sharing a URL. URL format: `<base>#r:<encodedGame>`. The hash is read once on App mount (after auth), dispatched as `LOAD_FROM_URL`, then stripped via `history.replaceState`.

Turn order (initiator = P1, plays first):
1. P1 enters their name, opponent name, and 3 secret words → `REMOTE_SETUP_DONE` → ShareScreen
2. P2 opens link → AcceptChallenge → enters their 3 words → `REMOTE_ACCEPT_DONE` → ShareScreen (sends back)
3. P1 opens link → game R1 → plays → `REVEAL_DONE` advances state for P2 → ShareScreen
4. P2 opens link → game R1 → plays → both rounds done, eval determines next → ShareScreen
5. … alternates through R2, R3 → game-over

`advanceRemoteAfterTurn(g, results, justWon)` computes the state updates that position the URL recipient *exactly* at the right step (their target, their turn). If P1 just played, swap to P2's turn for the same round. If P2 just played and round eval continues, advance to next round at P1's turn 0. If asymmetric stump or last round, mark over.

`turnFor` indicates which player the URL is meant for; `turnCounter` is a monotonic per-game counter (Phase 2 stores it but doesn't yet enforce divergence detection — see open work below).

### Open work / known gaps (deferred)

- **No round-summary interstitial in remote.** After a tied/continued round, the receiver lands directly on their next round; they don't see a scoreboard for the just-completed round.
- **No "this link is stale" detection.** A receiver opening an older link silently overwrites their state.
- **No way to re-surface the share URL after navigating home.** Phase 3's active-games list is intended to cover this.
- **No anti-peek for secret words.** A curious opponent can `atob()` the hash and see upcoming words.

---

## Game State Persistence

Two `localStorage` keys:

- `_tw_games_v1`: `{ [gameId]: { value: <encoded>, savedAt } }` — the games dict. Each entry has its own TTL (7 days), so games age out independently.
- `_tw_meta_v1`: `{ currentGameId, screen }` — the "where am I" pointer (also TTL-wrapped).

State is saved on every reducer change via one `useEffect([state])` that calls `saveState(state)` → `writeGames` + `writeMeta`. Transient screens (`setup`, `word-entry`, `handoff`) fall back to `home` on rehydrate. `revealing` and `ui.errorTick` reset. Saved state is cleared on logout.

A finished game (`solo-summary` / `game-over`) is dropped from the dict when the user leaves it via Menu / Play Again / Change Mode — no UI path leads back into a finished game anyway. Blank solo games (started but never guessed) are also dropped on `GO_HOME`. Other in-progress games stay in the dict and will surface in the active-games list once Phase 2 ships.

Legacy `_tw_save_v2` is migrated once on first boot of this version: its single state is decoded, converted into a new game entry, and the old key is removed.

Handoff `next` is stored as `{type: 'START_TURN', round, player}` (data, not a function) so the whole reducer state remains JSON-serializable.

---

## Components

| Component | Renders for screen | Notes |
|---|---|---|
| `App` | (root) | Manages auth state separately; loads/persists reducer state |
| `Login` | (auth gate) | SHA-256 check via Web Crypto |
| `Home` | `home` | Mode selection + logout |
| `Setup` | `setup` | 2-player name entry |
| `WordEntry` | `word-entry` | 3 masked inputs, eye toggle per row |
| `Handoff` | `handoff` | Reads `state.handoff.next` and dispatches it on click |
| `Game` | `game` | Board + keyboard. Owns reveal animation timing, dispatches `REVEAL_DONE` |
| `SoloSummary` | `solo-summary` | Result + word + Play Again / Change Mode |
| `RoundSummary` | `round-summary` | Scoreboard + next-round handoff trigger |
| `GameOver` | `game-over` | Stump / guess-total / tie outcome + final scoreboard |
| `Scoreboard` | (shared) | Used by RoundSummary and GameOver |
| `TopBar` | (shared) | Unified header on every screen except `login` & `home`. Owns the menu/home button. |

### TopBar and the menu confirmation rule

`TopBar` props: `state`, `dispatch`, optional `title`, `badge` (chip), `meta` (plain text under title), `right` (action node, e.g. solo's New Game). It renders a `⌂ Menu` button on the left that always goes home — but confirms first if a 2-player match is in progress.

"In progress" = `isInProgressMatch(state)`: `mode === '2player'` AND `tp.players[0] !== ''` AND `screen !== 'game-over'`. That covers word-entry, handoff, game (2P), and round-summary — every screen where bailing out would discard a live match. Setup is in 2P mode but `players[0]` is empty until SETUP_DONE, so it skips the confirm. Game-over and solo-summary skip it because the match (or solo round) is already done.

---

## Reveal Animation

The reducer marks `game.revealing = true` when a guess is submitted. The `Game` component watches `guesses.length` and schedules:

1. Per-tile flips with a 300 ms stagger (CSS `animation-delay` driven by local `revealedCols` counter)
2. After the full reveal:
   - **Win (solo)**: toast a praise message, then `REVEAL_DONE` after 2.4 s (so the bounce animation can play)
   - **Win (2-player)**: toast + immediate `REVEAL_DONE` (Continue overlay handles its own 1.8 s delay)
   - **Loss (solo)**: toast the answer, then `REVEAL_DONE` after 3.6 s
   - **Loss (2-player)**: toast + immediate `REVEAL_DONE`
   - **Mid-game**: `REVEAL_DONE` right after the animation

`REVEAL_DONE` clears `revealing`, sets `over`/`won`, and either transitions to `solo-summary` (solo) or sets `pendingContinue` (2-player).

---

## Mobile / Responsive

- Viewport meta includes `user-scalable=no, maximum-scale=1` to prevent double-tap zoom
- `touch-action: manipulation` on all keys and buttons to kill the 300 ms tap delay
- `overflow: hidden` + `overscroll-behavior: none` on html/body to prevent scrolling
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

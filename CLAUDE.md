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
- **Session**: No expiry — persists until explicit logout or localStorage is cleared
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

```js
{
  screen: 'home' | 'setup' | 'word-entry' | 'handoff' | 'game' | 'solo-summary' | 'round-summary' | 'game-over',
  mode: 'solo' | '2player' | null,
  tp: {
    players: [p1, p2],
    challengeFor: [[w0,w1,w2], [w0,w1,w2]],  // [guesserIdx][roundIdx]
    results: [[r,r],[r,r],[r,r]],            // [roundIdx][playerIdx]; r = {solved, guesses} | null
    round: 0, turn: 0, wordEntryPhase: 0,
  },
  game: { target, guesses[], scores[][], current, over, won, revealing },
  handoff: { badge, icon, title, desc, btnText, next } | null,  // next is a data-driven action
  soloSummary: { won, word, guesses } | null,
  gameOver: { type, winnerIdx, roundsPlayed, t0?, t1? } | null,
  roundSummary: { completedRoundIdx } | null,
  pendingContinue: false,        // shows Continue overlay on game screen (2-player)
  ui: { errorTick, errorMsg },   // bumped by reducer when a guess fails validation
}
```

The reducer is pure-ish: `randomTarget()` calls `Math.random()` inside `PICK_SOLO`/`NEW_SOLO_GAME`, which is fine for this app.

**Why validation lives in the reducer, not the Game component**: rapid keystrokes (typing the 5th letter and hitting Enter back-to-back) batch into one render cycle. A component-side validator reads `current` from a stale closure and rejects the guess. The reducer sees each dispatch's updated state, so `SUBMIT_GUESS` always validates against the latest `current`.

---

## Game State Persistence

Uses `localStorage` under key `_tw_save_v2`. The whole reducer state is serialized on every change via `useEffect([state])`.

- Transient screens (`setup`, `word-entry`, `handoff`) fall back to `home` on rehydrate — they reference data flows that don't make sense to resume mid-step.
- `game.revealing` and `ui.errorTick` are reset on rehydrate (they're transient UI flags that shouldn't survive reload).
- Saved state is cleared on logout.

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
- Keyboard layout is 4 rows: QWERTYUIOP / ASDFGHJKL / ZXCVBNM / Enter · ⌫ (Enter and ⌫ in their own row)

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

# Twordle

A two-player Wordle clone, playable in any browser — desktop or mobile. Single self-contained HTML file, no build step, no server, deployed via GitHub Pages.

**Live URL:** https://rmukhopadhyay.github.io/twordle  
**Repo:** https://github.com/rmukhopadhyay/twordle

---

## Architecture

Everything lives in `index.html` — HTML, CSS, and JS in one file, with both word lists baked in as JS arrays. There is no build pipeline and no dependencies at runtime. The word lists were generated once using Node (`an-array-of-english-words` npm package) and Python (`wordfreq` library) and are now static.

The file is ~178 KB, which is acceptable for a PWA-style game.

---

## Word Lists

Two lists are embedded as JS constants:

- **`ANSWERS`** (~3,082 words): The pool of possible solutions. Filtered to Zipf frequency ≥ 2.5 (recognisable English words) with bare plurals of 4-letter words removed (e.g. "crabs", "plans", "taxes" are excluded as answers but legal to guess). Includes words like "scone", "crane", "guile", "tryst".
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
- **Expected hash**: SHA-256 of `salt + password`, hex-encoded
- **Storage**: `localStorage` key `_wpa` — shared across all tabs/windows of the same origin, so logging in once covers all tabs
- **Session**: No expiry — persists until explicit logout or localStorage is cleared
- **Logout**: Clears both `_wpa` from localStorage and `_tw_save` (game state) from sessionStorage

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
Standard Wordle: 6 attempts, random word from `ANSWERS`. After the game ends (win or lose), a summary screen shows the word, guess count, and a comment. From there the player can start a new game or return to the home screen.

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

## Game State Persistence

Uses `sessionStorage` (tab-scoped, survives page reload but not tab close) under key `_tw_save`.

State is saved:
- On every screen transition (`show()` always calls `saveState()`)
- After each letter typed or deleted
- **After reveal animation completes** (inside the `setTimeout` callback in `revealRow`) — this is critical; saving before the callback fires would capture pre-submit state without tile colors

On boot (after auth check), `restoreState()` is attempted before falling back to home. Screens that can't be meaningfully restored (`s-word-entry`, `s-handoff`, `s-setup`) fall back to home. Active game boards, round summaries, and game-over screens restore fully.

Saved state is cleared on logout.

---

## Screens / State Machine

| Screen ID | Description |
|---|---|
| `s-login` | Password gate |
| `s-home` | Mode selection (Solo / 2 Player) |
| `s-setup` | 2-player name entry |
| `s-word-entry` | 2-player word entry (3 inputs, masked) |
| `s-handoff` | Generic "pass the device" screen, reused for all handoffs |
| `s-game` | The Wordle board |
| `s-solo-summary` | Solo end screen (result + word) |
| `s-round-summary` | 2-player between-round scoreboard |
| `s-game-over` | 2-player final result |

`show(id)` is the only function that switches screens. It also calls `saveState()`.

---

## Mobile / Responsive

- Viewport meta includes `user-scalable=no, maximum-scale=1` to prevent double-tap zoom
- `touch-action: manipulation` on all keys and buttons to kill the 300ms tap delay
- `overflow: hidden` + `overscroll-behavior: none` on html/body to prevent scrolling
- `min-height: 100dvh` on `#s-game` to account for Safari browser chrome
- Tile size uses `clamp(44px, calc((100vw - 52px) / 5), 62px)` — scales on narrow screens
- Keyboard uses `flex: 1` keys with 2px side padding so keys fill the viewport width
- Keyboard layout is 4 rows: QWERTYUIOP / ASDFGHJKL / ZXCVBNM / Enter · ⌫ (Enter and ⌫ in their own row)

---

## Deployment

GitHub Pages, served from the `main` branch root. After any change to `index.html`:

```bash
cp /path/to/outputs/index.html ~/rishi/src/twordle/
cd ~/rishi/src/twordle
git add . && git commit -m "description" && git push
```

Pages redeploys automatically within ~60 seconds.

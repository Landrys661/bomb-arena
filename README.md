# 💣 Bomb Arena

A retro, **Bomberman-style real-time multiplayer** arena battler. One shared
vanilla-JS canvas client runs three ways — **web (dev), desktop (Electron), and
mobile (Capacitor)** — all talking to the same authoritative Node + Socket.io
server. No game-logic framework, no bundler, no asset files (all graphics + audio
are generated in code; only the *Press Start 2P* web font is loaded).

- **Server:** Node + Express (serves the client) + Socket.io (rooms, realtime). Authoritative, fixed 30 ticks/sec.
- **Client:** Vanilla JS + HTML5 Canvas. Persistence = `localStorage` only (profile, XP, coins, loadout, cosmetics).
- **Features:** XP/leveling, unlockable loadouts (7 bomb types, 5 abilities, 4 classes), in-match power-ups + curses, 6 distinct themed arenas with hazards, private rooms (personal loadouts + house rules) vs Quick Play (balanced), match-to-3, PWA install.

---

## 1. Run locally (web / dev) — fastest way to test

Requires **Node 18+**.

```bash
npm install
npm start
```

Open **two tabs** at <http://localhost:3000>. In each: pick a name (and a kit via
**LOADOUT & COLLECTION**) → **QUICK PLAY** (or **CREATE ROOM** / **JOIN**) → **READY**.
Two+ ready players starts a match.

**Controls:** Arrows/WASD move · **Space** bomb · **E** ability · **Q** detonate (remote bombs).
Touch devices get an on-screen D-pad + Bomb/Ability/Detonate buttons automatically.

> The **Settings** screen has a **Server URL** field. Leave it blank on the web to
> use the current site. The desktop/mobile apps use it to find your hosted server.

---

## 2. Desktop app (Electron)

Electron wraps the *same* client. By default it **hosts a match locally** (great
for LAN / same-network play — others join at your machine's `IP:3000`); to play on
an internet-hosted server instead, open in-app **Settings → Server URL**.

```bash
npm install            # installs Electron (dev dependency, ~large download)
npm run electron       # run the desktop app (hosts locally by default)
npm run electron:nohost   # run as a pure client (uses the Settings server URL)
```

Build installers:

```bash
npm run dist           # → dist/ : Windows .exe (NSIS), macOS .dmg, or Linux AppImage
```

- **Requirements:** just Node + this repo. Building a **Windows** installer is
  easiest on Windows; a **macOS .dmg** must be built on a Mac.
- **App icon:** `public/icon.svg` is the source art. `electron-builder` wants a
  `.ico` (Windows) / `.icns` (mac); generate them from the SVG (e.g. an icon
  converter) and add `"icon"` paths under `build.win` / `build.mac` in
  `package.json`. Without it you get the default Electron icon (still runnable).

---

## 3. Mobile app (Capacitor)

Capacitor wraps `public/` into native iOS/Android projects that connect to your
**hosted** server. Set the server first so the app knows where to connect:

- Easiest: open the app → **Settings → Server URL** → paste your hosted URL.
- Or bake a default: set `DEFAULT_SERVER_URL` at the top of
  [`public/client.js`](public/client.js) to your hosted URL before building.

```bash
npm install
npx cap init "Bomb Arena" com.bombarena.app --web-dir=public   # already configured in capacitor.config.json
npm run cap:add:android      # creates android/  (needs Android Studio)
npm run cap:add:ios          # creates ios/      (needs macOS + Xcode)
npm run cap:sync             # copy web assets + plugins into native projects
npm run cap:open:android     # open in Android Studio → Run / build APK
npm run cap:open:ios         # open in Xcode → Run / Archive
```

- **Android:** needs **Android Studio** (SDK + an emulator or a device).
- **iOS:** needs a **Mac + Xcode + an Apple Developer account** to run on a device
  or submit to the App Store. This **cannot be built on Windows.**
- Orientation is requested as **landscape** (PWA manifest + a runtime lock); for a
  hard lock, set it in the generated native projects (AndroidManifest /
  Info.plist). Safe-area insets are handled in CSS.

> Prefer not to build native? The web app is already an **installable PWA** — open
> the hosted URL on your phone and "Add to Home Screen" / "Install app" for a
> fullscreen home-screen app (see §5).

---

## 4. Host the server online (required for internet play)

The server reads `process.env.PORT` (fallback 3000) and supports WebSockets, so it
runs on any Node host. This repo includes a **Render blueprint** (`render.yaml`).

**Render (free):**
1. Push this repo to GitHub.
2. On <https://render.com> → **New + → Blueprint** → pick the repo → **Apply**.
   (The blueprint sets build `npm install --omit=dev` and start `npm start`.)
3. You get a permanent URL like `https://bomb-arena-xxxx.onrender.com`.

Put that URL in the apps' **Settings → Server URL** (or `DEFAULT_SERVER_URL`).

> Free tier sleeps after ~15 min idle; the first visit then waits ~30–60s to wake.
> State is in-memory by design, so a restart/redeploy clears active rooms.
> **LAN play needs no hosting** — the Electron app hosts locally.

---

## 5. Install as a phone app (PWA, no native build)

With the server hosted, open the URL on your phone:
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** **Install app** button, or ⋮ menu → **Install app**.

Launches fullscreen in landscape.

---

## Project structure

```
server.js              Express + Socket.io, authoritative sim, arenas, match flow
public/index.html      screens: landing, settings, collection, lobby, game
public/client.js       rendering, input, sockets, profile, themes, PWA
public/shared.js       loadout catalog + XP curve (shared by server & client)
public/style.css       retro styling, CRT overlay, mobile/touch, safe-area
public/manifest.webmanifest, sw.js, icon.svg   PWA
electron/main.js       desktop wrapper (host-locally / join)
capacitor.config.json  mobile wrapper config
render.yaml            one-click server deploy
```

---

## Networking protocol (summary)

**Client → Server:** `joinRoom`, `quickPlay`, `setLoadout`, `setReady`,
`setArena`, `setHouseRule`, `input {dir}`, `placeBomb`, `useAbility`,
`detonate`, `leaveRoom`.
**Server → Client:** `roomState`, `gameStart`, `state` (per tick), `roundOver`,
`matchOver`, `errorMsg`.

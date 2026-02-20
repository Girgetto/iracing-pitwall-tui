# iRacing Live Telemetry

A terminal-based live timing display for iRacing. Reads directly from the iRacing shared memory file and renders a colour-coded leaderboard that refreshes every 500 ms — no browser, no extra software, just a terminal.

## Requirements

- **Windows** (iRacing only runs on Windows)
- **Node.js** >= 14
- **iRacing** running on the same machine

## Installation

```bash
npm install
```

## Usage

```bash
node index.js
# or
npm start
```

Leave it running in a terminal alongside iRacing. It will automatically connect when a session loads and disconnect gracefully when iRacing closes.

## How it works

iRacing exposes its internal state through a Windows Memory Mapped File (`Local\IRSDKMemMapFileName`). The file has two sections:

| Section | Update rate | Contents |
|---|---|---|
| Telemetry variables | up to 60 Hz | Per-car numeric arrays (position, lap times, track %, flags, …) |
| Session info YAML | On change | Driver names, car numbers, class info, lap/time limits |

[iracing-sdk-js](https://github.com/friss/iracing-sdk-js) wraps the native read via a compiled C++ addon and emits Node.js events, so the app never touches the binary layout directly.

## Display

### Waiting screen

Shown when iRacing is not running or no session is loaded:

```
  iRacing Live Telemetry  v1.0
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

  Waiting for iRacing...

  • Start iRacing and load into a session.
  • This app reads from the Windows shared memory file
    (Local\IRSDKMemMapFileName) via iracing-sdk-js.

  Press Ctrl+C to exit.
```

### Live leaderboard

Shown once a session is active. The screen redraws in place every 500 ms with no flicker.

```
  iRacing Live Telemetry
  🟢  GREEN FLAG
  Session: Race   Lap: 12 / 30   Time remaining: N/A   Cars: 20
  ────────────────────────────────────────────────────────────────────────────────────────────────────
┌─────┬──────┬──────┬────────────────────────┬─────────┬───────┬────────────┬────────────┬─────────────┬──────────────┐
│ Pos │  Cls │    # │ Driver                 │ Class   │  Laps │   Last Lap │   Best Lap │         Gap │      Track % │
├─────┼──────┼──────┼────────────────────────┼─────────┼───────┼────────────┼────────────┼─────────────┼──────────────┤
│  P1 │   P1 │  #23 │ Lorenzo Ricci          │ GTP     │    12 │   1:42.318 │   1:41.905 │      Leader │ ██████  98%  │
│  P2 │   P2 │  #7  │ Marco Bianchi          │ GTP     │    12 │   1:42.751 │   1:42.104 │     +1.847s │ █████░  84%  │
│  P3 │   P3 │  #44 │ Sofia Esposito         │ GTP     │    12 │   1:43.120 │   1:42.390 │     +4.213s │ ████░░  71%  │
│  P4 │   P1 │  #88 │ James Carter           │ LMP2    │    12 │   1:48.654 │   1:48.201 │     +9.560s │ ████░░  67%  │
│  P5 │   P4 │  #12 │ Yuki Tanaka            │ GTP     │    11 │   1:43.882 │   1:43.015 │    +14.002s │ ███░░░  52%  │
│  P6 │   P2 │  #31 │ Emily Müller           │ LMP2    │    11 │   1:49.340 │   1:48.890 │    +21.774s │ ██░░░░  38%  │
│  P7 │   P5 │  #5  │ Alex Novak             │ GTP     │    11 │   1:44.210 │   1:43.740 │    +28.119s │ █░░░░░  19%  │
│  P8 │   P3 │  #19 │ Claire Dupont          │ LMP2    │    10 │   1:50.001 │   1:49.410 │         +1L │ ███░░░  55%  │
└─────┴──────┴──────┴────────────────────────┴─────────┴───────┴────────────┴────────────┴─────────────┴──────────────┘
  Updated: 15:42:07   Press Ctrl+C to exit.
```

### Columns

| Column | Description |
|---|---|
| **Pos** | Overall race position. Green = P1, cyan = P2, yellow = P3 |
| **Cls** | Position within the car's class |
| **#** | Car number |
| **Driver** | Driver name. Shown in red if the car appears stalled on track |
| **Class** | Short car class name (GTP, LMP2, GT3, …) |
| **Laps** | Laps completed |
| **Last Lap** | Last completed lap time (`M:SS.mmm`). `--:--.---` if no lap completed yet |
| **Best Lap** | Personal best lap time for this session |
| **Gap** | Time behind the leader. `+NL` if lapped |
| **Track %** | Visual progress bar showing how far through the current lap the car is |

### Flag banners

A coloured banner appears in the header whenever a session flag is active:

| Flag | Banner |
|---|---|
| Green / Start | `🟢  GREEN FLAG` |
| White (last lap) | `🏳  WHITE FLAG – FINAL LAP` |
| Yellow / Caution | `⚠   CAUTION / YELLOW FLAG  ⚠` |
| Red | `🔴  RED FLAG – SESSION STOPPED` |
| Checkered | `🏁  CHECKERED FLAG` |

## Session type support

| Session | Positions | Sort order |
|---|---|---|
| Race | From `CarIdxPosition` | Race position |
| Practice / Qualify / Test | Not assigned (all 0) | Laps completed + track % (furthest ahead first) |

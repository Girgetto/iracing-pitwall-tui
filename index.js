'use strict';

/**
 * iRacing Live Telemetry Display
 *
 * HOW THE SHARED MEMORY CONNECTION WORKS:
 * ----------------------------------------
 * iRacing exposes its internal state through a Windows Memory Mapped File
 * (MMAP) named "Local\IRSDKMemMapFileName". Any process on the same machine
 * can open and read this region without needing to inject into iRacing.
 *
 * The MMAP contains two distinct sections:
 *   1. Telemetry variables  – updated at up to 60 Hz; numeric arrays keyed
 *      by "CarIdx" (car index) give per-car data for every car on track.
 *   2. Session info YAML    – a large YAML blob updated whenever session
 *      state changes (driver joins, session advances, etc.). Contains names,
 *      car numbers, class info, and lap/time limits.
 *
 * iracing-sdk-js wraps the native MMAP read via a compiled C++ addon,
 * polls on a configurable interval, and emits Node EventEmitter events so
 * we never have to touch the binary layout ourselves.
 */

const irsdk  = require('iracing-sdk-js');
const Table  = require('cli-table3');
const chalk  = require('chalk');

// ─── State ────────────────────────────────────────────────────────────────────

let currentTelemetry  = null;  // Latest snapshot from the MMAP telemetry section
let currentSessionInfo = null; // Latest parsed session info YAML
let isConnected        = false;
let dotCount           = 0;    // Animated waiting indicator

// ─── iRacing Session Flag Bitmask Values ──────────────────────────────────────
// The `SessionFlags` telemetry variable is a 32-bit integer where each bit
// represents a specific flag condition.  These values match the irsdk_Flags
// enum from the official iRacing SDK header (irsdk_defines.h).

const FLAGS = {
  checkered:     0x00000001,
  white:         0x00000002,  // Last lap
  green:         0x00000004,
  yellow:        0x00000008,  // Yellow flag out
  red:           0x00000010,
  blue:          0x00000020,  // Blue flag (being lapped)
  debris:        0x00000040,
  yellowWaving:  0x00000100,  // Yellow flag waving
  oneLapToGreen: 0x00000200,
  greenHeld:     0x00000400,
  tenToGo:       0x00000800,
  fiveToGo:      0x00001000,
  caution:       0x00004000,  // Full-course caution
  cautionWaving: 0x00008000,
  startReady:    0x20000000,
  startGo:       0x80000000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format seconds → "M:SS.mmm". Negative / sentinel values display as dashes. */
function formatTime(seconds) {
  if (seconds == null || seconds < 0) return chalk.gray('--:--.---');
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${mins}:${secs}`;
}

/**
 * Format the gap to the leader.
 * CarIdxF2Time holds "time behind leader or car ahead" in seconds.
 * iRacing sets it to a very large value (>= one session-hour) for lapped cars,
 * so we detect that case and show "+N Laps" instead.
 */
function formatGap(gapSeconds, position) {
  if (position <= 1) return chalk.green.bold('Leader');
  if (gapSeconds == null || gapSeconds < 0) return chalk.gray('--');

  // iRacing encodes "lapped by N" as gap ≈ N × 3600 (one artificial hour per lap down)
  if (gapSeconds >= 3600) {
    const lapsDown = Math.round(gapSeconds / 3600);
    return chalk.red(`+${lapsDown}L`);
  }

  if (gapSeconds >= 60) {
    const m = Math.floor(gapSeconds / 60);
    const s = (gapSeconds % 60).toFixed(3).padStart(6, '0');
    return `+${m}:${s}`;
  }

  return `+${gapSeconds.toFixed(3)}s`;
}

/** True when the given flag bit is set in the flags bitmask. */
function hasFlag(flags, bit) {
  return (flags & bit) !== 0;
}

/**
 * Produce a highlighted flag-status string to display in the header.
 * Priority order: checkered → red → caution/yellow → white → green.
 */
function getFlagBanner(flags) {
  if (!flags) return '';
  if (hasFlag(flags, FLAGS.checkered))
    return chalk.bgWhite.black.bold('  🏁  CHECKERED FLAG  ');
  if (hasFlag(flags, FLAGS.red))
    return chalk.bgRed.white.bold('  🔴  RED FLAG – SESSION STOPPED  ');
  if (hasFlag(flags, FLAGS.caution) || hasFlag(flags, FLAGS.cautionWaving) ||
      hasFlag(flags, FLAGS.yellow)  || hasFlag(flags, FLAGS.yellowWaving))
    return chalk.bgYellow.black.bold('  ⚠   CAUTION / YELLOW FLAG  ⚠  ');
  if (hasFlag(flags, FLAGS.oneLapToGreen))
    return chalk.yellow.bold('  One lap to green  ');
  if (hasFlag(flags, FLAGS.white))
    return chalk.white.bold('  🏳  WHITE FLAG – FINAL LAP  ');
  if (hasFlag(flags, FLAGS.green) || hasFlag(flags, FLAGS.startGo))
    return chalk.green.bold('  🟢  GREEN FLAG  ');
  return '';
}

/** Pick a chalk colour function based on overall position. */
function posColor(pos) {
  if (pos === 1) return chalk.green.bold;
  if (pos === 2) return chalk.cyan.bold;
  if (pos === 3) return chalk.yellow.bold;
  return chalk.white;
}

/**
 * Render a compact progress bar showing how far along the current lap a car is.
 * e.g.  "████░░ 72%"
 */
function lapBar(pct) {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled  = Math.round(clamped * 6);
  const bar     = '█'.repeat(filled) + '░'.repeat(6 - filled);
  return `${bar} ${(clamped * 100).toFixed(0).padStart(3)}%`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  // Hide cursor + jump to top-left without blanking the screen first.
  // Writing over existing content and then clearing the tail (ESC[J) avoids
  // the blank-frame flash that ESC[c (full terminal reset) causes.
  process.stdout.write('\x1B[?25l\x1B[H');

  // ── Waiting state ──────────────────────────────────────────────────────────
  if (!isConnected || !currentTelemetry || !currentSessionInfo) {
    const dots = '.'.repeat((dotCount % 3) + 1).padEnd(3, ' ');
    dotCount++;
    console.log(
      chalk.bold.yellow('\n  iRacing Live Telemetry') +
      chalk.gray('  v1.0')
    );
    console.log(chalk.gray('  ─'.repeat(30)));
    console.log(chalk.yellow(`\n  Waiting for iRacing${dots}\n`));
    console.log(chalk.gray('  • Start iRacing and load into a session.'));
    console.log(chalk.gray('  • This app reads from the Windows shared memory file'));
    console.log(chalk.gray('    (Local\\IRSDKMemMapFileName) via iracing-sdk-js.'));
    console.log(chalk.gray('\n  Press Ctrl+C to exit.\n'));
    process.stdout.write('\x1B[J\x1B[?25h');
    return;
  }

  // SDK emits { timestamp, data } for session info and { values } for telemetry.
  // Unwrap both defensively so the rest of the code works regardless of version.
  const tel = currentTelemetry.values
           ?? currentTelemetry.data?.values
           ?? currentTelemetry;
  const si  = currentSessionInfo?.data
           ?? currentSessionInfo;

  // ── Session metadata ───────────────────────────────────────────────────────

  // SessionNum: index of the active session (0=practice, 1=qualify, 2=race, etc.)
  const sessionNum = tel.SessionNum ?? 0;
  const sessions   = si?.SessionInfo?.Sessions ?? [];
  const session    = sessions[sessionNum] ?? sessions[0] ?? {};

  const sessionType = session.SessionType ?? 'Unknown';

  // SessionLaps: lap limit ("unlimited" when iRacing sets it to 32767)
  const totalLaps = (session.SessionLaps && session.SessionLaps !== '32767')
    ? session.SessionLaps
    : '∞';

  // Lap: current lap the player's car is on
  const playerLap = tel.Lap ?? '--';

  // SessionTimeRemain: seconds left in the session.
  // iRacing sets this to 604800 (one week) for non-timed sessions.
  const timeRemain    = tel.SessionTimeRemain;
  const timeRemainStr = (timeRemain && timeRemain < 604800)
    ? formatTime(timeRemain)
    : chalk.gray('N/A');

  // SessionFlags: 32-bit bitmask of active flag conditions
  const sessionFlags = tel.SessionFlags ?? 0;
  const flagBanner   = getFlagBanner(sessionFlags);

  // ── Driver lookup ──────────────────────────────────────────────────────────
  // DriverInfo.Drivers is an array of driver records.  CarIdx is the index
  // that links every telemetry CarIdx* array entry to a specific driver.

  const drivers   = si?.DriverInfo?.Drivers ?? [];
  const driverMap = {};
  for (const d of drivers) {
    if (d.CarIdx != null) driverMap[d.CarIdx] = d;
  }

  // ── Build per-car rows ─────────────────────────────────────────────────────

  // CarIdxPosition[i]    – overall race position (1-based; 0 = not classified)
  // CarIdxClassPosition[i] – position within the car's class
  // CarIdxLap[i]         – number of laps completed
  // CarIdxLapDistPct[i]  – fractional lap completion (0.0 … 1.0)
  // CarIdxLastLapTime[i] – last completed lap time in seconds (−1 = no lap yet)
  // CarIdxBestLapTime[i] – personal best lap time in seconds (−1 = no lap yet)
  // CarIdxF2Time[i]      – time behind leader or car ahead, in seconds

  const idxPos      = tel.CarIdxPosition      ?? [];
  const idxClassPos = tel.CarIdxClassPosition  ?? [];
  const idxLap      = tel.CarIdxLap            ?? [];
  const idxDistPct  = tel.CarIdxLapDistPct     ?? [];
  const idxLastLap  = tel.CarIdxLastLapTime    ?? [];
  const idxBestLap  = tel.CarIdxBestLapTime    ?? [];
  const idxGap      = tel.CarIdxF2Time         ?? [];

  const cars = [];

  // Iterate over the driver map so cars appear in practice/qualifying too,
  // where CarIdxPosition may be 0 for all cars.
  for (const [idxStr, driver] of Object.entries(driverMap)) {
    const idx = parseInt(idxStr, 10);

    // Skip the pace car (CarIsPaceCar may be string "1" or number 1 from YAML)
    // eslint-disable-next-line eqeqeq
    if (driver.CarIsPaceCar == 1) continue;

    const distPct = idxDistPct[idx];
    // No telemetry data yet for this slot – skip
    if (distPct == null) continue;

    const pos = idxPos[idx] ?? 0;

    // A car is considered "off" if it stopped mid-lap and has laps > 0
    const stalled = distPct < 0.001 && (idxLap[idx] ?? 0) > 0;

    cars.push({
      idx,
      pos,
      classPos:   idxClassPos[idx] ?? 0,
      name:       driver.UserName         ?? `Car #${idx}`,
      number:     driver.CarNumber        ?? String(idx),
      carClass:   driver.CarClassShortName ?? '',
      laps:       idxLap[idx]             ?? 0,
      distPct,
      lastLap:    idxLastLap[idx],
      bestLap:    idxBestLap[idx],
      gap:        idxGap[idx],
      stalled,
    });
  }

  // Sort by race position when available; fall back to lap progress (laps + distPct).
  cars.sort((a, b) => {
    if (a.pos > 0 && b.pos > 0) return a.pos - b.pos;
    if (a.pos > 0) return -1;
    if (b.pos > 0) return 1;
    const aP = (a.laps ?? 0) + (a.distPct ?? 0);
    const bP = (b.laps ?? 0) + (b.distPct ?? 0);
    return bP - aP;
  });

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n  iRacing Live Telemetry'));
  if (flagBanner) console.log(`  ${flagBanner}`);
  console.log(
    chalk.gray('  Session: ') + chalk.white(sessionType) +
    chalk.gray('   Lap: ')    + chalk.white(`${playerLap} / ${totalLaps}`) +
    chalk.gray('   Time remaining: ') + chalk.white(timeRemainStr) +
    chalk.gray('   Cars: ') + chalk.white(String(cars.length))
  );
  console.log(chalk.gray('  ' + '─'.repeat(100)));

  if (cars.length === 0) {
    console.log(chalk.gray('\n  No active cars found. Session may still be loading…\n'));

    // ── Debug dump ────────────────────────────────────────────────────────────
    console.log(chalk.yellow('  ── DEBUG INFO ──'));
    console.log(chalk.gray('  SessionNum: ') + chalk.white(String(sessionNum)));
    console.log(chalk.gray('  Sessions array length: ') + chalk.white(String(sessions.length)));
    console.log(chalk.gray('  Session keys: ') + chalk.white(JSON.stringify(Object.keys(session))));
    console.log(chalk.gray('  SessionType raw: ') + chalk.white(JSON.stringify(session.SessionType)));
    console.log(chalk.gray('  Drivers count: ') + chalk.white(String(drivers.length)));
    if (drivers.length > 0) {
      console.log(chalk.gray('  First driver keys: ') + chalk.white(JSON.stringify(Object.keys(drivers[0]))));
      console.log(chalk.gray('  First driver sample: ') + chalk.white(JSON.stringify({
        CarIdx: drivers[0].CarIdx,
        UserName: drivers[0].UserName,
        CarNumber: drivers[0].CarNumber,
        CarIsPaceCar: drivers[0].CarIsPaceCar,
      })));
    }
    const nonNullDist = idxDistPct.filter(v => v != null).length;
    console.log(chalk.gray('  CarIdxLapDistPct non-null entries: ') + chalk.white(String(nonNullDist)));
    const nonNullPos = idxPos.filter(v => v != null && v > 0).length;
    console.log(chalk.gray('  CarIdxPosition > 0 entries: ') + chalk.white(String(nonNullPos)));
    console.log(chalk.gray('  idxDistPct sample (first 10): ') + chalk.white(JSON.stringify(idxDistPct.slice(0, 10))));
    console.log(chalk.gray('  idxPos sample (first 10): ') + chalk.white(JSON.stringify(idxPos.slice(0, 10))));
    console.log(chalk.gray('  si top-level keys: ') + chalk.white(JSON.stringify(Object.keys(si ?? {}))));
    console.log(chalk.gray('  DriverInfo keys: ') + chalk.white(JSON.stringify(Object.keys(si?.DriverInfo ?? {}))));
    process.stdout.write('\x1B[J\x1B[?25h');
    return;
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  const table = new Table({
    head: [
      chalk.bold.white('Pos'),
      chalk.bold.white('Cls'),
      chalk.bold.white('#'),
      chalk.bold.white('Driver'),
      chalk.bold.white('Class'),
      chalk.bold.white('Laps'),
      chalk.bold.white('Last Lap'),
      chalk.bold.white('Best Lap'),
      chalk.bold.white('Gap'),
      chalk.bold.white('Track %'),
    ],
    colWidths:  [6, 6, 6, 24, 9, 7, 12, 12, 13, 14],
    colAligns:  ['right', 'right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
    chars: {
      // Minimal border style for a cleaner look
      top: '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      bottom: '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      left: '│', 'left-mid': '├', mid: '─', 'mid-mid': '┼',
      right: '│', 'right-mid': '┤', middle: '│',
    },
    style: { head: [], border: [], compact: false },
  });

  for (const car of cars) {
    const color    = posColor(car.pos);
    const nameCell = car.stalled
      ? chalk.red(car.name.padEnd(22).slice(0, 22))   // Stalled / retired → red
      : color(car.name.padEnd(22).slice(0, 22));

    const classPosCell = car.classPos > 0
      ? chalk.cyan(`P${car.classPos}`)
      : chalk.gray('--');

    table.push([
      color(`P${car.pos}`),
      classPosCell,
      chalk.yellow(`#${car.number}`),
      nameCell,
      chalk.gray(car.carClass.slice(0, 7)),
      chalk.white(String(car.laps)),
      formatTime(car.lastLap),
      formatTime(car.bestLap),
      formatGap(car.gap, car.pos),
      chalk.blue(lapBar(car.distPct)),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.gray(`  Updated: ${new Date().toLocaleTimeString()}   Press Ctrl+C to exit.\n`));
  // Clear everything below the current cursor position (leftover lines from a
  // taller previous frame) then restore the cursor.
  process.stdout.write('\x1B[J\x1B[?25h');
}

// ─── SDK Initialisation ───────────────────────────────────────────────────────

/**
 * irsdk.init() opens the MMAP file handle, starts an internal polling loop,
 * and returns an EventEmitter.  We pass `telemetryUpdateInterval` to control
 * how often the C++ addon reads a fresh telemetry snapshot from shared memory.
 * Keeping it at 100 ms (10 Hz) is well below the display rate and avoids
 * burning CPU while still being more than fast enough for a 500 ms display.
 */
const iracing = irsdk.init({
  telemetryUpdateInterval: 100,   // ms between MMAP reads
  sessionInfoUpdateInterval: 1000, // ms between YAML re-parses
});

// iRacing started / a session was loaded and the MMAP is now readable.
iracing.on('Connected', () => {
  isConnected = true;
});

// iRacing exited or the MMAP disappeared.
iracing.on('Disconnected', () => {
  isConnected        = false;
  currentTelemetry   = null;
  currentSessionInfo = null;
});

// Emitted whenever the session info YAML changes (new driver, session advance…).
// si is the fully parsed JavaScript object representation of the YAML.
iracing.on('SessionInfo', (si) => {
  currentSessionInfo = si;
});

// Emitted each time a fresh telemetry buffer is read from shared memory.
// data.values is a plain object mapping variable names → current values.
iracing.on('Telemetry', (data) => {
  currentTelemetry = data;
});

// ─── Display Loop ─────────────────────────────────────────────────────────────

// Redraw every 500 ms.  This is independent of how fast iRacing writes data;
// we simply display whatever the latest snapshot happens to be at each tick.
setInterval(render, 500);

// Show the waiting screen immediately rather than waiting for the first tick.
render();

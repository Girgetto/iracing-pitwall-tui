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


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate iRating changes for all classified cars using a pairwise ELO model.
 *
 * For every pair (A, B), the probability that A beats B is:
 *   P(A beats B) = 1 / (1 + e^((ir_B - ir_A) / 1500))
 *
 * Summing over all opponents gives an expected wins total.  The actual wins
 * total is simply the number of cars a driver finished ahead of.  The
 * difference, scaled by (200 / n), approximates the iRating change iRacing
 * awards.  This is an accepted community approximation — the exact formula
 * is not public.
 */
function calcIRatingDeltas(cars) {
  const classified = cars.filter(c => c.pos > 0 && c.iRating > 0);
  const n = classified.length;
  if (n < 2) return;

  const k = 200 / n;

  for (const car of classified) {
    let sumExpected = 0;
    let sumActual   = 0;
    for (const opp of classified) {
      if (opp === car) continue;
      sumExpected += 1 / (1 + Math.exp((opp.iRating - car.iRating) / 1500));
      sumActual   += car.pos < opp.pos ? 1 : 0;
    }
    car.iRatingDelta = Math.round((sumActual - sumExpected) * k);
  }
}

/**
 * Rough Safety Rating delta estimate for the player.
 *
 * iRacing's SR formula is not public, but community analysis suggests:
 *   +0.12 SR per clean lap (4 safe corners × ~0.03 per corner)
 *   −1.0  SR per incident point accumulated
 *
 * Values are approximate and may differ slightly from in-game results.
 */
function estimateSRDelta(laps, incidents) {
  return ((laps * 0.12) - (incidents * 1.0)).toFixed(2);
}

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
  if (position === 1) return chalk.green.bold('Leader');
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
    ? (() => {
        const h = Math.floor(timeRemain / 3600);
        const m = Math.floor((timeRemain % 3600) / 60);
        const s = Math.floor(timeRemain % 60);
        return h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`;
      })()
    : chalk.gray('N/A');

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

  const playerCarIdx    = tel.PlayerCarIdx        ?? -1;
  const playerIncidents = tel.PlayerCarMyIncidents ?? 0;

  const idxPos      = tel.CarIdxPosition      ?? [];
  const idxClassPos = tel.CarIdxClassPosition  ?? [];
  const idxLap      = tel.CarIdxLap            ?? [];
  const idxDistPct  = tel.CarIdxLapDistPct     ?? [];
  const idxLastLap  = tel.CarIdxLastLapTime    ?? [];
  const idxBestLap  = tel.CarIdxBestLapTime    ?? [];
  const idxGap      = tel.CarIdxF2Time         ?? [];

  const cars = [];
  const seenIdx = new Set();

  // Iterate over the driver map so cars appear in practice/qualifying too,
  // where CarIdxPosition may be 0 for all cars.
  for (const [idxStr, driver] of Object.entries(driverMap)) {
    const idx = parseInt(idxStr, 10);
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);

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
      name:       String(driver.UserName   ?? `Car #${idx}`),
      number:     String(driver.CarNumber        ?? idx),
      carClass:   String(driver.CarClassShortName ?? ''),
      laps:       idxLap[idx]             ?? 0,
      distPct,
      lastLap:    idxLastLap[idx],
      bestLap:    idxBestLap[idx],
      gap:        idxGap[idx],
      stalled,
      isPlayer:   idx === playerCarIdx,
      iRating:    parseInt(driver.IRating ?? 0, 10),
      iRatingDelta: null, // filled in by calcIRatingDeltas()
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

  // Recalculate class positions from the sorted order so they're always correct,
  // regardless of what CarIdxClassPosition reports (which mirrors overall pos in
  // single-class races and can sometimes be unreliable in multiclass).
  const classCounters = {};
  for (const car of cars) {
    const cls = car.carClass || '__default__';
    classCounters[cls] = (classCounters[cls] ?? 0) + 1;
    car.classPos = classCounters[cls];
  }

  // If every car is in the same class, class position == overall position, so
  // suppress the Cls column to avoid redundant data.
  const uniqueClasses = new Set(cars.map(c => c.carClass || '__default__'));
  const multiClass = uniqueClasses.size > 1;

  // Estimate iRating deltas for all classified cars.
  calcIRatingDeltas(cars);

  const playerCar = cars.find(c => c.isPlayer);

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n  iRacing Live Telemetry'));
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
      chalk.bold.white('#'),
      chalk.bold.white('Driver'),
      chalk.bold.white('Class'),
      chalk.bold.white('Laps'),
      chalk.bold.white('Last Lap'),
      chalk.bold.white('Best Lap'),
      chalk.bold.white('Gap'),
      chalk.bold.white('Track %'),
      chalk.bold.white('iR'),
      chalk.bold.white('Δ iR'),
    ],
    colWidths:  [6, 6, 24, 9, 7, 11, 11, 12, 14, 7, 8],
    colAligns:  ['right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
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
    const color = posColor(car.pos);
    const p     = car.isPlayer;

    const nameCell = car.stalled
      ? chalk.red(car.name.padEnd(22).slice(0, 22))
      : p
        ? chalk.yellow.bold(('▶ ' + car.name).padEnd(22).slice(0, 22))
        : color(car.name.padEnd(22).slice(0, 22));

    // iRating cell
    const iRCell = car.iRating > 0
      ? (p ? chalk.yellow.bold(String(car.iRating)) : chalk.white(String(car.iRating)))
      : chalk.gray('--');

    // Δ iRating cell — green/red by direction; yellow-bold for player
    let iRDeltaCell;
    if (car.iRatingDelta == null) {
      iRDeltaCell = chalk.gray('--');
    } else {
      const sign   = car.iRatingDelta >= 0 ? '+' : '';
      const dStr   = `${sign}${car.iRatingDelta}`;
      const dColor = car.iRatingDelta >= 0 ? chalk.green.bold : chalk.red.bold;
      iRDeltaCell  = p ? chalk.yellow.bold(dStr) : dColor(dStr);
    }

    // Last lap cell — purple when it matches the personal best (just set a PB)
    const isBestLap = car.lastLap > 0 && car.bestLap > 0 && car.lastLap === car.bestLap;
    const lastLapCell = isBestLap
      ? chalk.magenta.bold(formatTime(car.lastLap))
      : p ? chalk.yellow(formatTime(car.lastLap)) : formatTime(car.lastLap);

    table.push([
      p ? chalk.yellow.bold(`P${car.pos}`) : color(`P${car.pos}`),
      p ? chalk.yellow.bold(`#${car.number}`) : chalk.yellow(`#${car.number}`),
      nameCell,
      p ? chalk.yellow(car.carClass.slice(0, 7)) : chalk.gray(car.carClass.slice(0, 7)),
      p ? chalk.yellow.bold(String(car.laps)) : chalk.white(String(car.laps)),
      lastLapCell,
      p ? chalk.yellow(formatTime(car.bestLap)) : formatTime(car.bestLap),
      p ? chalk.yellow(formatGap(car.gap, car.pos)) : formatGap(car.gap, car.pos),
      p ? chalk.yellow(lapBar(car.distPct)) : chalk.blue(lapBar(car.distPct)),
      iRCell,
      iRDeltaCell,
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

// Real mouse input, through the Chrome DevTools Protocol (chrome.debugger).
//
// Simulated events (page.js) are marked untrusted, and some sites ignore them. These
// are not: Chrome delivers them exactly as it delivers a person's mouse. That is the
// whole reason to use them, and also why this file is small on purpose.
//
// Pure, like policy.js: it never touches chrome.*. It is handed a `send(method,
// params)` that background.js wires to chrome.debugger.sendCommand, and a state
// object it updates in place — so `agent --test` can check exactly which events a
// gesture produces.
//
// **ALLOWED_METHODS is the boundary.** A debugger session can evaluate script in the
// page, read cookies and intercept the network. This probe needs none of that, so the
// only command background.js will ever send is the one listed here, and adding to the
// list is a decision, not a detail.

export const ALLOWED_METHODS = new Set(["Input.dispatchMouseEvent"]);

export const ACTIONS = new Set(["press", "move", "release", "click", "double_click", "wheel", "path"]);

// A path is one stroke: press at the first point, move through the rest, release at
// the last. Bounded so one call cannot hold the mouse down for minutes.
export const MAX_PATH_POINTS = 500;

/**
 * The points of a path, checked: 2 to MAX_PATH_POINTS pairs of finite numbers.
 * Returns them as [[x, y], ...] numbers, or throws saying what is wrong.
 */
export function checkPath(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("A path needs at least two points: [[x, y], [x, y], ...].");
  }
  if (points.length > MAX_PATH_POINTS) {
    throw new Error(`A path has at most ${MAX_PATH_POINTS} points; split the stroke.`);
  }
  return points.map((p, i) => {
    const [x, y] = Array.isArray(p) ? p.map(Number) : [NaN, NaN];
    if (!(Array.isArray(p) && p.length === 2 && Number.isFinite(x) && Number.isFinite(y))) {
      throw new Error(`Point ${i} of the path is not [x, y].`);
    }
    return [x, y];
  });
}

/** Moves for one segment of a path: about one every 8 px, at least 1, at most 10. */
export function segmentSteps(x0, y0, x1, y1) {
  return Math.min(10, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8)));
}

const BUTTONS = { left: ["left", 1], middle: ["middle", 4], right: ["right", 2] };

/** The CDP name of the button currently held, for events that report one. */
function held(buttons) {
  if (buttons & 1) return "left";
  if (buttons & 4) return "middle";
  if (buttons & 2) return "right";
  return "none";
}

/**
 * Perform one mouse action at (x, y), in CSS pixels of the viewport — or, for
 * `path`, one whole stroke through `points` (CSS pixels too).
 *
 * @param {{action: string, x?: number, y?: number, points?: number[][],
 *          button?: string, deltaX?: number, deltaY?: number}} cmd
 * @param {{buttons: number, x: number|null, y: number|null}} state  updated in place
 * @param {(method: string, params: object) => Promise<unknown>} send
 * @param {(ms: number) => Promise<void>} [sleep]
 */
export async function nativeMouse(cmd, state, send, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  if (!ACTIONS.has(cmd.action)) throw new Error(`Unknown mouse action ${cmd.action}.`);
  const [name, mask] = BUTTONS[cmd.button] || BUTTONS.left;
  const { x, y } = cmd;
  const ev = (type, px, py, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x: px, y: py, modifiers: 0, ...extra });

  // A real pointer arrives somewhere before it presses there; hover handlers and
  // drag libraries both expect the move. While a button is held the move is a path
  // in small steps, because libraries ignore a jump.
  const moveTo = async (px, py) => {
    if (state.x === px && state.y === py) return;
    const steps = state.buttons && state.x !== null ? 10 : 1;
    const [sx, sy] = state.x === null ? [px, py] : [state.x, state.y];
    for (let i = 1; i <= steps; i++) {
      await ev("mouseMoved", sx + ((px - sx) * i) / steps, sy + ((py - sy) * i) / steps, {
        button: held(state.buttons),
        buttons: state.buttons,
      });
      if (steps > 1) await sleep(16);
    }
    state.x = px;
    state.y = py;
  };
  const press = async (clickCount, px = x, py = y) => {
    state.buttons |= mask;
    await ev("mousePressed", px, py, { button: name, buttons: state.buttons, clickCount });
  };
  const release = async (clickCount, px = x, py = y) => {
    state.buttons &= ~mask;
    await ev("mouseReleased", px, py, { button: name, buttons: state.buttons, clickCount });
  };

  switch (cmd.action) {
    case "move":
      await moveTo(x, y);
      break;
    case "press":
      await moveTo(x, y);
      await press(1);
      break;
    case "release":
      await moveTo(x, y);
      await release(1);
      break;
    case "click":
      await moveTo(x, y);
      await press(1);
      await release(1);
      break;
    case "double_click":
      // Chrome turns the second pair, with clickCount 2, into a dblclick itself.
      await moveTo(x, y);
      await press(1);
      await release(1);
      await press(2);
      await release(2);
      break;
    case "path": {
      // One stroke in one call: what drawing needs, and what press/move/release cost a
      // model round each for. Moves are spaced by distance rather than a fixed ten per
      // hop, so a 200-point stroke takes a second or two, not half a minute.
      const pts = checkPath(cmd.points);
      if (state.buttons) throw new Error("A button is already held; release it before a path.");
      const [[x0, y0]] = pts;
      await moveTo(x0, y0);
      await press(1, x0, y0);
      for (const [px, py] of pts.slice(1)) {
        const steps = segmentSteps(state.x, state.y, px, py);
        const [sx, sy] = [state.x, state.y];
        for (let i = 1; i <= steps; i++) {
          await ev("mouseMoved", sx + ((px - sx) * i) / steps, sy + ((py - sy) * i) / steps, {
            button: held(state.buttons),
            buttons: state.buttons,
          });
        }
        state.x = px;
        state.y = py;
        await sleep(8);
      }
      const [lx, ly] = pts[pts.length - 1];
      await release(1, lx, ly);
      break;
    }
    case "wheel":
      await moveTo(x, y);
      await ev("mouseWheel", x, y, {
        button: held(state.buttons),
        buttons: state.buttons,
        deltaX: Number(cmd.deltaX) || 0,
        deltaY: Number(cmd.deltaY) || 0,
      });
      break;
  }
  return { pressed: state.buttons !== 0 };
}

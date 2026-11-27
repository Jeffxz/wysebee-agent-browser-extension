// Functions injected into a page with chrome.scripting.executeScript.
//
// Each one is serialised and run in the page, so it must be entirely self-contained:
// no imports, no closures over anything in this file. Page content is untrusted -
// nothing here executes anything the page supplies, and values read out of a page are
// data for the caller, never instructions for this code.

export function snapshot() {
  const MAX_TEXT = 20000;
  const MAX_ELEMENTS = 300;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  document.querySelectorAll("[data-wysebee-ref]").forEach((e) => e.removeAttribute("data-wysebee-ref"));
  const selector =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=menuitem],[role=tab],[contenteditable=""],' +
    '[contenteditable=true],[onclick],[draggable=true]';
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.disabled || !visible(el)) continue;
    const ref = String(++n);
    el.setAttribute("data-wysebee-ref", ref);
    const type = (el.getAttribute("type") || "").toLowerCase();
    const name = (
      el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const item = { ref, tag: el.tagName.toLowerCase(), name };
    if (type) item.type = type;
    if (el.tagName === "A") item.href = String(el.href).slice(0, 200);
    // What browser_drag can pick up: an HTML5 drag source says so in the DOM.
    if (el.draggable && el.tagName !== "A" && el.tagName !== "IMG") item.draggable = true;
    // A password is never read out, whatever the page calls the field.
    if ("value" in el && type !== "password" && el.value) item.value = String(el.value).slice(0, 100);
    elements.push(item);
  }
  const text = document.body ? document.body.innerText : "";
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    elements,
  };
}

export function click(ref) {
  const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
  if (!el) return { ok: false, error: "That element is gone. Take a new snapshot." };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true };
}

export function type(ref, text, submit) {
  const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
  if (!el) return { ok: false, error: "That element is gone. Take a new snapshot." };
  if ((el.getAttribute("type") || "").toLowerCase() === "password") {
    return { ok: false, error: "Typing into password fields is not allowed." };
  }
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    el.textContent = text;
  } else if ("value" in el) {
    // The page's framework listens for real input events, which a plain assignment
    // does not fire; the prototype setter plus events does.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  } else {
    return { ok: false, error: "That element does not accept text." };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    if (el.form && el.form.requestSubmit) el.form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  return { ok: true };
}

/**
 * Scroll the page — or, with a ref, the panel that element sits in — by a number of
 * screens, and report where it ended up so the caller knows whether there is more.
 *
 * With a ref, the nearest scrollable ancestor (the element itself included) is the one
 * moved: refs belong to interactive elements, and the list or panel around one is the
 * thing that scrolls. Async, so content a page loads on scroll has a moment to arrive.
 *
 * With `dry`, nothing scrolls: it answers where the box it would scroll is on screen
 * (`x`, `y`, its visible centre), for the agent pointer to show the scroll there.
 */
export async function scroll(ref, direction, pages, dry) {
  const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const dir = DIRECTIONS[direction];
  if (!dir) return { ok: false, error: "direction must be up, down, left or right." };
  const amount = Number.isFinite(pages) && pages > 0 ? Math.min(pages, 20) : 1;

  const scrollable = (el) => {
    const cs = getComputedStyle(el);
    const y = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight;
    const x = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth;
    return dir[1] ? y : x;
  };
  let box = document.scrollingElement || document.documentElement;
  if (ref) {
    let el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
    if (!el) return { ok: false, error: "That element is gone. Take a new snapshot." };
    while (el && el !== document.body && !scrollable(el)) el = el.parentElement;
    if (el && el !== document.body) box = el;
  }
  const isPage = box === document.scrollingElement || box === document.documentElement;
  const viewW = isPage ? window.innerWidth : box.clientWidth;
  const viewH = isPage ? window.innerHeight : box.clientHeight;
  if (dry) {
    if (isPage) return { ok: true, x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = box.getBoundingClientRect();
    const mid = (lo, hi, max) => (Math.max(0, lo) + Math.min(max, hi)) / 2;
    return { ok: true, x: mid(r.left, r.right, window.innerWidth), y: mid(r.top, r.bottom, window.innerHeight) };
  }
  // Most of a screen, not all of it, so a line at the edge is seen in both views.
  box.scrollBy({ left: dir[0] * viewW * 0.85 * amount, top: dir[1] * viewH * 0.85 * amount });
  await new Promise((r) => setTimeout(r, 350));
  return {
    ok: true,
    target: isPage ? "page" : "panel",
    scroll_x: Math.round(box.scrollLeft),
    scroll_y: Math.round(box.scrollTop),
    at_top: box.scrollTop <= 0,
    at_bottom: Math.ceil(box.scrollTop + box.clientHeight) >= box.scrollHeight,
  };
}

/**
 * Drag one element onto another, or by a pixel offset, with synthesized events.
 *
 * Three kinds of drag exist on the web and each wants something different:
 * - a native range slider moves only when its value is set, so it is set — from where
 *   the drag would end — and told with input/change events;
 * - an HTML5 drag source (`draggable`) is driven with dragstart / dragenter / dragover
 *   / drop / dragend sharing one DataTransfer;
 * - everything else (sortable lists, boards, custom sliders) listens to pointer and
 *   mouse events, so it gets a press, a path of moves in small steps — libraries ignore
 *   a jump, and most need a few pixels before a drag "starts" — and a release.
 *
 * The browser marks these events untrusted, and a page that checks will ignore them;
 * the result says which kind was attempted so a failure can be told apart.
 *
 * With `dry`, nothing is dragged: it answers where the drag would go (`from`, `to`,
 * viewport pixels, the source already scrolled into view), for the agent pointer.
 */
export async function drag(fromRef, toRef, toText, dx, dy, dry) {
  const find = (ref) => document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
  const src = find(fromRef);
  if (!src) return { ok: false, error: "The element to drag is gone. Take a new snapshot." };
  let dst = toRef ? find(toRef) : null;
  if (toRef && !dst) return { ok: false, error: "The drop target is gone. Take a new snapshot." };
  // A drop zone is usually a plain box ("Drop files here", a board's "Done" column)
  // with nothing interactive in it, so it has no ref. Find it by its text instead: the
  // smallest visible element that shows it, which the drop then bubbles up from.
  if (!dst && toText) {
    const want = String(toText).trim().toLowerCase();
    let best = null;
    let bestArea = Infinity;
    for (const el of document.body.querySelectorAll("*")) {
      if (el === src || src.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!(el.innerText || "").toLowerCase().includes(want)) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    if (!best) return { ok: false, error: `No visible element shows "${toText}".` };
    dst = best;
  }
  if (!dst && !dx && !dy) {
    return { ok: false, error: "Give a drop target (to_ref or to_text) or an offset (dx, dy)." };
  }

  // "nearest", not "center": centring scrolled pages sideways for no reason.
  src.scrollIntoView({ block: "center", inline: "nearest" });
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const [x0, y0] = centre(src);
  const [x1, y1] = dst ? centre(dst) : [x0 + (Number(dx) || 0), y0 + (Number(dy) || 0)];
  if (dry) return { ok: true, from: [x0, y0], to: [x1, y1] };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  if (src instanceof HTMLInputElement && src.type === "range") {
    const r = src.getBoundingClientRect();
    const min = Number(src.min || 0);
    const max = Number(src.max || 100);
    const frac = Math.min(1, Math.max(0, (x1 - r.left) / (r.width || 1)));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(src, String(min + frac * (max - min)));
    src.dispatchEvent(new Event("input", { bubbles: true }));
    src.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, kind: "slider", value: src.value };
  }

  const at = (x, y) => document.elementFromPoint(x, y) || dst || src;
  const mouse = (type, el, x, y, buttons) => {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons };
    el.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent(type, init));
  };

  if (src.closest("[draggable=true]")) {
    const source = src.closest("[draggable=true]");
    const data = new DataTransfer();
    const fire = (type, el, x, y) =>
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data }));
    mouse("mousedown", source, x0, y0, 1);
    fire("dragstart", source, x0, y0);
    await pause(50);
    const over = at(x1, y1);
    fire("dragenter", over, x1, y1);
    fire("dragover", over, x1, y1);
    await pause(50);
    fire("drop", over, x1, y1);
    fire("dragend", source, x1, y1);
    return { ok: true, kind: "html5" };
  }

  mouse("mousedown", src, x0, y0, 1);
  await pause(80);
  const STEPS = 12;
  for (let i = 1; i <= STEPS; i++) {
    const x = x0 + ((x1 - x0) * i) / STEPS;
    const y = y0 + ((y1 - y0) * i) / STEPS;
    mouse("mousemove", at(x, y), x, y, 1);
    await pause(16);
  }
  await pause(80);
  mouse("mouseup", at(x1, y1), x1, y1, 0);
  return { ok: true, kind: "pointer" };
}

/**
 * One mouse action, simulated: press, move or release a button, or a whole click,
 * double click or wheel turn — at a point or at an element's centre. browser_drag is
 * the one-call drag; this is for what it cannot express — drawing, a drag with a
 * pause in it, hovering to open a menu.
 *
 * Real input (`native`) does not come through here: background.js sends it through
 * the debugger, after `locate` below has turned the caller's point into page pixels.
 *
 * `x`/`y` are **screenshot pixels**, the coordinates the caller sees. background.js
 * passes how many of those make one CSS pixel (`pxPerCss`, from the latest screenshot,
 * which is scaled to fit); without one, devicePixelRatio, as for a raw capture. The pressed state lives on this
 * frame's window between calls, which persists in the extension's isolated world for
 * as long as the page does, so a move after a press is a move "with the button down".
 * A move while pressed travels in small steps from the last point, because libraries
 * ignore a jump. A release over the element that was pressed also clicks it, as a real
 * mouse would.
 *
 * `path` is a whole stroke in one call — press at the first of `points`, move through
 * the rest, release at the last — because drawing one press/move/release at a time
 * spends a model round on every point. (Self-contained like everything here: this is
 * injected into the page, so the limits in native_input.js are restated, not shared.)
 */
export async function mouse(action, x, y, ref, button, deltaX, deltaY, pxPerCss, points) {
  const BUTTONS = { left: [0, 1], middle: [1, 4], right: [2, 2] };
  const [btn, mask] = BUTTONS[button] || BUTTONS.left;
  if (!["press", "move", "release", "click", "double_click", "wheel", "path"].includes(action)) {
    return { ok: false, error: "action must be press, move, release, click, double_click, wheel or path." };
  }
  const state = (window.__wysebeeMouse ||= { buttons: 0, x: null, y: null, pressedOn: null, over: null });

  let cx;
  let cy;
  let path = null;
  if (action === "path") {
    if (!Array.isArray(points) || points.length < 2 || points.length > 500) {
      return { ok: false, error: "A path needs 2 to 500 points: [[x, y], [x, y], ...]." };
    }
    if (state.buttons) return { ok: false, error: "A button is already held; release it before a path." };
    const dpr = Number(pxPerCss) > 0 ? Number(pxPerCss) : window.devicePixelRatio || 1;
    path = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const [px, py] = Array.isArray(p) && p.length === 2 ? p.map(Number) : [NaN, NaN];
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        return { ok: false, error: `Point ${i} of the path is not [x, y].` };
      }
      const [qx, qy] = [px / dpr, py / dpr];
      if (qx < 0 || qy < 0 || qx > window.innerWidth || qy > window.innerHeight) {
        return { ok: false, error: `Point ${i} of the path is outside the visible page.` };
      }
      path.push([qx, qy]);
    }
    [cx, cy] = path[0];
  } else if (ref) {
    const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
    if (!el) return { ok: false, error: "That element is gone. Take a new snapshot." };
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  } else if (Number.isFinite(x) && Number.isFinite(y)) {
    // Screenshot pixels per CSS pixel: the latest screenshot's scale when there is
    // one (it is shrunk to fit), devicePixelRatio for a full-resolution capture.
    const dpr = Number(pxPerCss) > 0 ? Number(pxPerCss) : window.devicePixelRatio || 1;
    cx = x / dpr;
    cy = y / dpr;
  } else {
    return { ok: false, error: "Give a point (x, y, in screenshot pixels) or a ref." };
  }
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return { ok: false, error: "That point is outside the visible page. Scroll first." };
  }

  const at = (px, py) => document.elementFromPoint(px, py) || document.body;
  // Crossing into another element is what opens a JS hover menu: a real mouse sends
  // out/leave to the old one and over/enter to the new. (CSS :hover cannot be reached
  // by synthesized events at all.)
  const cross = (el, init) => {
    const old = state.over;
    if (old === el) return;
    const ev = (type, target, bubbles) =>
      target.dispatchEvent(new MouseEvent(type, { ...init, bubbles, relatedTarget: type.endsWith("out") || type.endsWith("leave") ? el : old }));
    if (old && old.isConnected) {
      old.dispatchEvent(new PointerEvent("pointerout", { ...init, bubbles: true, pointerId: 1, pointerType: "mouse" }));
      ev("mouseout", old, true);
      for (let n = old; n && !n.contains(el); n = n.parentElement) ev("mouseleave", n, false);
    }
    el.dispatchEvent(new PointerEvent("pointerover", { ...init, bubbles: true, pointerId: 1, pointerType: "mouse" }));
    ev("mouseover", el, true);
    const entered = [];
    for (let n = el; n && !(old && old.isConnected && n.contains(old)); n = n.parentElement) entered.unshift(n);
    for (const n of entered) ev("mouseenter", n, false);
    state.over = el;
  };
  const fire = (type, px, py, buttons) => {
    const el = at(px, py);
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: px, clientY: py, button: btn, buttons,
    };
    cross(el, init);
    if (type.startsWith("mouse")) {
      el.dispatchEvent(
        new PointerEvent(type.replace("mouse", "pointer"), { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }),
      );
    }
    el.dispatchEvent(new MouseEvent(type, init));
    return el;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let target;
  const press = () => {
    if (state.x !== null) fire("mousemove", cx, cy, state.buttons);
    state.buttons |= mask;
    target = fire("mousedown", cx, cy, state.buttons);
    state.pressedOn = target;
    if (btn === 2) fire("contextmenu", cx, cy, state.buttons);
  };
  const release = (detail) => {
    state.buttons &= ~mask;
    target = fire("mouseup", cx, cy, state.buttons);
    if (btn === 0 && state.pressedOn && (state.pressedOn === target || state.pressedOn.contains(target))) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail }));
    }
    state.pressedOn = null;
  };

  if (action === "path") {
    press();
    for (const [px, py] of path.slice(1)) {
      // About one move every 8 px, so a long stroke stays smooth and a short one fast.
      const steps = Math.min(10, Math.max(1, Math.ceil(Math.hypot(px - cx, py - cy) / 8)));
      for (let i = 1; i <= steps; i++) {
        target = fire("mousemove", cx + ((px - cx) * i) / steps, cy + ((py - cy) * i) / steps, state.buttons);
      }
      [cx, cy] = [px, py];
      await pause(8);
    }
    release(1);
  } else if (action === "press") {
    press();
  } else if (action === "move") {
    const steps = state.buttons && state.x !== null ? 10 : 1;
    const [sx, sy] = state.x === null ? [cx, cy] : [state.x, state.y];
    for (let i = 1; i <= steps; i++) {
      target = fire("mousemove", sx + ((cx - sx) * i) / steps, sy + ((cy - sy) * i) / steps, state.buttons);
      if (steps > 1) await pause(16);
    }
  } else if (action === "release") {
    release(1);
  } else if (action === "click") {
    press();
    release(1);
  } else if (action === "double_click") {
    press();
    release(1);
    press();
    release(2);
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 2 }));
  } else {
    // A synthesized WheelEvent reaches the page's handlers but scrolls nothing — only
    // real input does that. So when no handler claimed it, scroll what a wheel would:
    // the nearest scrollable box under the pointer, or the page.
    const dX = Number(deltaX) || 0;
    const dY = Number(deltaY) || 0;
    target = at(cx, cy);
    if (state.x !== null) fire("mousemove", cx, cy, state.buttons);
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, deltaX: dX, deltaY: dY, deltaMode: 0 });
    if (target.dispatchEvent(wheel)) {
      let box = target;
      const can = (el) => {
        const cs = getComputedStyle(el);
        return (dY && /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) ||
          (dX && /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth);
      };
      while (box && box !== document.body && box !== document.documentElement && !can(box)) box = box.parentElement;
      if (!box || box === document.body || box === document.documentElement) box = document.scrollingElement || document.documentElement;
      box.scrollBy({ left: dX, top: dY });
    }
  }
  state.x = cx;
  state.y = cy;
  await pause(50);

  const name = (target.getAttribute?.("aria-label") || target.innerText || target.value || "")
    .trim().replace(/\s+/g, " ").slice(0, 80);
  return { ok: true, pressed: state.buttons !== 0, element: { tag: target.tagName.toLowerCase(), name } };
}

/**
 * Where a caller's point is, in this page's own pixels — for real input, which the
 * debugger takes in CSS pixels of the viewport rather than screenshot pixels.
 *
 * The same rules as `mouse` above, deliberately: a ref means its element's centre
 * (scrolled into view first), x/y are screenshot pixels and divided by
 * devicePixelRatio, and a point off the visible page is refused rather than sent.
 */
export function locate(x, y, ref, pxPerCss) {
  let cx;
  let cy;
  if (ref) {
    const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
    if (!el) return { ok: false, error: "That element is gone. Take a new snapshot." };
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  } else if (Number.isFinite(x) && Number.isFinite(y)) {
    // Screenshot pixels per CSS pixel: the latest screenshot's scale when there is
    // one (it is shrunk to fit), devicePixelRatio for a full-resolution capture.
    const dpr = Number(pxPerCss) > 0 ? Number(pxPerCss) : window.devicePixelRatio || 1;
    cx = x / dpr;
    cy = y / dpr;
  } else {
    return { ok: false, error: "Give a point (x, y, in screenshot pixels) or a ref." };
  }
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return { ok: false, error: "That point is outside the visible page. Scroll first." };
  }
  const el = document.elementFromPoint(cx, cy) || document.body;
  const name = (el.getAttribute?.("aria-label") || el.innerText || el.value || "")
    .trim().replace(/\s+/g, " ").slice(0, 80);
  return { ok: true, x: cx, y: cy, element: { tag: el.tagName.toLowerCase(), name } };
}

/**
 * A path's points in this page's own pixels, for real input — `locate` above for a
 * whole stroke, with `mouse`'s path rules: 2 to 500 [x, y] screenshot-pixel points,
 * every one on the visible page.
 */
export function locatePath(points, pxPerCss) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 500) {
    return { ok: false, error: "A path needs 2 to 500 points: [[x, y], [x, y], ...]." };
  }
  const dpr = Number(pxPerCss) > 0 ? Number(pxPerCss) : window.devicePixelRatio || 1;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const [px, py] = Array.isArray(p) && p.length === 2 ? p.map(Number) : [NaN, NaN];
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return { ok: false, error: `Point ${i} of the path is not [x, y].` };
    }
    const [cx, cy] = [px / dpr, py / dpr];
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      return { ok: false, error: `Point ${i} of the path is outside the visible page.` };
    }
    out.push([cx, cy]);
  }
  const el = document.elementFromPoint(out[0][0], out[0][1]) || document.body;
  const name = (el.getAttribute?.("aria-label") || el.innerText || el.value || "")
    .trim().replace(/\s+/g, " ").slice(0, 80);
  return { ok: true, points: out, element: { tag: el.tagName.toLowerCase(), name } };
}

/**
 * The agent pointer, drawn for the person watching (what to draw: pointer.js).
 *
 * A red dot where the agent's mouse is. It glides from where it was to the first of
 * `points` like a hand on a mouse (`glide`: pointer.js's GLIDE — the longer the reach
 * the longer it takes, on a slight arc, easing in and out), then travels through the
 * rest over `ms`. With `hold` it is
 * pressed for that travel — a pulse and a darker, smaller dot as the button goes
 * down, another pulse as it comes up — which is how a drag, a stroke or a scroll
 * looks; otherwise it pulses `pulses` times on arrival (a click) and is left
 * `pressed` or not (null: as it was). It fades out `idleMs` after the agent's last
 * action (pointer.js's IDLE_MS: minutes, so it stays put like a mouse cursor). With
 * `hide`, the dot and caret go at once. With `ref`, the dot goes to that element's centre, scrolled into view the
 * way `click` scrolls it. With `caret`, a blinking red bar sits at the end of that
 * ref's text for `caretMs`.
 *
 * Returns `lead`, the glide's length, so the caller can start the action as the dot
 * arrives rather than before it, and `at`, where the dot ends up (null if it did not
 * move), so the caller can draw it there again after the page loads.
 *
 * It must be invisible to everything else: one element of a name no page uses, on
 * <html> rather than <body> (so neither `snapshot`'s elements nor its text see it),
 * styled inline with !important, its parts in a closed shadow root page CSS cannot
 * reach, pointer-events none throughout (so `elementFromPoint` and every click go
 * through it) and, where the browser has popovers, in the top layer above the page's
 * own dialogs. State lives on this frame's window in the extension's isolated world,
 * like `mouse`'s; the page cannot see it.
 */
export function overlay(cmd) {
  const ui = (window.__wysebeeOverlay ||= { host: null, root: null, dot: null, anim: null, idle: 0, caret: null });
  if (!ui.host || !ui.host.isConnected) {
    const host = document.createElement("wysebee-agent-pointer");
    host.setAttribute("aria-hidden", "true");
    const css = {
      all: "initial", display: "block", position: "fixed", inset: "0", width: "100vw", height: "100vh",
      margin: "0", padding: "0", border: "0", background: "transparent", overflow: "visible",
      "pointer-events": "none", "z-index": "2147483647", "user-select": "none",
    };
    for (const [k, v] of Object.entries(css)) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      * { pointer-events: none !important; box-sizing: border-box; }
      .dot { position: fixed; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%; background: #ef4444; opacity: 0; transition: opacity .5s, background .15s, scale .15s;
        box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 1px 5px rgba(0,0,0,.45); }
      .dot.on { opacity: 1; }
      .dot.pressed { background: #b91c1c; scale: .8; }
      .ring { position: fixed; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%; border: 2px solid #ef4444; animation: ring .5s ease-out forwards; }
      @keyframes ring { from { scale: 1; opacity: .9; } to { scale: 3.4; opacity: 0; } }
      .caret { position: fixed; left: 0; top: 0; width: 2px; background: #ef4444;
        box-shadow: 0 0 3px rgba(239,68,68,.6); animation: blink 1s step-end infinite; }
      @keyframes blink { 50% { opacity: 0; } }
    </style><div class="dot"></div>`;
    (document.documentElement || document).appendChild(host);
    ui.host = host;
    ui.root = root;
    ui.dot = root.querySelector(".dot");
    ui.anim = null;
  }
  // Above everything, a modal opened since included: a popover shown again goes on top.
  try {
    if (!ui.host.hasAttribute("popover")) ui.host.setAttribute("popover", "manual");
    if (ui.host.matches(":popover-open")) ui.host.hidePopover();
    ui.host.showPopover();
  } catch {
    /* No popover API (or the page broke it): z-index alone. */
  }
  const { dot, root } = ui;
  if (cmd.hide) {
    for (const t of ui.timers || []) clearTimeout(t);
    ui.timers = [];
    clearTimeout(ui.idle);
    if (ui.anim) ui.anim.cancel();
    ui.anim = null;
    dot.classList.remove("on", "pressed");
    dot.style.translate = "";
    if (ui.caret) ui.caret.remove();
    ui.caret = null;
    try {
      ui.host.hidePopover();
    } catch {
      /* Not a popover: nothing to take out of the top layer. */
    }
    return { lead: 0, at: null };
  }
  const xy = ([x, y]) => `${x}px ${y}px`;
  const idleMs = Number(cmd.idleMs) > 0 ? Number(cmd.idleMs) : 3000;

  let points = Array.isArray(cmd.points) ? cmd.points : null;
  if (cmd.ref) {
    const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(cmd.ref))}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      points = [[r.left + r.width / 2, r.top + r.height / 2]];
    }
  }
  let lead = 0;
  let at = null;
  if (points && points.length) {
    const ms = Math.max(0, Number(cmd.ms) || 0);
    const first = points[0];
    const end = points[points.length - 1];
    // A new action replaces whatever the last one still had scheduled.
    for (const t of ui.timers || []) clearTimeout(t);
    ui.timers = [];
    const later = (fn, at) => ui.timers.push(setTimeout(fn, at));
    // Carry on from wherever the last animation had got to. Position is `translate`,
    // not `transform`, so the `scale` of a press or a pulse scales about the point
    // rather than scaling the offset too.
    if (ui.anim) {
      try {
        ui.anim.commitStyles();
      } catch {
        /* Not rendered: start from the stored end point. */
      }
      ui.anim.cancel();
      ui.anim = null;
    }
    const shown = dot.classList.contains("on") && !!dot.style.translate;
    const from = shown ? dot.style.translate : xy(first);
    const moved = from !== xy(first);
    // The glide, as a hand moves a mouse: its time grows with the distance (Fitts's
    // law), its path bows slightly to one side (a quadratic curve through a control
    // point pushed sideways off the midpoint), and its pace follows a minimum-jerk
    // profile — slow off the mark, quick in the middle, slowing to land. The pace is
    // baked into how far apart the sampled points are, so the keyframes run linearly.
    const glidePath = () => {
      const g = cmd.glide;
      if (!shown || !moved || !g) return null;
      const [x0, y0] = from.split(" ").map((v) => parseFloat(v));
      const [x1, y1] = first;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      if (!Number.isFinite(d) || d < 2) return null;
      const glideMs = Math.min(g.maxMs, g.minMs + g.msPerDoubling * Math.log2(1 + d / 16));
      const bow = Math.min(g.maxArcPx, d * g.arc);
      const cx = (x0 + x1) / 2 - (dy / d) * bow;
      const cy = (y0 + y1) / 2 + (dx / d) * bow;
      const steps = 24;
      const path = [];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const s = t * t * t * (10 - 15 * t + 6 * t * t);
        const u = 1 - s;
        path.push(i === steps ? first : [u * u * x0 + 2 * u * s * cx + s * s * x1, u * u * y0 + 2 * u * s * cy + s * s * y1]);
      }
      return { ms: Math.round(glideMs), path };
    };
    const glide = glidePath();
    lead = glide ? glide.ms : 0;
    dot.classList.add("on");
    const total = lead + ms;
    if (total > 0 && (moved || points.length > 1)) {
      // One keyframe per point, timed so the glide takes `lead` and the stroke `ms`.
      const frames = [{ translate: from, offset: 0 }];
      if (glide) {
        glide.path.forEach((p, i) => {
          frames.push({ translate: xy(p), offset: (lead * (i + 1)) / glide.path.length / total });
        });
      }
      points.slice(1).forEach((p, i) => {
        frames.push({ translate: xy(p), offset: (lead + (ms * (i + 1)) / (points.length - 1)) / total });
      });
      frames[frames.length - 1].offset = 1;
      ui.anim = dot.animate(frames, { duration: total, easing: "linear" });
      const anim = ui.anim;
      anim.onfinish = () => {
        if (ui.anim === anim) ui.anim = null;
      };
    }
    dot.style.translate = xy(end);
    at = [end[0], end[1]];
    const pulse = (p) => {
      const ring = document.createElement("div");
      ring.className = "ring";
      ring.style.translate = xy(p);
      ring.addEventListener("animationend", () => ring.remove());
      root.appendChild(ring);
      setTimeout(() => ring.remove(), 1000);
    };
    if (cmd.hold) {
      later(() => {
        dot.classList.add("pressed");
        pulse(first);
      }, lead);
      later(() => {
        dot.classList.remove("pressed");
        pulse(end);
      }, total);
    } else {
      const pulses = Math.min(3, Math.max(0, Number(cmd.pulses) || 0));
      for (let i = 0; i < pulses; i++) later(() => pulse(end), total + i * 160);
      if (cmd.pressed === true || cmd.pressed === false) {
        const pressed = cmd.pressed;
        later(() => dot.classList.toggle("pressed", pressed), total);
      }
    }
    clearTimeout(ui.idle);
    ui.idle = setTimeout(() => dot.classList.remove("on", "pressed"), total + idleMs);
  }

  if (cmd.caret) {
    const el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(cmd.caret))}"]`);
    if (el && (el.getAttribute("type") || "").toLowerCase() !== "password") {
      if (ui.caret) ui.caret.remove();
      const caret = document.createElement("div");
      caret.className = "caret";
      root.appendChild(caret);
      ui.caret = caret;
      const px = (v) => parseFloat(v) || 0;
      // Where the end of the text is, measured again each frame while it shows, so it
      // follows a page that scrolls or reflows under it.
      const place = () => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const fontH = (px(cs.fontSize) || 14) * 1.2;
        const lineH = cs.lineHeight === "normal" ? fontH : px(cs.lineHeight) || fontH;
        const top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
        const bottom = r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
        const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
        const right = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
        let h = Math.max(8, Math.min(fontH, bottom - top || fontH));
        let x = left;
        let y = top + (bottom - top - h) / 2;
        if (el.isContentEditable) {
          // A collapsed range has a box only inside text, so end in the last text node.
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let last = null;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) last = n;
          const range = document.createRange();
          if (last) range.setStart(last, last.data.replace(/\s+$/, "").length);
          else range.selectNodeContents(el);
          range.collapse(!!last);
          const rects = range.getClientRects();
          const b = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
          if (b && (b.height || b.left)) {
            x = b.right;
            y = b.top;
            h = b.height || h;
          } else {
            y = top;
          }
        } else if ("value" in el) {
          const value = String(el.value ?? "");
          const multi = el.tagName === "TEXTAREA";
          const line = multi ? value.slice(value.lastIndexOf("\n") + 1) : value;
          const ctx = (ui.canvas ||= document.createElement("canvas")).getContext("2d");
          ctx.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
          x = left + ctx.measureText(line).width - el.scrollLeft;
          if (multi) {
            const lines = value.split("\n").length;
            y = Math.min(bottom - h, top + (lines - 1) * lineH + (lineH - h) / 2 - el.scrollTop);
          }
        }
        x = Math.min(Math.max(x, left), Math.max(left, right - 2));
        y = Math.max(r.top, Math.min(y, r.bottom - h));
        caret.style.translate = `${x}px ${y}px`;
        caret.style.height = `${h}px`;
      };
      const until = performance.now() + (Number(cmd.caretMs) > 0 ? Number(cmd.caretMs) : 1500);
      const tick = () => {
        if (ui.caret !== caret) return;
        if (!el.isConnected || performance.now() > until) {
          caret.remove();
          ui.caret = null;
          return;
        }
        place();
        requestAnimationFrame(tick);
      };
      place();
      requestAnimationFrame(tick);
      // A background tab gets no frames; the timer still takes the caret away.
      setTimeout(() => {
        if (ui.caret === caret) {
          caret.remove();
          ui.caret = null;
        }
      }, until - performance.now() + 50);
    }
  }
  return { ok: true, lead, at };
}

/**
 * What a recorded action acts on, described so a Playwright test can find it again
 * (recording.js `stepFor`; the desktop writes the test). Run *before* the action, while
 * the elements are still there.
 *
 * Each of `refs` becomes `{role, name, label, placeholder, text, testid, css, sensitive}`
 * — whatever is known: an implicit or explicit ARIA role with its accessible name, the
 * field's label or placeholder, a `data-testid`, its visible text and a CSS path, which
 * the test tries in that order of preference. `sensitive` marks a field whose value must
 * not be written into a test (a password, a card number, a one-time code). `point` and
 * `points` (screenshot pixels) are turned into page (CSS) pixels as `mouse` does, and a
 * ref's centre is given too, for mouse actions. A password's value is never read.
 */
export function describe(refs, point, points, pxPerCss) {
  const MAX = 120;
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ").slice(0, MAX);
  const byRef = (ref) => document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
  const TEXTBOX = new Set(["", "text", "email", "tel", "url", "number", "password", "search"]);
  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (TEXTBOX.has(type)) return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img" && el.getAttribute("alt")) return "img";
    return "";
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "");
      return clean(parts.join(" "));
    }
    return "";
  };
  const nameOf = (el, role, label) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (label) return label;
    if (["button", "link", "checkbox", "radio", "tab", "menuitem", "heading"].includes(role)) {
      const tag = el.tagName.toLowerCase();
      if (tag === "input") return clean(el.value || el.getAttribute("alt"));
      return clean(el.innerText || el.getAttribute("title") || el.getAttribute("alt"));
    }
    if (role === "img") return clean(el.getAttribute("alt"));
    return clean(el.getAttribute("title"));
  };
  const cssOf = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)
        && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${el.id}`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      const tag = node.tagName.toLowerCase();
      const same = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const sensitiveOf = (el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    return type === "password" || /cc-|password|one-time-code/.test(auto);
  };
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const targets = {};
  for (const ref of Array.isArray(refs) ? refs : []) {
    const el = byRef(ref);
    if (!el) continue;
    const role = roleOf(el);
    const label = labelOf(el);
    const d = { role, name: nameOf(el, role, label), css: cssOf(el), at: centre(el) };
    if (label) d.label = label;
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) d.placeholder = placeholder;
    const testid = clean(el.getAttribute("data-testid") || el.getAttribute("data-test-id"));
    if (testid) d.testid = testid;
    const text = clean(el.innerText);
    if (text && text.length <= 80) d.text = text;
    if (sensitiveOf(el)) d.sensitive = true;
    targets[String(ref)] = d;
  }
  const dpr = Number(pxPerCss) > 0 ? Number(pxPerCss) : window.devicePixelRatio || 1;
  const css = (p) => (Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(Number(v)))
    ? [Number(p[0]) / dpr, Number(p[1]) / dpr] : null);
  return {
    url: location.href,
    title: document.title,
    viewport: [window.innerWidth, window.innerHeight],
    targets,
    point: css(point),
    points: Array.isArray(points) ? points.map(css).filter(Boolean).slice(0, 500) : null,
  };
}

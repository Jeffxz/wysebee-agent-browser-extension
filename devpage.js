// In-page halves of the web development tools: inspecting an element, a quick audit,
// and the page's own performance timings. Injected with chrome.scripting.executeScript,
// like page.js — so each function is self-contained and cannot import or close over
// anything; everything it needs is inside it. None of these needs the debugger.

/**
 * One element, as a web developer would look at it: tag, attributes, box, the styles
 * that decide layout and look, its accessible role and name, and its HTML.
 * Found by a snapshot `ref`, or by a CSS `selector` (the `index`th match).
 */
export function inspect(ref, selector, index, styles) {
  let el = null;
  let matches = null;
  if (ref) {
    el = document.querySelector(`[data-wysebee-ref="${CSS.escape(String(ref))}"]`);
    if (!el) return { ok: false, error: "That ref is gone; take a new snapshot." };
  } else if (selector) {
    let all;
    try {
      all = document.querySelectorAll(String(selector));
    } catch {
      return { ok: false, error: `“${selector}” is not a valid CSS selector.` };
    }
    matches = all.length;
    el = all[Number(index) || 0] || null;
    if (!el) return { ok: false, error: matches ? `There are only ${matches} matches.` : "Nothing matches that selector." };
  } else {
    return { ok: false, error: "Give a ref from browser_snapshot or a CSS selector." };
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s);
  const DEFAULT = [
    "display", "position", "top", "left", "width", "height", "box-sizing", "margin", "padding",
    "border", "color", "background-color", "font-family", "font-size", "font-weight",
    "line-height", "text-align", "z-index", "opacity", "visibility", "overflow",
    "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns",
    "transform", "cursor", "pointer-events",
  ];
  const cs = getComputedStyle(el);
  const wanted = Array.isArray(styles) && styles.length ? styles.slice(0, 100).map(String) : DEFAULT;
  const computed = {};
  for (const p of wanted) computed[p] = cs.getPropertyValue(p);
  const r = el.getBoundingClientRect();
  const attrs = {};
  for (const a of el.attributes) if (a.name !== "data-wysebee-ref") attrs[a.name] = clip(a.value, 300);
  const implicit = {
    A: el.hasAttribute("href") ? "link" : null, BUTTON: "button", NAV: "navigation", MAIN: "main",
    HEADER: "banner", FOOTER: "contentinfo", IMG: "img", SELECT: "combobox", TEXTAREA: "textbox",
    UL: "list", OL: "list", LI: "listitem", TABLE: "table", FORM: "form", DIALOG: "dialog",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    INPUT: { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" }[el.type] || "textbox",
  };
  const labelled = el.getAttribute("aria-labelledby");
  const byLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  const name =
    el.getAttribute("aria-label") ||
    (labelled && labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim()) ||
    byLabel?.textContent?.trim() ||
    el.closest("label")?.textContent?.trim() ||
    el.getAttribute("alt") ||
    el.getAttribute("title") ||
    el.getAttribute("placeholder") ||
    (el.innerText || "").trim();
  return {
    ok: true,
    ...(matches != null ? { matches } : {}),
    tag: el.tagName.toLowerCase(),
    attributes: attrs,
    box: {
      x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
      in_viewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    },
    styles: computed,
    accessibility: {
      role: el.getAttribute("role") || implicit[el.tagName] || null,
      name: clip(String(name || ""), 200),
      focusable: el.tabIndex >= 0,
      hidden: el.closest("[aria-hidden=true]") != null,
    },
    children: el.children.length,
    text: clip((el.innerText || "").trim(), 500),
    html: clip(el.outerHTML.replace(/\sdata-wysebee-ref="\d+"/g, ""), 3000),
  };
}

/**
 * A quick audit of the page: common accessibility, SEO and best-practice problems,
 * each with a few examples. Not Lighthouse — a fast first pass a model can act on.
 */
export function audit() {
  const MAX = 5;
  const issues = [];
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const add = (category, severity, rule, message, els) => {
    const list = [...els];
    if (list.length) issues.push({ category, severity, rule, message, count: list.length, examples: list.slice(0, MAX).map(describe) });
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const accName = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.innerText || el.getAttribute("alt") || el.value || "").trim();

  add("accessibility", "error", "img-alt", "Images without alt text.",
    document.querySelectorAll("img:not([alt])"));
  add("accessibility", "error", "button-name", "Buttons with no accessible name.",
    [...document.querySelectorAll("button,[role=button]")].filter((b) => visible(b) && !accName(b) && !b.querySelector("img[alt]:not([alt=''])")));
  add("accessibility", "error", "link-name", "Links with no accessible name.",
    [...document.querySelectorAll("a[href]")].filter((a) => visible(a) && !accName(a) && !a.querySelector("img[alt]:not([alt=''])")));
  add("accessibility", "error", "label", "Form fields with no label.",
    [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),select,textarea")].filter(
      (f) => visible(f) && !f.getAttribute("aria-label") && !f.getAttribute("aria-labelledby") && !f.closest("label") &&
        !(f.id && document.querySelector(`label[for="${CSS.escape(f.id)}"]`)) && !f.getAttribute("title"),
    ));
  if (!document.documentElement.getAttribute("lang")) add("accessibility", "warning", "html-lang", "The <html> element has no lang.", [document.documentElement]);
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible);
  const skips = [];
  headings.reduce((prev, h) => {
    const level = Number(h.tagName[1]);
    if (prev && level > prev + 1) skips.push(h);
    return level;
  }, 0);
  add("accessibility", "warning", "heading-order", "Heading levels skip (e.g. h2 then h4).", skips);
  const ids = new Map();
  for (const el of document.querySelectorAll("[id]")) ids.set(el.id, [...(ids.get(el.id) || []), el]);
  add("best-practices", "warning", "duplicate-id", "The same id is used more than once.",
    [...ids.values()].filter((l) => l.length > 1).map((l) => l[1]));

  // Contrast, for visible text on an opaque background found up the tree.
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const background = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] >= 1)) return c;
      if (getComputedStyle(n).backgroundImage !== "none") return null;
    }
    return [255, 255, 255];
  };
  const lowContrast = [];
  const textEls = [...document.querySelectorAll("p,span,a,li,td,th,label,button,h1,h2,h3,h4,h5,h6")].slice(0, 1500);
  for (const el of textEls) {
    if (lowContrast.length > 50) break;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const fg = rgb(cs.color);
    const bg = background(el);
    if (!bg || fg.length < 3 || (fg.length >= 4 && fg[3] < 1)) continue;
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push(el);
  }
  add("accessibility", "warning", "color-contrast", "Text below WCAG AA contrast.", lowContrast);

  if (!document.title.trim()) add("seo", "error", "document-title", "The page has no <title>.", [document.documentElement]);
  if (!document.querySelector("meta[name=description]")) add("seo", "warning", "meta-description", "No meta description.", [document.head]);
  if (!document.querySelector("meta[name=viewport]")) add("seo", "warning", "meta-viewport", "No meta viewport, so phones zoom out.", [document.head]);
  if (document.querySelectorAll("h1").length !== 1) add("seo", "warning", "single-h1", `There are ${document.querySelectorAll("h1").length} <h1> elements; one is usual.`, [document.body]);

  if (location.protocol === "https:") {
    add("best-practices", "error", "mixed-content", "http:// resources on an https page.",
      [...document.querySelectorAll("img[src^='http:'],script[src^='http:'],link[href^='http:'],iframe[src^='http:']")]);
  }
  add("best-practices", "warning", "image-size", "Images drawn much smaller than their file (wasted bytes).",
    [...document.images].filter((i) => i.complete && i.naturalWidth > 2 * i.clientWidth * devicePixelRatio && i.clientWidth > 0));
  add("best-practices", "warning", "target-blank", "target=_blank links without rel=noopener.",
    document.querySelectorAll("a[target=_blank]:not([rel~=noopener]):not([rel~=noreferrer])"));

  const counts = { error: 0, warning: 0 };
  for (const i of issues) counts[i.severity] += 1;
  return { ok: true, url: location.href, summary: counts, issues };
}

/** The page's own timings: navigation, paints, LCP, layout shift, resources. */
export async function timings() {
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
  const observe = (type) =>
    new Promise((resolve) => {
      const seen = [];
      try {
        const po = new PerformanceObserver((list) => seen.push(...list.getEntries()));
        po.observe({ type, buffered: true });
        setTimeout(() => {
          po.disconnect();
          resolve(seen);
        }, 50);
      } catch {
        resolve(seen);
      }
    });
  const [lcp, shifts, longTasks] = await Promise.all([observe("largest-contentful-paint"), observe("layout-shift"), observe("longtask")]);
  const resources = performance.getEntriesByType("resource");
  const byType = {};
  for (const r of resources) {
    const t = r.initiatorType || "other";
    byType[t] = byType[t] || { count: 0, transfer_bytes: 0 };
    byType[t].count += 1;
    byType[t].transfer_bytes += r.transferSize || 0;
  }
  const slowest = [...resources]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
    .map((r) => ({ url: r.name.slice(0, 300), ms: Math.round(r.duration), type: r.initiatorType }));
  const ms = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const last = lcp[lcp.length - 1];
  return {
    ok: true,
    url: location.href,
    navigation: nav
      ? {
          type: nav.type,
          ttfb_ms: ms(nav.responseStart - nav.requestStart),
          dom_content_loaded_ms: ms(nav.domContentLoadedEventEnd),
          load_ms: ms(nav.loadEventEnd),
          transfer_bytes: nav.transferSize,
        }
      : null,
    first_paint_ms: paint["first-paint"] ?? null,
    first_contentful_paint_ms: paint["first-contentful-paint"] ?? null,
    largest_contentful_paint_ms: last ? ms(last.startTime) : null,
    cumulative_layout_shift: Number(shifts.filter((s) => !s.hadRecentInput).reduce((a, s) => a + s.value, 0).toFixed(4)),
    long_tasks: { count: longTasks.length, total_ms: ms(longTasks.reduce((a, t) => a + t.duration, 0)) },
    resources: { count: resources.length, by_type: byType, slowest },
    dom_nodes: document.getElementsByTagName("*").length,
  };
}

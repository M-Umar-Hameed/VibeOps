// Semantic snapshot builder — Epic C §1.1
// Pure functions operating on a passed document node; no global DOM constructors.

import { frameOffset } from "./cdp.js";

const LANDMARK_TAGS = new Set(["main", "nav", "header", "footer", "aside", "form", "section"]);
const LANDMARK_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "search",
]);

/**
 * Collect interactive elements from document in document order.
 * Returns array of { element, role }.
 * @param {Document} doc
 * @returns {Array<{element: Element, role: string}>}
 */
// Order = role precedence when an element matches several. Option covers react-select / ARIA listboxes.
const ROLE_SELECTORS = [
  ["button", 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'],
  ["link", 'a[href], [role="link"]'],
  ["textbox", 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea, [role="textbox"], [contenteditable="true"], [contenteditable=""]'],
  ["combobox", 'select, [role="combobox"]'],
  ["checkbox", 'input[type="checkbox"], [role="checkbox"]'],
  ["radio", 'input[type="radio"], [role="radio"]'],
  ["menuitem", '[role="menuitem"]'],
  ["tab", '[role="tab"]'],
  ["option", '[role="option"]'],
];
const INTERACTIVE = ROLE_SELECTORS.map(([, s]) => s).join(", ");

function roleOf(el) {
  for (const [role, sel] of ROLE_SELECTORS) if (el.matches(sel)) return role;
  return null;
}

// ponytail: the getComputedStyle fallback (jsdom) checks the element itself only; Chrome's checkVisibility covers hidden ancestors.
// Zero-size elements are still offered: jsdom reports 0x0 for everything, and execute.js sends them down the synthetic path.
function isOffered(el) {
  if (el.closest('[aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  const s = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !s || (s.display !== "none" && s.visibility !== "hidden");
}

/**
 * Collect interactive elements in document order, entering open shadow roots
 * (at the host's position) and same-origin frames. Returns array of { element, role }.
 * @param {Document} doc
 * @returns {Array<{element: Element, role: string}>}
 */
export function collectInteractive(doc) {
  const out = [];
  const visit = (root) => {
    const w = root.ownerDocument.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
    for (let el = w.nextNode(); el; el = w.nextNode()) {
      if (el.matches(INTERACTIVE) && isOffered(el)) out.push({ element: el, role: roleOf(el) });
      if (el.shadowRoot) visit(el.shadowRoot); // closed roots are null: out of reach by design
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let fd = null;
        try { fd = el.contentDocument; } catch { fd = null; } // cross-origin: null or throws; stays out of scope
        const sameOrigin = fd && (fd.location?.origin === doc.location?.origin || fd.URL === "about:blank" || fd.URL === "about:srcdoc");
        if (sameOrigin && fd.documentElement) visit(fd.documentElement);
      }
    }
  };
  visit(doc.documentElement);
  return out;
}

/**
 * Compute accessible name: aria-label > label[for] > ancestor label > textContent.
 * @param {Element} el
 * @param {Document} doc
 * @returns {string}
 */
function getAccessibleName(el, doc, ctx) {
  // 1. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  // aria-labelledby: ids resolve in the element's own root (document, shadow root or frame)
  const root = typeof el.getRootNode === "function" && typeof el.getRootNode().getElementById === "function" ? el.getRootNode() : doc;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((i) => root.getElementById(i)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text) return text;
  }

  // 2. label[for=id] or ancestor <label>. Lookup built once per root (first label wins).
  const id = el.getAttribute("id");
  if (id) {
    ctx.labels ??= new Map();
    let m = ctx.labels.get(root);
    if (!m) {
      m = new Map();
      for (const l of root.querySelectorAll("label[for]")) {
        const f = l.getAttribute("for");
        if (!m.has(f)) m.set(f, l);
      }
      ctx.labels.set(root, m);
    }
    const labelFor = m.get(id);
    if (labelFor) {
      const text = (labelFor.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }

  // Check ancestor <label>
  let ancestor = el.parentElement;
  while (ancestor) {
    if (ancestor.tagName.toLowerCase() === "label") {
      const text = (ancestor.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    ancestor = ancestor.parentElement;
  }

  // 3. textContent
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Get value for inputs/textarea/select.
 * @param {Element} el
 * @param {string} role
 * @returns {string|undefined}
 */
function getValue(el, role) {
  if (role === "textbox" || role === "combobox") {
    return el.value !== undefined ? String(el.value) : undefined;
  }
  return undefined;
}

/**
 * Get state array.
 * @param {Element} el
 * @param {string} role
 * @returns {string[]|undefined}
 */
function getState(el, role) {
  const state = [];

  // disabled
  if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
    state.push("disabled");
  }

  // checked (checkbox/radio)
  if ((role === "checkbox" || role === "radio") && el.checked === true) {
    state.push("checked");
  }

  // expanded
  if (el.getAttribute("aria-expanded") === "true") {
    state.push("expanded");
  }

  return state.length > 0 ? state : undefined;
}

/**
 * Get anchor path from landmarks/heading.
 * @param {Element} el
 * @param {Document} doc
 * @returns {string}
 */
function getAnchor(el, doc, ctx) {
  const parts = [];

  // Walk ancestors from element up to root, collect landmarks
  let current = el.parentElement;
  while (current) {
    const tag = current.tagName.toLowerCase();
    const role = current.getAttribute("role");

    let landmarkRole = null;
    if (LANDMARK_TAGS.has(tag)) {
      landmarkRole = tag;
    } else if (role && LANDMARK_ROLES.has(role)) {
      landmarkRole = role;
    }

    if (landmarkRole) {
      const label = current.getAttribute("aria-label");
      // ponytail: anchor label = aria-label only; add aria-labelledby/heading resolution when a recipe needs it.
      if (label && label.trim()) {
        parts.unshift(`${landmarkRole}[${label.trim()}]`);
      } else {
        parts.unshift(landmarkRole);
      }
    }

    current = current.parentElement;
  }

  if (parts.length > 0) {
    return parts.join(">");
  }

  // Fallback: nearest preceding heading
  // Walk backwards through document to find heading before this element
  const allHeadings = (ctx.headings ??= doc.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  let nearestHeading = null;
  for (const h of allHeadings) {
    const pos = h.compareDocumentPosition(el);
    if (pos & 4) {
      // el follows h
      nearestHeading = h;
    } else {
      break;
    }
  }

  if (nearestHeading) {
    const tag = nearestHeading.tagName.toLowerCase();
    const text = (nearestHeading.textContent || "").replace(/\s+/g, " ").trim();
    return `${tag}[${text}]`;
  }

  return "";
}

/**
 * Page-coordinate box for an element, or null when it has none (display:none,
 * zero-size). Absent and at-origin are different facts, so null is not {0,0,0,0}.
 * CSS pixels, page-relative (viewport rect + scroll) so a box stays meaningful
 * after the page scrolls.
 * @param {Element} el
 * @param {Window} view
 * @returns {{x: number, y: number, w: number, h: number} | null}
 */
function getRect(el, view) {
  try {
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    // Framed elements: rect is frame-viewport-relative; add the frame chain's offset.
    const o = el.ownerDocument.defaultView === view ? null : frameOffset(el.ownerDocument.defaultView);
    return {
      x: r.left + (o?.x ?? 0) + (view.scrollX || 0),
      y: r.top + (o?.y ?? 0) + (view.scrollY || 0),
      w: r.width,
      h: r.height,
    };
  } catch {
    return null;
  }
}

/**
 * Build snapshot from document.
 * @param {Document} doc
 * @param {string} instanceId
 * @returns {{instanceId: string, origin: string, identity: null, nodes: Array, viewport: object}}
 */
export function buildSnapshot(doc, instanceId) {
  const view = doc.defaultView || { scrollX: 0, scrollY: 0, devicePixelRatio: 1, innerWidth: 0, innerHeight: 0 };
  const interactive = collectInteractive(doc);
  const ctx = {};
  const nodes = interactive.map((item, i) => {
    const { element, role } = item;
    const node = {
      ref: `ref${i + 1}`,
      role,
      name: getAccessibleName(element, doc, ctx),
      anchor: getAnchor(element, doc, ctx),
      rect: getRect(element, view),
    };

    const value = getValue(element, role);
    if (value !== undefined) {
      node.value = value;
    }

    const state = getState(element, role);
    if (state !== undefined) {
      node.state = state;
    }

    return node;
  });

  return {
    instanceId,
    origin: doc.location?.origin ?? "",
    identity: null,
    nodes,
    // Captured in the SAME pass as the rects above. captureVisibleTab returns
    // PHYSICAL pixels while rects are CSS pixels, so anything drawing on or
    // clicking into a screenshot needs dpr and the scroll offsets from this
    // exact moment — taken later they describe a page that has already moved.
    viewport: {
      dpr: view.devicePixelRatio || 1,
      scrollX: view.scrollX || 0,
      scrollY: view.scrollY || 0,
      viewportW: view.innerWidth || 0,
      viewportH: view.innerHeight || 0,
    },
  };
}

// Semantic snapshot builder — Epic C §1.1
// Pure functions operating on a passed document node; no global DOM constructors.

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
export function collectInteractive(doc) {
  const results = [];

  // Button
  for (const el of doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')) {
    results.push({ element: el, role: "button" });
  }

  // Link
  for (const el of doc.querySelectorAll('a[href], [role="link"]')) {
    results.push({ element: el, role: "link" });
  }

  // Textbox
  for (const el of doc.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea, [role="textbox"], [contenteditable="true"], [contenteditable=""]'
  )) {
    // input without type defaults to text, but skip if already collected
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && !el.getAttribute("type") && results.some((r) => r.element === el)) continue;
    results.push({ element: el, role: "textbox" });
  }

  // Combobox
  for (const el of doc.querySelectorAll('select, [role="combobox"]')) {
    results.push({ element: el, role: "combobox" });
  }

  // Checkbox
  for (const el of doc.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
    results.push({ element: el, role: "checkbox" });
  }

  // Radio
  for (const el of doc.querySelectorAll('input[type="radio"], [role="radio"]')) {
    results.push({ element: el, role: "radio" });
  }

  // Menuitem
  for (const el of doc.querySelectorAll('[role="menuitem"]')) {
    results.push({ element: el, role: "menuitem" });
  }

  // Tab
  for (const el of doc.querySelectorAll('[role="tab"]')) {
    results.push({ element: el, role: "tab" });
  }

  // Dedupe (element may match multiple selectors) and sort by document order
  const seen = new Set();
  const unique = [];
  for (const item of results) {
    if (!seen.has(item.element)) {
      seen.add(item.element);
      unique.push(item);
    }
  }

  // Sort by document position
  unique.sort((a, b) => {
    const pos = a.element.compareDocumentPosition(b.element);
    if (pos & 4) return -1; // b follows a
    if (pos & 2) return 1; // a follows b
    return 0;
  });

  return unique;
}

/**
 * Compute accessible name: aria-label > label[for] > ancestor label > textContent.
 * @param {Element} el
 * @param {Document} doc
 * @returns {string}
 */
function getAccessibleName(el, doc) {
  // 1. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  // 2. label[for=id] or ancestor <label>
  const id = el.getAttribute("id");
  if (id) {
    // Find label by iterating (avoid CSS.escape which requires global)
    const labels = doc.querySelectorAll("label[for]");
    for (const labelFor of labels) {
      if (labelFor.getAttribute("for") === id) {
        const text = (labelFor.textContent || "").replace(/\s+/g, " ").trim();
        if (text) return text;
        break;
      }
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
function getAnchor(el, doc) {
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
  const allHeadings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
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
    return {
      x: r.left + (view.scrollX || 0),
      y: r.top + (view.scrollY || 0),
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
  const nodes = interactive.map((item, i) => {
    const { element, role } = item;
    const node = {
      ref: `ref${i + 1}`,
      role,
      name: getAccessibleName(element, doc),
      anchor: getAnchor(element, doc),
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

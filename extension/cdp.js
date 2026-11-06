// CDP input helpers — trusted events via chrome.debugger

export const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32 };

export function keyCodeNumber(key) {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

export function keyCodeName(key) {
  if (key === " ") return "Space";
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
}

export function usesCdp(step) {
  if (!step) return false;
  if (step.verb === "click" || step.verb === "clickAt" || step.verb === "type" || step.verb === "press") return true;
  if (step.verb === "scroll" && typeof step.dy === "number") return true;
  return false;
}

/**
 * @param {string} key
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number, text?: string }}
 */
export function keyEventParams(key) {
  const code = keyCodeName(key);
  const vk = keyCodeNumber(key);
  const res = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  if (key === "Enter") {
    res.text = "\r";
  } else if (key.length === 1) {
    res.text = key;
  }
  return res;
}

export function keySequence(key) {
  const p = keyEventParams(key);
  const seq = [
    {
      type: "rawKeyDown",
      key: p.key,
      code: p.code,
      windowsVirtualKeyCode: p.windowsVirtualKeyCode,
      nativeVirtualKeyCode: p.nativeVirtualKeyCode,
    },
  ];
  if (p.text !== undefined) {
    seq.push({
      type: "char",
      key: p.key,
      code: p.code,
      windowsVirtualKeyCode: p.windowsVirtualKeyCode,
      nativeVirtualKeyCode: p.nativeVirtualKeyCode,
      text: p.text,
      unmodifiedText: p.text,
    });
  }
  seq.push({
    type: "keyUp",
    key: p.key,
    code: p.code,
    windowsVirtualKeyCode: p.windowsVirtualKeyCode,
    nativeVirtualKeyCode: p.nativeVirtualKeyCode,
  });
  return seq;
}

export function centrePoint(rect, offset) {
  return {
    x: (offset?.x ?? 0) + rect.left + rect.width / 2,
    y: (offset?.y ?? 0) + rect.top + rect.height / 2,
  };
}

export function frameOffset(view) {
  let x = 0;
  let y = 0;
  let currentView = view;
  while (currentView) {
    try {
      const el = currentView.frameElement;
      if (!el) break;
      const rect = el.getBoundingClientRect();
      x += (rect?.left || 0);
      y += (rect?.top || 0);
      currentView = el.ownerDocument ? el.ownerDocument.defaultView : null;
    } catch {
      break;
    }
  }
  return { x, y };
}

export function wheelParams(w, h, dy) {
  return {
    type: "mouseWheel",
    x: w / 2,
    y: h / 2,
    deltaX: 0,
    deltaY: dy,
  };
}

export async function dispatchCdp(send, cdp) {
  if (!cdp) throw new Error("unknown cdp step");
  if (cdp.verb === "click") {
    const { x, y } = cdp;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return;
  }
  if (cdp.verb === "type") {
    await send("Input.insertText", { text: cdp.text });
    return;
  }
  if (cdp.verb === "press") {
    for (const p of keySequence(cdp.key)) {
      await send("Input.dispatchKeyEvent", p);
    }
    return;
  }
  if (cdp.verb === "scroll") {
    await send("Input.dispatchMouseEvent", wheelParams(cdp.w, cdp.h, cdp.dy));
    return;
  }
  throw new Error("unknown cdp step");
}

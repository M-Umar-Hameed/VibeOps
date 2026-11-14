// Generated pages for the extension latency benchmark (e2e/extension.mjs --bench)
// and the jsdom snapshot operation count (tests/extension-accuracy.test.ts).
// Exactly n interactive elements, all inside <main> so the snapshot's heading
// fallback never runs; the three bench-* controls come first.
export function benchPage(n) {
  if (n < 3) throw new Error("benchPage needs n >= 3");
  const fixed = [
    '<button onclick="this.dataset.clicks=(+this.dataset.clicks||0)+1">bench-click</button>',
    '<input type="text" aria-label="bench-type">',
    '<button onclick="const m=document.getElementById(\'bench-marker\');m.textContent=\'\';setTimeout(()=>{m.textContent=\'bench-ready\'},50)">bench-reveal</button>',
  ];
  const filler = [];
  for (let i = 0; i < n - fixed.length; i++) {
    switch (i % 4) {
      case 0: filler.push(`<button>item ${i}</button>`); break;
      case 1: filler.push(`<a href="#item-${i}">item ${i}</a>`); break;
      case 2: filler.push(`<label for="f${i}">field ${i}</label><input id="f${i}" type="text">`); break;
      default: filler.push(`<select><option>item ${i}</option></select>`);
    }
  }
  return `<!doctype html><html><head><title>bench ${n}</title></head><body><main>${fixed.join("")}${filler.join("")}</main><p id="bench-marker"></p></body></html>`;
}

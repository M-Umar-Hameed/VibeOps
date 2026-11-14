// Per-phase batch timing, collected only when a batch carries timings:true. Pure: clock injected.
export function createPhaseTimer(on, now = () => performance.now()) {
  const phases = {};
  const add = (name, ms) => { phases[name] = (phases[name] ?? 0) + ms; };
  return {
    on,
    add: on ? add : () => {},
    async time(name, fn) {
      if (!on) return fn();
      const t = now();
      try { return await fn(); } finally { add(name, now() - t); }
    },
    result: () => (on ? Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v * 10) / 10])) : undefined),
  };
}

export type ClipOptions = { headChars?: number; tailChars?: number; maxSignalLines?: number; signal?: RegExp; maxLineChars?: number };
export type ClipStats = { totalBytes: number; totalChars: number; totalLines: number; keptChars: number; truncated: boolean; signalLines: number };
export type Clip = { push(chunk: Uint8Array | string): void; finish(): { text: string; stats: ClipStats } };

const DEFAULT_SIGNAL = /\b(error|errors|fail|failed|failure|failing|exception|panic|assert|assertion|traceback|fatal|denied|cannot|not found|undefined|expected|received|TS\d{4})\b/i;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const TRAILING_ESC = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_PARTIAL = 1 << 20;
const MAX_ESC_CARRY = 4096;

const countNl = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++;
  return n;
};
const lastCr = (l: string) => l.slice(l.lastIndexOf("\r") + 1);

export function createClip(opts: ClipOptions = {}): Clip {
  const headChars = opts.headChars ?? 2000;
  const tailChars = opts.tailChars ?? 6000;
  const maxSignal = opts.maxSignalLines ?? 30;
  const maxLine = opts.maxLineChars ?? 240;
  const signal = opts.signal ?? DEFAULT_SIGNAL;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let escCarry = "";
  let partial = "";
  let head = "";
  let tail = "";
  let evPartial = "";
  let evicted = false;
  let nlBefore = 0;
  let nlTotal = 0;
  let endsNl = true;
  let totalBytes = 0;
  let totalChars = 0;
  const signals: string[] = [];

  const scanEvicted = (text: string) => {
    if (signals.length >= maxSignal) {
      nlBefore += countNl(text);
      return;
    }
    const pieces = (evPartial + text).split("\n");
    evPartial = pieces.pop() as string;
    for (const line of pieces) {
      nlBefore++;
      if (signals.length < maxSignal) {
        signal.lastIndex = 0;
        if (signal.test(line)) signals.push(`L${nlBefore}: ${line.slice(0, maxLine)}`);
      }
    }
  };

  const evict = (cut: number) => {
    evicted = true;
    scanEvicted(tail.slice(0, cut));
    tail = tail.slice(cut);
  };

  const sink = (text: string) => {
    if (!text) return;
    totalChars += text.length;
    nlTotal += countNl(text);
    endsNl = text.endsWith("\n");
    if (head.length < headChars) {
      const take = text.slice(0, headChars - head.length);
      head += take;
      nlBefore += countNl(take);
      text = text.slice(take.length);
    }
    tail += text;
    if (tail.length > 2 * tailChars) {
      const from = tail.length - tailChars;
      const nl = tail.indexOf("\n", from);
      evict(nl >= 0 ? nl + 1 : from);
    }
  };

  const feed = (cleaned: string, final: boolean) => {
    let buf = partial + cleaned.replace(CONTROL, "");
    if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
    const lastNl = buf.lastIndexOf("\n");
    let done = lastNl >= 0 ? buf.slice(0, lastNl + 1) : "";
    partial = buf.slice(lastNl + 1);
    if (done.includes("\r")) done = done.split("\n").map(lastCr).join("\n");
    if (final) {
      done += lastCr(partial);
      partial = "";
    } else if (partial.length > MAX_PARTIAL) {
      done += lastCr(partial);
      partial = "";
    }
    sink(done);
  };

  const clean = (text: string, final: boolean) => {
    let s = escCarry + text;
    escCarry = "";
    if (!final) {
      const m = TRAILING_ESC.exec(s);
      if (m && m[0].length <= MAX_ESC_CARRY) {
        escCarry = m[0];
        s = s.slice(0, m.index);
      }
    }
    feed(s.replace(ANSI, ""), final);
  };

  return {
    push(chunk) {
      if (typeof chunk === "string") {
        totalBytes += Buffer.byteLength(chunk);
        clean(chunk, false);
      } else {
        totalBytes += chunk.byteLength;
        clean(decoder.decode(chunk, { stream: true }), false);
      }
    },
    finish() {
      clean(decoder.decode(), true);
      const stats = (text: string, truncated: boolean): { text: string; stats: ClipStats } => ({
        text,
        stats: { totalBytes, totalChars, totalLines: nlTotal + (endsNl ? 0 : 1), keptChars: text.length, truncated, signalLines: signals.length },
      });
      if (!evicted && totalChars <= headChars + 2 * tailChars) return stats(head + tail, false);
      if (tail.length > tailChars) {
        const cut = tail.length - tailChars;
        const nl = tail.indexOf("\n", cut);
        evict(nl >= 0 && nl - cut < tailChars * 0.2 ? nl + 1 : cut);
      }
      const omittedChars = totalChars - head.length - tail.length;
      const omittedLines = Math.max(0, nlTotal - countNl(head) - countNl(tail));
      const out = [
        head,
        `[... clipped: ${omittedChars} chars / ${omittedLines} lines omitted; ${signals.length} matching lines kept ...]`,
        ...signals,
        "[... end of clipped section ...]",
        tail,
      ].join("\n");
      return stats(out, true);
    },
  };
}

export function clipText(text: string, opts?: ClipOptions): { text: string; stats: ClipStats } {
  const c = createClip(opts);
  c.push(text);
  return c.finish();
}

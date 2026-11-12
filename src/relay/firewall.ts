// Server copy of blueprint/firewall.ts plus the ALLOW-COMMAND lift hook (FirewallOptions.lift) and dialect-aware Windows drive exclusion in remoteRule. Keep rule logic in sync with blueprint/.
import fs from "node:fs";
import os from "node:os";

export type Dialect = "posix" | "powershell";
export type FirewallOptions = {
  workspace: string;
  cwd?: string;
  dialect?: Dialect;
  allowHosts?: readonly string[];
  home?: string;
  lift?: (hit: LiftHit) => boolean;
};
export type Verdict = { allow: true } | { allow: false; rule: string; reason: string; segment: string };
export type LiftHit = { rule: string; reason: string; name: string; args: readonly string[] };

type Word = { t: "w"; text: string; raw: string; quoted: boolean; dynamic: boolean; glob: boolean };
type Tok = Word | { t: "op"; op: string } | { t: "re"; op: string; dup: boolean };
type Lexed = { toks: Tok[]; subs: string[]; bodies: string[]; end: number };
type Simple = { words: Word[]; redirs: Word[]; pipe: number; pid: number; call: boolean };
type Ctx = { dialect: Dialect; depth: number; cwd: string | null; ws: string; win: boolean; home: string; hosts: string[]; tmp: string[]; lift?: (hit: LiftHit) => boolean };
type K = { name: string; args: Word[]; a: string[]; c: Ctx; pipe: number; stdin: boolean; seg: string; sql?: string };

class ParseError extends Error {}

const ALLOW: Verdict = { allow: true };
const deny = (rule: string, reason: string, segment: string): Verdict => ({ allow: false, rule, reason, segment });
const d = (k: K, rule: string, reason: string): Verdict | undefined =>
  k.c.lift?.({ rule, reason, name: k.name, args: k.a }) ? undefined : deny(rule, reason, k.seg);
const seg = (w: Word[]) => w.map((x) => x.raw).join(" ");
const mk = (text: string): Word => ({
  t: "w", text, raw: text, quoted: false, dynamic: /[$*?[{]|%[A-Za-z_]\w*%/.test(text), glob: /[*?[]/.test(text),
});
const nonOpt = (args: Word[]) => args.filter((x) => x.text[0] !== "-");


const VAR = /\$(?:env:)?(?:[A-Za-z_]\w*|[0-9@*#?$!-])/iy;

function lex(src: string, ps: boolean, start = 0, inSub = false): Lexed {
  const n = src.length;
  const toks: Tok[] = [];
  const subs: string[] = [];
  const bodies: string[] = [];
  const pend: { d: string; strip: boolean; raw: boolean }[] = [];
  let i = start;
  let depth = 0;
  let rs = 0;
  let cur = null as (Word & { lit: boolean }) | null;

  const w = () => (cur ??= ((rs = i), { t: "w", text: "", raw: "", quoted: false, dynamic: false, glob: false, lit: true }));
  const add = (s: string) => {
    const x = w();
    x.text += s;
    x.lit = false;
  };
  const dyn = (s: string) => {
    add(s);
    w().dynamic = true;
  };
  const flush = () => {
    const x = cur;
    if (!x) return;
    x.raw = src.slice(rs, i);
    if (!x.lit && /%[A-Za-z_]\w*%/.test(x.text)) x.dynamic = true;
    toks.push(x);
    cur = null;
  };
  const dropFd = () => {
    const x = cur;
    if (x && !x.quoted && /^\d+$/.test(x.text)) {
      cur = null;
      return true;
    }
    return false;
  };

  const dollar = (k: number): number => {
    const x = src[k + 1];
    if (x === "(") {
      if (src[k + 2] === "(") {
        let dp = 0;
        let j = k + 1;
        for (; j < n; j++) {
          if (src[j] === "(") dp++;
          else if (src[j] === ")" && --dp === 0) break;
        }
        if (j >= n) throw new ParseError("unterminated arithmetic expansion");
        dyn(src.slice(k, j + 1));
        return j + 1;
      }
      const r = lex(src, ps, k + 2, true);
      subs.push(src.slice(k + 2, r.end));
      dyn(src.slice(k, r.end + 1));
      return r.end + 1;
    }
    if (x === "{") {
      const j = src.indexOf("}", k);
      if (j < 0) throw new ParseError("unterminated ${");
      dyn(src.slice(k, j + 1));
      return j + 1;
    }
    VAR.lastIndex = k;
    const m = VAR.exec(src);
    if (m) {
      dyn(m[0]);
      return k + m[0].length;
    }
    add("$");
    return k + 1;
  };

  const backtick = (k: number): number => {
    let j = k + 1;
    let inner = "";
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\" && "`\\$".includes(src[j + 1] ?? "")) {
        inner += src[j + 1];
        j += 2;
      } else inner += src[j++];
    }
    if (j >= n) throw new ParseError("unterminated backtick substitution");
    subs.push(inner);
    dyn(src.slice(k, j + 1));
    return j + 1;
  };

  const scanBody = (body: string) => {
    for (let k = 0; k < body.length; k++) {
      if (body[k] === "\\") k++;
      else if (body.startsWith("$((", k)) continue;
      else if (body.startsWith("$(", k)) {
        const r = lex(body, false, k + 2, true);
        subs.push(body.slice(k + 2, r.end));
        k = r.end;
      } else if (body[k] === "`") {
        const j = body.indexOf("`", k + 1);
        if (j < 0) break;
        subs.push(body.slice(k + 1, j));
        k = j;
      }
    }
  };

  const heredocs = () => {
    for (const h of pend.splice(0)) {
      let body = "";
      while (i < n) {
        const e = src.indexOf("\n", i);
        const line = src.slice(i, e < 0 ? n : e);
        i = e < 0 ? n : e + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.d) break;
        body += line + "\n";
      }
      bodies.push(body);
      if (!h.raw) scanBody(body);
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === "\\" && !ps) {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 >= n) {
        add("\\");
        i++;
        continue;
      }
      w().quoted = true;
      add(src[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`" && ps) {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      w().quoted = true;
      add(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
      continue;
    }
    if (c === "\n") {
      flush();
      toks.push({ t: "op", op: "\n" });
      i++;
      heredocs();
      continue;
    }
    if (c === "#" && (ps || cur === null)) {
      flush();
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ps && c === "@" && cur === null && (src[i + 1] === "'" || src[i + 1] === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const q = src[i + 1];
      const p = src.indexOf("\n", i + 2) + 1;
      const j = src.indexOf(`\n${q}@`, p - 1);
      if (j < 0) throw new ParseError("unterminated here-string");
      w().quoted = true;
      if (q === "'") add(src.slice(p, j));
      else {
        add("");
        for (i = p; i < j; ) {
          if (src[i] === "`") {
            add(src[i + 1] ?? "");
            i += 2;
          } else if (src[i] === "$") i = dollar(i);
          else add(src[i++]);
        }
      }
      i = j + 3;
      continue;
    }
    if (c === "'") {
      w().quoted = true;
      i++;
      for (;;) {
        const j = src.indexOf("'", i);
        if (j < 0) throw new ParseError("unterminated single quote");
        w().text += src.slice(i, j);
        i = j + 1;
        if (ps && src[i] === "'") {
          w().text += "'";
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    if (c === '"') {
      w().quoted = true;
      i++;
      for (;;) {
        if (i >= n) throw new ParseError("unterminated double quote");
        const q = src[i];
        if (q === '"') {
          i++;
          break;
        }
        if (!ps && q === "\\") {
          const nx = src[i + 1];
          if (nx === "\n") i += 2;
          else if (nx !== undefined && '$`"\\'.includes(nx)) {
            add(nx);
            i += 2;
          } else {
            add("\\");
            i++;
          }
        } else if (ps && q === "`") {
          add(src[i + 1] ?? "");
          i += 2;
        } else if (q === "$") i = dollar(i);
        else if (q === "`") i = backtick(i);
        else {
          add(q);
          i++;
        }
      }
      continue;
    }
    if (c === "$" && !ps && src[i + 1] === "'") {
      w().quoted = true;
      i += 2;
      let esc = false;
      for (;;) {
        if (i >= n) throw new ParseError("unterminated $' quote");
        const q = src[i];
        if (q === "'") {
          i++;
          break;
        }
        if (q !== "\\") {
          add(q);
          i++;
          continue;
        }
        esc = true;
        const nx = src[i + 1] ?? "";
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
        if (nx === "x") {
          const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2, i + 4));
          add(m ? String.fromCharCode(parseInt(m[0], 16)) : "x");
          i += 2 + (m ? m[0].length : 0);
        } else if (/[0-7]/.test(nx)) {
          const m = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))!;
          add(String.fromCharCode(parseInt(m[0], 8)));
          i += 1 + m[0].length;
        } else {
          add(simple[nx] ?? nx);
          i += 2;
        }
      }
      if (esc) w().dynamic = true;
      continue;
    }
    if (c === "$") {
      i = dollar(i);
      continue;
    }
    if (c === "`") {
      i = backtick(i);
      continue;
    }
    if (!ps && (c === "<" || c === ">") && src[i + 1] === "(") {
      const r = lex(src, ps, i + 2, true);
      subs.push(src.slice(i + 2, r.end));
      dyn(src.slice(i, r.end + 1));
      i = r.end + 1;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      if (!dropFd()) flush();
      let op = c;
      if (c === "&") {
        i += 2;
        op = "&>";
        if (src[i] === ">") {
          op = "&>>";
          i++;
        }
      } else if (c === ">") {
        i++;
        if (src[i] === ">") {
          op = ">>";
          i++;
        } else if (src[i] === "|") {
          op = ">|";
          i++;
        }
      } else {
        i++;
        if (!ps && src[i] === "<") {
          if (src[i + 1] === "<") {
            op = "<<<";
            i += 2;
          } else {
            i++;
            const strip = src[i] === "-";
            if (strip) i++;
            while (src[i] === " " || src[i] === "\t") i++;
            let dl = "";
            let raw = false;
            while (i < n && !/[\s;&|()<>]/.test(src[i])) {
              const ch = src[i];
              if (ch === "'" || ch === '"') {
                raw = true;
                const j = src.indexOf(ch, i + 1);
                if (j < 0) throw new ParseError("unterminated heredoc delimiter");
                dl += src.slice(i + 1, j);
                i = j + 1;
              } else if (ch === "\\") {
                raw = true;
                dl += src[i + 1] ?? "";
                i += 2;
              } else {
                dl += ch;
              }
            }
            pend.push({ d: dl, strip, raw });
            continue;
          }
        }
      }
      if ((op === ">" || op === "<") && src[i] === "&" && /[\d-]/.test(src[i + 1] ?? "")) {
        i++;
        while (/\d/.test(src[i] ?? "")) i++;
        if (src[i] === "-") i++;
        toks.push({ t: "re", op: op + "&", dup: true });
        continue;
      }
      toks.push({ t: "re", op, dup: false });
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      flush();
      let op = c;
      const nx = src[i + 1];
      if ((c === "&" && nx === "&") || (c === "|" && (nx === "|" || nx === "&"))) op = c + nx;
      toks.push({ t: "op", op });
      i += op.length;
      continue;
    }
    if (c === "(") {
      flush();
      depth++;
      toks.push({ t: "op", op: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      flush();
      if (inSub && depth === 0) return { toks, subs, bodies, end: i };
      depth = Math.max(0, depth - 1);
      toks.push({ t: "op", op: ")" });
      i++;
      continue;
    }
    if (cur === null && (c === "{" || c === "}")) {
      const nx = src[i + 1];
      if (nx === undefined || /\s/.test(nx) || (c === "}" && /[;&|)]/.test(nx))) {
        toks.push({ t: "op", op: c });
        i++;
        continue;
      }
    }
    const x = w();
    x.text += c;
    x.lit = false;
    if (c === "*" || c === "?" || c === "[") x.dynamic = x.glob = true;
    else if (c === "{") x.dynamic = true;
    i++;
  }
  if (inSub) throw new ParseError("unterminated command substitution");
  flush();
  return { toks, subs, bodies, end: n };
}

function parse(toks: Tok[], ps: boolean): Simple[] {
  const out: Simple[] = [];
  let words: Word[] = [];
  let redirs: Word[] = [];
  let pipe = 0;
  let pid = 0;
  let call = false;
  const end = () => {
    if (words.length || redirs.length) out.push({ words, redirs, pipe, pid, call });
    words = [];
    redirs = [];
    call = false;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === "w") words.push(t);
    else if (t.t === "re") {
      const nx = toks[k + 1];
      if (nx?.t === "w") {
        k++;
        if (!t.dup && /^(>|>>|>\||&>|&>>)$/.test(t.op)) redirs.push(nx);
      }
    } else if (t.op === "|" || t.op === "|&") {
      end();
      pipe++;
    } else if ("(){}".includes(t.op)) end();
    else if (ps && t.op === "&" && !words.length && !redirs.length) call = true;
    else {
      end();
      pipe = 0;
      pid++;
    }
  }
  end();
  return out;
}


function norm(p: string): string {
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? "";
  const segs: string[] = [];
  for (const s of p.slice(drive.length).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") segs.pop();
    else segs.push(s);
  }
  return drive + "/" + segs.join("/");
}

function existing(p: string, win: boolean): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      let r = fs.realpathSync.native(cur).replace(/\\/g, "/");
      if (win) r = r.toLowerCase();
      r = r.replace(/\/+$/, "");
      if (/^[a-z]:$/i.test(r)) r += "/";
      if (!r) r = "/";
      return rest.length ? r.replace(/\/$/, "") + "/" + rest.reverse().join("/") : r;
    } catch {
      if (cur === "/" || /^[a-z]:\/$/i.test(cur)) return p;
      const i = cur.lastIndexOf("/");
      if (i < 0) return p;
      rest.push(cur.slice(i + 1));
      cur = cur.slice(0, i) || "/";
      if (/^[a-z]:$/i.test(cur)) cur += "/";
    }
  }
}

function canonical(abs: string, win: boolean, follow: boolean): string {
  if (win && !/^[a-z]:/i.test(abs)) return abs;
  let dir = abs;
  let base = "";
  if (!follow) {
    const i = abs.lastIndexOf("/");
    if (abs.slice(i + 1) !== "") {
      base = abs.slice(i + 1);
      dir = abs.slice(0, i) || "/";
      if (/^[a-z]:$/i.test(dir)) dir += "/";
    }
  }
  const r = existing(dir, win);
  return base ? r.replace(/\/$/, "") + "/" + base : r;
}

const HOME = /^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|\$USERPROFILE)(?=$|[/\\])/i;

function resolvePath(w: Word, c: Ctx, del = false): string | null {
  let t = w.text;
  let trail = false;
  let m = HOME.exec(t);
  if (!m && !w.quoted) {
    m = /^~(?=$|[/\\])/.exec(t);
    if (!m && /^~[^/\\]/.test(t)) return null;
  }
  if (m) t = c.home + t.slice(m[0].length);
  if (w.dynamic) {
    const gi = t.search(/[*?[]/);
    if (w.glob && gi >= 0) {
      t = t.slice(0, gi);
      trail = true;
    }
    if (/[$`{]|%[A-Za-z_]\w*%/.test(t)) return null;
  }
  if (c.win || c.dialect === "powershell") t = t.replace(/\\/g, "/");
  let abs: string;
  if (/^[A-Za-z]:/.test(t)) abs = t.length === 2 ? t + "/" : t;
  else if (c.win && /^\/[A-Za-z](\/|$)/.test(t)) abs = t[1] + ":" + t.slice(2);
  else if (t[0] === "/") abs = t;
  else {
    if (c.cwd === null) return null;
    abs = c.cwd + "/" + t;
  }
  abs = norm(abs);
  if (c.win) abs = abs.toLowerCase();
  const follow = !del || trail || t === "" || t.endsWith("/") || /(^|\/)\.{1,2}$/.test(t);
  return canonical(abs, c.win, follow);
}

const inside = (p: string, c: Ctx) => p === c.ws || p.startsWith(c.ws.endsWith("/") ? c.ws : c.ws + "/");
const isRoot = (p: string, c: Ctx) => p === c.ws;

function wcheck(w: Word, c: Ctx): string | null {
  if (/^(nul|\$null|\/dev\/(null|stdout|stderr))$/i.test(w.text)) return null;
  const p = resolvePath(w, c);
  if (p === null) return `cannot resolve ${w.raw}`;
  return inside(p, c) || c.tmp.some((t) => p === t || p.startsWith(t + "/")) ? null : `${w.raw} is outside the workspace`;
}


const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const okHost = (h: string, c: Ctx) => LOCAL.has(h) || c.hosts.some((a) => h === a || h.endsWith("." + a));
const hostOf = (auth: string) => {
  const a = auth.replace(/^.*@/, "").toLowerCase();
  if (a.startsWith("[")) {
    const j = a.indexOf("]");
    return j < 0 ? a : a.slice(0, j + 1);
  }
  return a.replace(/:\d*$/, "");
};
const urlHosts = (a: string[]) =>
  a.flatMap((x) => [...x.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/\s?#]*)/gi)].map((m) => hostOf(m[1])));

function skipOpts(args: Word[], vals: string[]): number {
  let k = 0;
  while (k < args.length) {
    const t = args[k].text;
    if (t === "--") {
      k++;
      break;
    }
    if (t.length > 1 && t[0] === "-") k += vals.includes(t) ? 2 : 1;
    else break;
  }
  return Math.min(k, args.length);
}

const PSV = ["path", "literalpath", "destination", "filepath", "value", "name", "itemtype", "encoding", "filter", "include", "exclude", "credential", "stream"];
const PSF = ["force", "recurse", "append", "noclobber", "whatif", "confirm", "passthru", "nonewline"];

function psp(args: Word[]) {
  const named: Record<string, Word[]> = {};
  const pos: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    const t = x.text;
    if (/^-[A-Za-z]/.test(t)) {
      const ci = t.indexOf(":");
      const p = (ci > 0 ? t.slice(1, ci) : t.slice(1)).toLowerCase();
      const full = (p.length >= 2 && PSF.some((f) => f.startsWith(p))) || p === "f" ? undefined : PSV.find((f) => f.startsWith(p));
      if (full) {
        const v = ci > 0 ? [{ ...x, text: t.slice(ci + 1) }] : args[i + 1] ? [args[++i]] : [];
        (named[full] ??= []).push(...v);
      }
    } else if (!x.quoted && t.includes(",")) pos.push(...t.split(",").filter(Boolean).map(mk));
    else pos.push(x);
  }
  return { named, pos };
}

const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "duckdb", "clickhouse-client"]);
function badSql(sql: string): boolean {
  if (/\b(drop\s+(table|database|schema|view|index|user|role)|truncate\b)/i.test(sql)) return true;
  if (/\balter\s+table\b[^;]*\bdrop\b/i.test(sql)) return true;
  return sql.split(";").some((s) => (/\bdelete\s+from\b/i.test(s) || /\bupdate\b[^;]*\bset\b/i.test(s)) && !/\bwhere\b/i.test(s));
}

const nname = (t: string) =>
  (t.replace(/^\\/, "").split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");


const POSIX_DEL = new Set(["rm", "unlink", "shred", "srm", "rmdir"]);
const PS_DEL = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const CMD_DEL = new Set(["rd", "rmdir", "del", "erase"]);

function delRule(k: K): Verdict | undefined {
  const { name, args, c } = k;
  const slash = args.some((x) => /^\/s$/i.test(x.text));
  const cmdStyle = CMD_DEL.has(name) && (slash || c.dialect === "powershell");
  const ps = (c.dialect === "powershell" && PS_DEL.has(name)) || (CMD_DEL.has(name) && slash);
  if (!ps && !POSIX_DEL.has(name)) return;
  let recursive = false;
  let targets: Word[] = [];
  if (ps) {
    const { named, pos } = psp(args);
    recursive = slash || args.some((x) => isParam(x.text, "recurse"));
    targets = [...(named.path ?? []), ...(named.literalpath ?? []), ...pos.filter((x) => !(cmdStyle && /^\/[a-z?]$/i.test(x.text)))];
  } else {
    let dd = false;
    for (const x of args) {
      const t = x.text;
      if (!dd && t === "--") dd = true;
      else if (!dd && t.length > 1 && t[0] === "-") {
        if (t === "--recursive" || (t[1] !== "-" && /^-[a-zA-Z]*[rR]/.test(t))) recursive = true;
      } else targets.push(x);
    }
  }
  if (!targets.length) return k.pipe > 0 || k.stdin ? d(k, "delete-outside", "delete targets come from a pipe") : undefined;
  for (const x of targets) {
    const p = resolvePath(x, k.c, true);
    if (p === null) return d(k, "delete-outside", `cannot resolve delete target ${x.raw}`);
    if (!inside(p, k.c)) return d(k, "delete-outside", `${x.raw} is outside the workspace`);
    const root = x.glob ? /(^|[/\\])\.?\*+$/.test(x.text) && isRoot(p, k.c) : isRoot(p, k.c);
    if (recursive && root) return d(k, "delete-outside", `recursive delete of the workspace root (${x.raw})`);
  }
}

function findRule(k: K): Verdict | undefined {
  if (k.name !== "find") return;
  const { args, c } = k;
  let e = args.findIndex((x) => /^[-(!]/.test(x.text));
  if (e < 0) e = args.length;
  const starts = args.slice(0, e).length ? args.slice(0, e) : [mk(".")];
  if (args.some((x) => x.text === "-delete")) {
    const filtered = args.some((x) => /^-(i?name|i?path|i?regex)$/.test(x.text));
    for (const s of starts) {
      const p = resolvePath(s, c);
      if (p === null || !inside(p, c) || (isRoot(p, c) && !filtered)) {
        const v = d(k, "find-delete", `find -delete from ${s.raw}`);
        if (v) return v;
      }
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(args[i].text)) continue;
    const body: Word[] = [];
    for (let j = i + 1; j < args.length && args[j].text !== ";" && args[j].text !== "+"; j++) body.push(args[j]);
    for (const s of starts) {
      const v = cmd(body.map((x) => (x.text.includes("{}") ? mk(x.text.split("{}").join(s.text)) : x)), 0, c, false);
      if (!v.allow) return v;
    }
  }
}

function gitRule(k: K): Verdict | undefined {
  if (k.name !== "git") return;
  const a = k.args;
  let i = 0;
  for (; i < a.length && a[i].text[0] === "-"; i++) {
    if (a[i].text === "-C") i++;
    else if (a[i].text === "-c") {
      const v = a[++i]?.text ?? "";
      if (/^(alias\.[^=]+=!|core\.(sshCommand|fsmonitor|hooksPath|pager|editor)=)/i.test(v)) return d(k, "git-config-exec", `git -c ${v} can run commands`);
    }
  }
  const sub = a[i]?.text;
  const r = a.slice(i + 1).map((x) => x.text);
  const has = (...f: string[]) => r.some((x) => f.includes(x));
  const short = (ch: string) => r.some((x) => /^-[A-Za-z]+$/.test(x) && x.includes(ch));
  const all = (x: string) => x === "." || x === ":/" || x === "*";
  const bad = (m: string) => d(k, "git-destructive", `git ${sub}: ${m}`);
  switch (sub) {
    case "push": return bad("publishes work");
    case "reset": if (has("--hard", "--merge", "--keep")) return bad("discards changes"); break;
    case "clean": if (short("f") || has("--force")) return bad("deletes untracked files"); break;
    case "checkout": if (has("-f", "--force") || r.some(all)) return bad("overwrites working tree"); break;
    case "restore": if (r.some(all) && !(has("--staged", "-S") && !has("--worktree", "-W"))) return bad("overwrites working tree"); break;
    case "switch": if (has("--discard-changes", "-f", "--force")) return bad("discards changes"); break;
    case "branch": if (short("D") || ((short("d") || has("--delete")) && (short("f") || has("--force")))) return bad("force deletes a branch"); break;
    case "stash": if (r[0] === "drop" || r[0] === "clear") return bad("drops stashed work"); break;
    case "filter-branch": case "filter-repo": return bad("rewrites history");
    case "reflog": if (r[0] === "expire" || r[0] === "delete") return bad("drops recovery data"); break;
    case "update-ref": if (has("-d")) return bad("deletes a ref"); break;
    case "gc": if (r.some((x) => /^--prune=(now|all)$/.test(x))) return bad("prunes recovery data"); break;
    case "remote": if (r[0] === "add" || r[0] === "set-url") return d(k, "git-remote", "changes where code is sent"); break;
    case "clone": case "fetch": case "pull": {
      const hs = [...urlHosts(r), ...r.flatMap((x) => { const m = /^[^@/\s:]+@([^/\s:]+):/.exec(x); return m ? [m[1].toLowerCase()] : []; })];
      const h = hs.find((x) => !okHost(x, k.c));
      if (h) return d(k, "egress", `git ${sub} from non-allowed host ${h}`);
    }
  }
}

function dbRule(k: K): Verdict | undefined {
  const { name, a } = k;
  const l = a.map((x) => x.toLowerCase());
  const j = a.join(" ");
  const hit = (m: string) => d(k, "db-destructive", m);
  if (k.sql !== undefined && badSql(k.sql)) return hit("destructive SQL");
  // ponytail: scans every literal argument, not only the flag value; add flag-aware parsing if db names collide
  if (SQL_CLIENTS.has(name) && badSql(j)) return hit(`destructive SQL in ${name}`);
  const sub = nonOpt(k.args).map((x) => x.text);
  if (name === "dropdb" || name === "dropuser") return hit(name);
  if (name === "prisma" && ((sub[0] === "migrate" && sub[1] === "reset") || (sub[0] === "db" && sub[1] === "push" && (a.includes("--force-reset") || a.includes("--accept-data-loss"))))) return hit("prisma reset");
  if (name === "drizzle-kit" && sub[0] === "drop") return hit("drizzle-kit drop");
  if ((name === "rails" || name === "rake") && l.some((x) => /^db:(drop|reset|schema:load)$/.test(x))) return hit(`${name} db task`);
  if ((name === "django-admin" || a.some((x) => /(^|[/\\])manage\.py$/.test(x))) && l.includes("flush")) return hit("django flush");
  if ((name === "sequelize" || name === "sequelize-cli") && l.includes("db:drop")) return hit("sequelize db:drop");
  if (name === "typeorm" && l.includes("schema:drop")) return hit("typeorm schema:drop");
  if (name === "supabase" && sub[0] === "db" && sub[1] === "reset") return hit("supabase db reset");
  if (name === "redis-cli" && l.some((x) => x === "flushall" || x === "flushdb")) return hit("redis flush");
  if ((name === "mongo" || name === "mongosh") && /dropDatabase|\.drop\(|deleteMany\(\s*\{\s*\}\s*\)/.test(j)) return hit("mongo drop");
  if (name === "docker" || name === "docker-compose") {
    const s = name === "docker" ? sub : ["compose", ...sub];
    if ((s[0] === "volume" && (s[1] === "rm" || s[1] === "prune")) || (s[0] === "compose" && s[1] === "down" && (a.includes("-v") || a.includes("--volumes"))) || (s[0] === "system" && s[1] === "prune" && a.includes("--volumes"))) return hit("docker data removal");
  }
}

const NET = new Set(["curl", "wget", "http", "https", "xh", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "tftp", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer"]);
const HOSTARG = new Set(["nc", "ncat", "netcat", "telnet", "ftp", "sftp", "tftp"]);

function egressRule(k: K): Verdict | undefined {
  const { name, a } = k;
  if (!NET.has(name)) return;
  const hosts = urlHosts(a);
  if (HOSTARG.has(name)) {
    const h = nonOpt(k.args)[0];
    if (h) hosts.push(hostOf(h.text));
  }
  if (name === "socat") for (const x of a) { const m = /^(?:tcp|udp|ssl|openssl)[a-z0-9-]*:([^:]+)/i.exec(x); if (m) hosts.push(m[1].toLowerCase()); }
  const bad = hosts.find((h) => !okHost(h, k.c));
  if (bad) return d(k, "egress", `network access to non-allowed host ${bad}`);
  const upload = a.some((x, i) =>
    /^(-T|--upload-file|--post-file|--body-file)$/.test(x) || /^-infile/i.test(x) || /^-T./.test(x) ||
    (/^(-d|--data(-\w+)*|--json|-F|--form(-string)?)$/.test(x) && /(^|=)@/.test(a[i + 1] ?? "")) || /^-[dF]@/.test(x),
  );
  if (upload && hosts.some((h) => !LOCAL.has(h))) return d(k, "egress-upload", "uploads a local file to a remote host");
}

const SSHVAL = ["-o", "-p", "-i", "-l", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-m", "-O", "-S", "-W", "-w", "-E", "-B", "-I", "-Q"];

function remoteRule(k: K): Verdict | undefined {
  const { name, args, a } = k;
  if (name === "ssh") {
    const h = args.slice(skipOpts(args, SSHVAL))[0] ?? nonOpt(args)[0];
    if (h) return d(k, "egress-remote-shell", `ssh to ${h.raw}`);
  }
  if (name === "scp" || name === "rsync" || name === "sftp") {
    const r = a.find((x) => x[0] !== "-" && /^([^@/\s]+@)?[^/\s:]+:/.test(x) && !(k.c.dialect === "powershell" && /^[A-Za-z]:[\\/]/.test(x)));
    if (r) return d(k, "egress-remote-shell", `${name} to remote ${r}`);
  }
}

const INL = ["system(", "exec(", "execSync", "spawn", "popen", "subprocess", "child_process", "os.remove", "os.unlink", "unlink(", "rmtree", "rmSync", "rmdirSync", "unlinkSync", "fetch(", "urlopen", "requests.", "http.request", "https.request", "socket", "XMLHttpRequest", "Net::HTTP", "LWP::"];
const INTERP = /^(python[\d.]*|py|node|deno|bun|perl|ruby|php)$/;
const inlineFlag = (x: string) => /^--(eval|print)(=|$)/.test(x) || /^-[A-Za-z]*[ceEpr]$/.test(x);

const codeArgs = (a: string[]) =>
  a.flatMap((x, i) => {
    const m = /^(--(?:eval|print)|-[A-Za-z]*[ceEpr])(?:=([\s\S]*))?$/.exec(x);
    return m ? [m[2] ?? a[i + 1] ?? ""] : [];
  });

function inlineRule(k: K): Verdict | undefined {
  if (!INTERP.test(k.name)) return;
  const j = codeArgs(k.a).join(" ");
  const s = INL.find((x) => j.includes(x));
  if (s) return d(k, "inline-code", `inline ${k.name} code uses ${s}`);
}

function pubRule(k: K): Verdict | undefined {
  const { name, a } = k;
  const p = a.filter((x) => x[0] !== "-");
  const pair = (x: string, ys: string[]) => p.some((v, i) => v === x && ys.includes(p[i + 1]));
  let hit = false;
  switch (name) {
    case "npm": case "pnpm": case "yarn": case "bun": hit = p.includes("publish"); break;
    case "cargo": hit = p[0] === "publish"; break;
    case "twine": hit = p[0] === "upload"; break;
    case "gem": hit = p[0] === "push"; break;
    case "docker": hit = p.includes("push"); break;
    case "vercel": case "heroku": hit = true; break;
    case "netlify": case "fly": case "flyctl": case "firebase": hit = p[0] === "deploy"; break;
    case "wrangler": hit = p[0] === "deploy" || p[0] === "publish"; break;
    case "gh": {
      const m = a.findIndex((x) => /^(-X|--method)$/.test(x));
      const method = m >= 0 ? a[m + 1] : a.find((x) => /^(-X.|--method=)/.test(x))?.replace(/^(-X|--method=)/, "");
      const fields = a.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x));
      hit = pair("pr", ["create", "merge"]) || pair("release", ["create", "upload"]) || pair("repo", ["create", "delete", "edit"]) || pair("issue", ["create", "close", "delete"]) ||
        (p[0] === "api" && (method ? method.toUpperCase() !== "GET" : fields));
      break;
    }
    case "aws": hit = pair("s3", ["cp", "sync", "mv", "rm"]) && a.some((x) => x.includes("s3://")); break;
    case "gsutil": hit = ["cp", "rsync", "rm"].includes(p[0]); break;
    case "kubectl": hit = ["apply", "delete", "replace", "patch"].includes(p[0]); break;
    case "terraform": hit = p[0] === "apply" || p[0] === "destroy"; break;
    case "helm": hit = ["install", "upgrade", "uninstall"].includes(p[0]); break;
  }
  if (hit) return d(k, "publish-deploy", `${name} publishes or deploys`);
}

function scriptRule(k: K): Verdict | undefined {
  const { name, args, c } = k;
  if (!["npm", "pnpm", "yarn", "bun"].includes(name) || c.cwd === null) return;
  const p = nonOpt(args).map((x) => x.text);
  let s: string | undefined;
  if (name === "npm") s = p[0] === "run" || p[0] === "run-script" ? p[1] : p[0] === "test" || p[0] === "start" ? p[0] : undefined;
  else if (name === "bun") s = p[0] === "run" ? p[1] : undefined;
  else s = p[0] === "run" ? p[1] : p[0];
  if (!s) return;
  if (/^(deploy|publish|release)(:|$)/.test(s)) {
    const v = d(k, "publish-deploy", `script "${s}" ships the project`);
    if (v) return v;
  }
  let scripts: Record<string, unknown>;
  try {
    scripts = JSON.parse(fs.readFileSync(c.cwd + "/package.json", "utf8")).scripts ?? {};
  } catch {
    return;
  }
  for (const key of ["pre" + s, s, "post" + s]) {
    const body = scripts[key];
    if (typeof body !== "string") continue;
    const v = run(body, { ...c, dialect: "posix", depth: c.depth + 1 });
    if (!v.allow) return v;
  }
}

function sysRule(k: K): Verdict | undefined {
  const { name, a } = k;
  const l = a.map((x) => x.toLowerCase());
  const hit =
    name.startsWith("mkfs") || ["fdisk", "parted", "diskpart", "format-volume", "clear-disk", "initialize-disk", "shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer", "new-service"].includes(name) ||
    (name === "format" && a.some((x) => /^[A-Za-z]:\\?$/.test(x))) ||
    (name === "dd" && a.some((x) => x.startsWith("of="))) ||
    (name === "init" && (a[0] === "0" || a[0] === "6")) ||
    (name === "systemctl" && l.some((x) => ["poweroff", "reboot", "halt", "enable"].includes(x))) ||
    (name === "crontab" && !(a.length === 1 && a[0] === "-l")) ||
    (name === "schtasks" && l.includes("/create")) ||
    (name === "reg" && (l[0] === "add" || l[0] === "delete")) ||
    (name === "sc" && (l[0] === "create" || l[0] === "delete")) ||
    (name === "launchctl" && l[0] === "load");
  if (hit) return d(k, "system", `${name} changes the machine`);
}

function lnRule(k: K): Verdict | undefined {
  const { args, c } = k;
  const p = nonOpt(args);
  if (!p.length) return;
  const dest = p[p.length - 1];
  const bad = wcheck(dest, c);
  if (bad) return d(k, "write-outside", bad);
  if (!args.some((x) => x.text === "--symbolic" || /^-[A-Za-z]*s/.test(x.text) && x.text[1] !== "-")) return;
  const dp = resolvePath(dest, c);
  const base = dp === null ? null : dest.text.endsWith("/") ? dp : dp.slice(0, dp.lastIndexOf("/")) || "/";
  for (const t of p.length === 1 ? p : p.slice(0, -1)) {
    const q = base === null ? null : resolvePath(t, { ...c, cwd: base });
    if (q === null || !inside(q, c)) return d(k, "symlink-outside", `symlink target ${t.raw} is outside the workspace`);
  }
}

function writeRule(k: K): Verdict | undefined {
  const { name, args, c } = k;
  const p = nonOpt(args);
  let t: Word[] = [];
  if (c.dialect === "powershell") {
    const { named: nm, pos } = psp(args);
    const P = [...(nm.path ?? []), ...(nm.literalpath ?? []), ...(nm.filepath ?? [])];
    const D = nm.destination ?? [];
    if (["set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni"].includes(name)) t = [...P, ...D, ...(P.length ? [] : pos.slice(0, 1))];
    else if (["copy-item", "cp", "copy"].includes(name)) t = D.length ? D : pos.slice(P.length ? 0 : 1, P.length ? 1 : 2);
    else if (["move-item", "mv", "move"].includes(name)) t = [...P, ...D, ...pos];
  } else {
    switch (name) {
      case "tee": case "mv": case "touch": case "mkdir": case "truncate": t = p; break;
      case "cp": case "install": {
        const ti = args.findIndex((x) => x.text === "-t" || x.text === "--target-directory");
        const eq = args.find((x) => x.text.startsWith("--target-directory="));
        t = ti >= 0 ? args.slice(ti + 1, ti + 2) : eq ? [{ ...eq, text: eq.text.slice(19) }] : p.slice(-1);
        break;
      }
      case "ln": return lnRule(k);
      case "chmod": case "chown": case "chgrp": t = p.slice(1); break;
    }
  }
  for (const x of t) {
    const bad = wcheck(x, c);
    if (bad) return d(k, "write-outside", bad);
  }
}

const RULES = [delRule, findRule, gitRule, dbRule, egressRule, remoteRule, inlineRule, pubRule, scriptRule, sysRule, writeRule];


const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const PIPESH = new Set([...SHELLS, "pwsh", "powershell", "iex", "invoke-expression", "python", "python3", "node", "perl", "ruby"]);
const CD = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
const CONTROL = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "in", "!", "esac"]);
const HEADER = new Set(["for", "case", "function", "select"]);
const isParam = (t: string, full: string) => {
  const p = t.slice(1).split(":")[0].toLowerCase();
  return t[0] === "-" && p !== "" && full.startsWith(p);
};

function cmd(words0: Word[], pipe: number, c: Ctx, stdin: boolean, sql?: string, call = false): Verdict {
  let words = words0;
  const sub = (s: string, dialect: Dialect) => run(s, { ...c, dialect, depth: c.depth + 1 });
  if (c.dialect === "posix") {
    while (words.length && CONTROL.has(words[0].text)) words = words.slice(1);
    if (words.length && HEADER.has(words[0].text)) return ALLOW;
  }
  let top = !call;
  for (let n = 0; ; n++) {
    if (n > 6) return deny("nesting-too-deep", "too many nested wrappers", seg(words));
    if (c.dialect === "posix") while (words.length && /^[A-Za-z_]\w*=/.test(words[0].text)) words = words.slice(1);
    if (!words.length) return ALLOW;
    const w0 = words[0];
    if (top && c.dialect === "powershell" && w0.dynamic && !w0.quoted && w0.raw[0] === "$") {
      if (!/^([+\-*\/%]|\?\?)?=$/.test(words[1]?.text ?? "")) return ALLOW;
      words = words.slice(2);
      continue;
    }
    top = false;
    if (w0.dynamic && !/^\[\[?$/.test(w0.text)) return deny("dynamic-command", "command name is computed at run time", seg(words));
    const name = nname(w0.text);
    const args = words.slice(1);
    const a = args.map((x) => x.text);
    const texts = () => a.join(" ");
    const rest = (k: number) => {
      words = args.slice(k);
    };
    switch (name) {
      case "sudo": rest(skipOpts(args, ["-u", "-g", "-h", "-p", "-C", "-D", "--user", "--group", "--host", "--prompt", "--chdir"])); continue;
      case "doas": rest(skipOpts(args, ["-u"])); continue;
      case "env": {
        let k = skipOpts(args, ["-u", "-C"]);
        while (k < args.length && /^[A-Za-z_]\w*=/.test(args[k].text)) k++;
        rest(k);
        continue;
      }
      case "command": {
        const k = skipOpts(args, []);
        if (a.slice(0, k).some((x) => x === "-v" || x === "-V")) return ALLOW;
        rest(k);
        continue;
      }
      case "builtin": rest(0); continue;
      case "exec": rest(skipOpts(args, ["-a"])); continue;
      case "nohup": case "setsid": case "time": rest(skipOpts(args, [])); continue;
      case "nice": rest(skipOpts(args, ["-n"])); continue;
      case "ionice": rest(skipOpts(args, ["-c", "-n", "-p"])); continue;
      case "stdbuf": rest(skipOpts(args, ["-i", "-o", "-e"])); continue;
      case "timeout": rest(skipOpts(args, ["-s", "-k", "--signal", "--kill-after"]) + 1); continue;
      case "watch": {
        const r = args.slice(skipOpts(args, ["-n", "--interval"]));
        if (r.length === 1 && /\s/.test(r[0].text)) return sub(r[0].text, c.dialect);
        words = r;
        continue;
      }
      case "busybox": rest(0); continue;
      case "xargs": rest(skipOpts(args, ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"])); stdin = true; continue;
      case "npx": case "bunx": case "pnpx": rest(skipOpts(args, ["-p", "--package"])); continue;
      case "npm": case "pnpm": case "yarn": {
        const s = a[0];
        if (s === "exec" || (s === "dlx" && name !== "npm")) {
          words = args.slice(1).slice(skipOpts(args.slice(1), ["-p", "--package"]));
          continue;
        }
        break;
      }
      case "start": case "start-process": case "saps": {
        if (c.dialect !== "powershell") break;
        let file: Word | undefined;
        let list: string[] = [];
        let positional = 0;
        for (let i = 0; i < args.length; i++) {
          const t = args[i].text;
          const p = t[0] === "-" ? t.slice(1).split(":")[0].toLowerCase() : "";
          const split = (v?: Word) => (list = (v?.text ?? "").split(/[\s,]+/).filter(Boolean));
          if (p && "filepath".startsWith(p)) file = args[++i];
          else if (p && ("argumentlist".startsWith(p) && p.length >= 2 || p === "args")) split(args[++i]);
          else if (p && (["windowstyle", "verb", "workingdirectory", "credential", "redirectstandardinput", "redirectstandardoutput", "redirectstandarderror"].some((f) => f.startsWith(p) && p.length >= 2 && !"wait".startsWith(p)) || p === "v")) i++;
          else if (p) continue;
          else if (positional++ === 0) file = args[i];
          else if (positional === 2) split(args[i]);
        }
        if (!file) return ALLOW;
        words = [file, ...list.map(mk)];
        continue;
      }
    }
    if (SHELLS.has(name)) {
      const i = args.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x.text));
      if (i >= 0 && args[i + 1]) {
        if (args[i + 1].dynamic) return deny("dynamic-command", "shell command string is computed at run time", seg(words));
        return sub(args[i + 1].text, "posix");
      }
    }
    if (name === "eval") {
      if (!args.length) return ALLOW;
      if (args.some((x) => x.dynamic)) return deny("dynamic-command", "eval of a computed string", seg(words));
      return sub(texts(), "posix");
    }
    if (name === "pwsh" || name === "powershell") {
      const ci = args.findIndex((x) => isParam(x.text, "command") || x.text.toLowerCase() === "-c");
      const ei = args.findIndex((x) => isParam(x.text, "encodedcommand") || x.text.toLowerCase() === "-ec");
      if (ei >= 0) {
        const b = args[ei + 1]?.text ?? "";
        if (!/^[A-Za-z0-9+/]+=*$/.test(b)) return deny("encoded-command", "cannot decode -EncodedCommand", seg(words));
        return sub(Buffer.from(b, "base64").toString("utf16le"), "powershell");
      }
      if (ci >= 0 && args.length > ci + 1) {
        const body = args.slice(ci + 1).map((x) => x.text).join(" ");
        if (body === "-" && pipe > 0) return deny("pipe-to-shell", "script piped into a shell", seg(words));
        return sub(body, "powershell");
      }
    }
    if (name === "cmd") {
      const i = args.findIndex((x) => /^\/[ck]$/i.test(x.text));
      if (i >= 0) return sub(args.slice(i + 1).map((x) => (x.quoted ? x.text : x.raw)).join(" "), "powershell");
    }
    if (name === "iex" || name === "invoke-expression") {
      if (pipe > 0 || !args.length || args.some((x) => x.dynamic)) return deny("dynamic-command", "Invoke-Expression of computed or piped text", seg(words));
      return sub(texts(), "powershell");
    }
    if (pipe > 0 && (PIPESH.has(name) || /^python[\d.]+$/.test(name)) && !a.some((x) => x[0] !== "-") && !a.some(inlineFlag)
      && !c.lift?.({ rule: "pipe-to-shell", reason: "script piped into an interpreter", name, args: a }))
      return deny("pipe-to-shell", "script piped into an interpreter", seg(words));

    if (CD.has(name)) {
      const i = args.findIndex((x) => /^-(path|literalpath)$/i.test(x.text));
      const t = i >= 0 ? args[i + 1] : args.find((x) => x.text[0] !== "-" || x.text === "-");
      c.cwd = t ? (t.text === "-" ? null : resolvePath(t, c)) : c.home;
      return ALLOW;
    }
    const k: K = { name, args, a, c, pipe, stdin, seg: seg(words), sql };
    for (const r of RULES) {
      const v = r(k);
      if (v) return v;
    }
    return ALLOW;
  }
}

function run(command: string, c: Ctx): Verdict {
  if (c.depth > 6) return deny("nesting-too-deep", "commands are nested too deeply", command.trim());
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return deny("system", "fork bomb", command.trim());
  if (/\[(System\.)?IO\.(Directory|File)\]::(Delete|Move|WriteAll)/i.test(command)) return deny("system", "direct .NET file deletion or write", command.trim());
  const lx = lex(command, c.dialect === "powershell");
  for (const s of lx.subs) {
    const v = run(s, { ...c, depth: c.depth + 1 });
    if (!v.allow) return v;
  }
  const list = parse(lx.toks, c.dialect === "powershell");
  const sqlOf = (pid: number) => {
    const g = list.filter((s) => s.pid === pid);
    const has = g.some((s) => {
      const f = s.words.find((x) => !/^[A-Za-z_]\w*=/.test(x.text));
      return f && SQL_CLIENTS.has(nname(f.text));
    });
    return has ? [...g.flatMap((s) => s.words.map((x) => x.text)), ...lx.bodies].join(" ") : undefined;
  };
  for (const s of list) {
    for (const r of s.redirs) {
      const bad = wcheck(r, c);
      if (bad) return deny("write-outside", `redirect: ${bad}`, seg(s.words) + " > " + r.raw);
    }
    const v = cmd(s.words, s.pipe, c, false, sqlOf(s.pid), s.call);
    if (!v.allow) return v;
  }
  return ALLOW;
}

export function checkCommand(command: string, opts: FirewallOptions): Verdict {
  try {
    const win = /^[A-Za-z]:/.test(opts.workspace);
    const lower = (p: string) => (win ? p.toLowerCase() : p);
    const fix = (p: string) => canonical(lower(norm(win ? p.replace(/\\/g, "/") : p)), win, true);
    const ws = fix(opts.workspace);
    const tmp = [fix(os.tmpdir()), "/tmp"];
    if (!win) tmp.push(canonical("/tmp", false, true));
    return run(command, {
      dialect: opts.dialect ?? "posix",
      depth: 0,
      cwd: opts.cwd ? fix(opts.cwd) : ws,
      ws,
      win,
      home: fix(opts.home ?? os.homedir()),
      hosts: (opts.allowHosts ?? []).map((h) => h.toLowerCase()),
      tmp,
      lift: opts.lift,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ParseError) return deny("parse-error", msg, command.trim());
    return deny("internal-error", msg, command.trim());
  }
}

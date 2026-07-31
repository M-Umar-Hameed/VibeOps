import React from "react";

// Renders untrusted model output as React elements only — no HTML parsing,
// no dangerouslySetInnerHTML. Raw HTML in input stays literal text.
function inlineNodes(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push(
        <code key={key++} className="font-mono text-code-sm bg-surface-container-highest px-1 rounded">
          {part.slice(1, -1)}
        </code>
      );
      continue;
    }
    part.split("**").forEach((seg, i) => {
      if (!seg) return;
      if (i % 2 === 1) out.push(<strong key={key++}>{seg}</strong>);
      else out.push(<React.Fragment key={key++}>{seg}</React.Fragment>);
    });
  }
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={key++}>{inlineNodes(para.join(" "))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    const l = list;
    if (!l) return;
    const items = l.items.map((it, i) => <li key={i}>{inlineNodes(it)}</li>);
    blocks.push(
      l.ordered
        ? <ol key={key++} className="list-decimal pl-5 space-y-1">{items}</ol>
        : <ul key={key++} className="list-disc pl-5 space-y-1">{items}</ul>
    );
    list = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      blocks.push(<div key={key++} className="font-bold mt-3 first:mt-0">{inlineNodes(heading[1])}</div>);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (list && list.ordered) flushList();
      if (!list) list = { ordered: false, items: [] };
      list.items.push(bullet[1]);
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      if (list && !list.ordered) flushList();
      if (!list) list = { ordered: true, items: [] };
      list.items.push(numbered[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return <div className={className ?? "space-y-2 leading-relaxed text-left"}>{blocks}</div>;
}

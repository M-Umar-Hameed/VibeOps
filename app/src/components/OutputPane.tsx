import { Virtuoso } from "react-virtuoso";

export function OutputPane({ chunks, className }: { chunks: string[]; className?: string }) {
  return (
    <Virtuoso
      data={chunks}
      followOutput="smooth"
      computeItemKey={(index: number) => index}
      className={
        "h-64 bg-background/80 border border-white/10 rounded-lg custom-scrollbar " +
        (className ?? "")
      }
      itemContent={(_index: number, chunk: string) => (
        <div className="px-4 text-code-sm text-on-surface font-mono whitespace-pre-wrap">
          {chunk}
        </div>
      )}
    />
  );
}

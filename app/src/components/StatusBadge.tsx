export function StatusBadge({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-primary-fixed-dim neon-pulse"></span>
      <span className="text-xs uppercase font-code-sm">{status}</span>
    </div>
  );
}

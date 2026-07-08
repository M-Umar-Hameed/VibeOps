export function Banner({ kind, message }: { kind: "error" | "warn" | "info"; message: string }) {
  const bg = kind === "error" ? "#fdd" : kind === "warn" ? "#ffd" : "#def";
  return <div role="alert" style={{ background: bg, padding: "8px 12px", borderRadius: 6 }}>{message}</div>;
}

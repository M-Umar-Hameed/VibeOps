// What the embedding index sees. A decision's rationale must be searchable
// ("why did we pick X"), a rule's is not a thing. Used by saveNote and the
// re-index sweep so both paths embed the same text.
export function noteIndexText(n: { body: string; kind: string; rationale: string | null }): string {
  return n.kind === "decision" && n.rationale ? `${n.body}\nRationale: ${n.rationale}` : n.body;
}

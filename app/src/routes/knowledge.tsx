import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { knowledge } from "../api/knowledge.js";
import { notes } from "../api/notes.js";
import { Banner } from "../components/Banner.js";

export function KnowledgeScreen() {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const sq = useQuery({ queryKey: ["knowledge", submitted], queryFn: () => knowledge.search(submitted), enabled: !!submitted });

  const [body, setBody] = useState("");
  const [scope, setScope] = useState("global");
  const [refId, setRefId] = useState("");
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => notes.save({ body, scope, refId: scope === "global" ? undefined : refId }),
    onSuccess: () => { setSaved(true); setBody(""); },
  });

  return (
    <div>
      <h2>Knowledge</h2>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search" />
      <button onClick={() => setSubmitted(q)}>Search</button>
      <ul>
        {sq.data?.map((h, i) => <li key={i}>{h.content} <i>({h.citation})</i></li>)}
      </ul>
      <h3>Save note</h3>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="note body" />
      <select value={scope} onChange={(e) => setScope(e.target.value)}>
        <option>global</option><option>project</option><option>ticket</option>
      </select>
      {scope !== "global" && <input value={refId} onChange={(e) => setRefId(e.target.value)} placeholder={`${scope} id`} />}
      <button disabled={!body} onClick={() => save.mutate()}>Save note</button>
      {saved && <Banner kind="info" message="Saved" />}
    </div>
  );
}

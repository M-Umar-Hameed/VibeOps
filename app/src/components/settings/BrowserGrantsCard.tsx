import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

type Grant = { origin: string; mode: "read" | "act" };

export function BrowserGrantsCard() {
  const qc = useQueryClient();
  const [origin, setOrigin] = useState("");

  const { data } = useQuery({
    queryKey: ["settings", "browserGrants"],
    queryFn: async () => await api.get("/settings/browserGrants"),
  });

  let grants: Grant[] = [];
  try { const g = JSON.parse(data?.value ?? "[]"); if (Array.isArray(g)) grants = g; } catch { grants = []; }

  const save = useMutation({
    mutationFn: async (next: Grant[]) => { await api.patch("/settings/browserGrants", { value: JSON.stringify(next) }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "browserGrants"] }),
  });

  const add = () => {
    const o = origin.trim().toLowerCase();
    if (!o) return;
    save.mutate([...grants.filter((g) => g.origin.toLowerCase() !== o), { origin: o, mode: "act" }]);
    setOrigin("");
  };
  const remove = (o: string) => save.mutate(grants.filter((g) => g.origin !== o));

  return (
    <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/5">
      <h4 className="text-sm font-bold text-on-surface mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-sm text-primary">lock_open</span>
        Browser act grants
      </h4>
      <p className="text-xs text-on-surface-variant leading-relaxed mb-4">
        Origins the browser agent may click/type/select/press on. Reads work without a grant.
      </p>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none"
          placeholder="https://github.com"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        />
        <button
          onClick={add}
          disabled={save.isPending}
          className="px-4 py-2 rounded bg-primary text-on-primary text-sm font-medium disabled:opacity-50"
        >
          Grant act
        </button>
      </div>
      {grants.length === 0 ? (
        <p className="text-xs text-on-surface-variant/60 italic">No act grants yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {grants.map((g) => (
            <li key={g.origin} className="flex items-center justify-between text-sm text-on-surface bg-surface-container-highest/40 rounded px-3 py-2">
              <span className="font-code-sm truncate">{g.origin} · {g.mode}</span>
              <button onClick={() => remove(g.origin)} className="text-error text-xs hover:underline">Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

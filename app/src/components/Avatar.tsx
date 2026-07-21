import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { actors } from "../api/actors.js";
import { git } from "../api/git.js";

export function Avatar({ actorId, size = "md" }: { actorId?: string | null, size?: "sm" | "md" | "lg" }) {
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const gq = useQuery({ queryKey: ["git-identity"], queryFn: git.identity, staleTime: Infinity });
  const [imgError, setImgError] = useState(false);
  const actor = aq.data?.find((a) => a.id === actorId);
  const name = actor?.name || actorId || "Unknown";
  const seed = name.replace(/\s+/g, "");
  const dicebear = `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${seed}&backgroundColor=transparent`;

  const identityName = gq.data?.name ?? null;
  const src = actor?.kind === "human" && identityName && !imgError
    ? `https://github.com/${encodeURIComponent(identityName)}.png`
    : dicebear;

  const sizeClasses = {
    sm: "w-6 h-6",
    md: "w-8 h-8",
    lg: "w-10 h-10"
  };

  return (
    <div className={`${sizeClasses[size]} rounded-full border border-primary-fixed-dim/30 overflow-hidden shrink-0 bg-surface-container-highest flex items-center justify-center`} title={name}>
      {actorId ? (
        <img
          src={src}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span className="material-symbols-outlined text-[10px] text-on-surface-variant">person_off</span>
      )}
    </div>
  );
}

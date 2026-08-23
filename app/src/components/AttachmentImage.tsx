import { useEffect, useState } from "react";
import { apiFetchBlob } from "../api/client.js";

// Renders a chat-attachment image by fetching its bytes through the
// authenticated API client (a plain <img src> can't carry the Bearer header).
export function AttachmentImage({ file, alt }: { file: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(false);
    apiFetchBlob(`/forge/attachments/${file}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (error) return <span className="text-on-surface-variant text-xs italic">[image unavailable]</span>;
  if (!url) return <span className="text-on-surface-variant text-xs italic">Loading image…</span>;

  return (
    <img
      src={url}
      alt={alt}
      className="max-h-[240px] rounded border border-white/10 cursor-pointer"
      onClick={() => window.open(url, "_blank")}
    />
  );
}

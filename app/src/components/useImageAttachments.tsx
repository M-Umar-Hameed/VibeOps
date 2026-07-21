import { useState, useRef } from "react";
import { api } from "../lib/api.js";

export type PendingAttachment = { id: string; name: string; path: string; markdown: string; previewUrl: string };

export function useImageAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: File[]) => {
    setAttachError("");
    for (const file of files) {
      if (!file.type.startsWith("image/")) { setAttachError("Only image files can be attached."); continue; }
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(new Error("read failed"));
          r.readAsDataURL(file);
        });
        const res = await api.post("/forge/attachments", { dataBase64, name: file.name }) as { path: string; markdown: string };
        setAttachments(a => [...a, { id: res.path, name: file.name, path: res.path, markdown: res.markdown, previewUrl: URL.createObjectURL(file) }]);
      } catch (e: any) {
        setAttachError(e.message || "Attachment upload failed");
      }
    }
  };

  const removeAttachment = (id: string) => setAttachments(list => list.filter(x => x.id !== id));
  const clear = () => setAttachments([]);
  const markdown = () => attachments.map(a => a.markdown).join("\n");

  return { attachments, attachError, fileInputRef, uploadFiles, removeAttachment, clear, markdown };
}

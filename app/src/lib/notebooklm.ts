export async function fetchBrief(kind: string, id: string): Promise<{ text: string; filename: string }> {
  const { getSettings } = await import("../settings.js");
  const { baseUrl, apiKey } = await getSettings();
  const res = await fetch(`${baseUrl}/export/brief?kind=${kind}&id=${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error("Export failed");
  const text = await res.text();
  const disp = res.headers.get("Content-Disposition");
  let filename = `${kind}-${id.substring(0, 8)}.md`;
  if (disp && disp.includes("filename=")) {
    filename = disp.split("filename=")[1].replace(/"/g, "");
  }
  return { text, filename };
}

function downloadBrief(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportBrief(kind: string, id: string): Promise<void> {
  const { text, filename } = await fetchBrief(kind, id);
  downloadBrief(text, filename);
}

export async function sendBriefToNotebookLM(kind: string, id: string): Promise<string> {
  const { text, filename } = await fetchBrief(kind, id);
  let notice: string;
  try {
    await navigator.clipboard.writeText(text);
    notice = "Brief copied. In NotebookLM: + Add source -> Paste text.";
  } catch {
    downloadBrief(text, filename);
    notice = "Clipboard unavailable - brief downloaded instead; add the file as a NotebookLM source.";
  }
  window.open("https://notebooklm.google.com/", "_blank", "noopener,noreferrer");
  return notice;
}

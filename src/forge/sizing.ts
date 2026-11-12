export type SizingDecision = {
  isTooBig: boolean;
  reason: string;
};

export function isSlmWorker(agentName: string, modelName?: string): boolean {
  const normAgent = (agentName || "").toLowerCase();
  const normModel = (modelName || "").toLowerCase();
  if (normAgent === "deepseek" || normAgent === "qwen") return true;
  if (/(\b|[-_])(1b|3b|7b|8b|9b|14b|xs|small|slm)(\b|[-_])/i.test(normModel)) return true;
  if (normModel.includes("deepseek-9b") || normModel.includes("qwen3.6-35b-a3b")) return true;
  return false;
}

export function heuristicSizing(
  ticket: { title: string; body?: string | null },
  plan?: string | null,
): SizingDecision {
  const text = `${ticket.title}\n${ticket.body ?? ""}\n${plan ?? ""}`;
  const files = new Set<string>();
  const matches = text.match(/\b[\w./\\-]+\.(ts|js|tsx|jsx|json|py|rs|go|css|html)\b/g) || [];
  for (const m of matches) {
    const norm = m.replace(/\\/g, "/").toLowerCase();
    if (!norm.includes("package.json") && !norm.includes("tsconfig") && !norm.includes("vitest.config")) {
      files.add(norm);
    }
  }

  const numberedTasks = (ticket.body ?? "").match(/^\s*\d+[\.\)]\s+/gm) || [];

  if (files.size > 2) {
    return {
      isTooBig: true,
      reason: `Ticket touches ${files.size} distinct files (${Array.from(files).slice(0, 3).join(", ")}${files.size > 3 ? "..." : ""})`,
    };
  }

  if (numberedTasks.length >= 3) {
    return {
      isTooBig: true,
      reason: `Ticket specifies ${numberedTasks.length} separate tasks in the description`,
    };
  }

  return {
    isTooBig: false,
    reason: "Ticket is bounded to 1-2 files with a single focused concern",
  };
}

export async function evaluateTaskSizing(
  ticket: { title: string; body?: string | null },
  plan?: string | null,
  workAgent?: string,
  workModel?: string,
): Promise<SizingDecision> {
  if (workAgent && !isSlmWorker(workAgent, workModel)) {
    return { isTooBig: false, reason: "Frontier model worker can handle multi-concern tasks" };
  }

  const endpoint = process.env.VIBEOPS_SIZING_ENDPOINT || "http://127.0.0.1:8086/v1/chat/completions";
  const prompt = [
    `Ticket Title: ${ticket.title}`,
    ticket.body ? `Ticket Body:\n${ticket.body.slice(0, 1500)}` : "",
    plan ? `Plan:\n${plan.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "lfm3",
        messages: [
          {
            role: "system",
            content: "You assess whether a coding ticket is too large or multi-concern for a small 9B language model worker. A ticket is too big (isTooBig: true) if it touches more than 2 distinct files, specifies multiple independent features, or requires multi-phase edits. Return strictly JSON: {\"isTooBig\": boolean, \"reason\": \"short explanation\"}.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 120,
        temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content?.trim() || "";
      const jsonMatch = raw.match(/\{[\s\S]*"isTooBig"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { isTooBig?: boolean; reason?: string };
        if (typeof parsed.isTooBig === "boolean") {
          return {
            isTooBig: parsed.isTooBig,
            reason: parsed.reason || (parsed.isTooBig ? "LFM sized task as too big for SLM worker" : "LFM sized task as atomic"),
          };
        }
      }
    }
  } catch {
    // Fall back to heuristic sizing on endpoint failure or timeout
  }

  return heuristicSizing(ticket, plan);
}

export function atomicDirective(decision: SizingDecision): string {
  if (!decision.isTooBig) return "";
  return [
    "",
    "=== ATOMIC SLM WORKER DIRECTIVE ===",
    `The pre-flight classifier determined this task is too broad for a single SLM session: ${decision.reason}.`,
    "The implementation plan MUST decompose this work into atomic, isolated steps:",
    "1. Each step must touch at most ONE source file and its corresponding test file.",
    "2. Each step must specify the exact function name and exact diff (old code -> new code).",
    "3. Each step must name the exact test command to verify before moving to the next file.",
    "4. Do NOT leave ambiguous multi-file changes or open-ended refactoring to the worker.",
    "===================================",
    "",
  ].join("\n");
}

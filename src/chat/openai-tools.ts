// Converts the SDK chat tools (zod v4 raw-shape input) into OpenAI-compatible
// function schemas for the http (OpenRouter) lane's tool-calling loop.
// ponytail: hand-rolled for the subset buildChatTools uses (string/number/array/any/optional);
// z.toJSONSchema adds safe-int min/max bounds the OpenAI schema does not need.
import { z } from "zod";
import type { buildChatTools } from "./tools.js";
import type { ToolDef } from "./http-lane.js";

type SdkTool = ReturnType<typeof buildChatTools>[number];

function zodToJsonSchema(schema: any): unknown {
  const def = schema?._zod?.def;
  switch (def?.type) {
    case "optional":
      return zodToJsonSchema(def.innerType);
    case "string":
      return { type: "string" };
    case "number": {
      const out: Record<string, unknown> = { type: schema.isInt ? "integer" : "number" };
      const min = schema.minValue;
      // .int() alone sets minValue to MIN_SAFE_INTEGER; only emit real bounds.
      if (typeof min === "number" && min > Number.MIN_SAFE_INTEGER) out.minimum = min;
      return out;
    }
    case "array":
      return { type: "array", items: zodToJsonSchema(def.element) };
    default:
      // Unknown kind (incl. ZodAny) -> accept anything rather than throw.
      return {};
  }
}

export type OpenAiFunctionSchema = { type: "object"; properties: Record<string, unknown>; required: string[] };

export function toOpenAiTools(
  tools: SdkTool[],
): { name: string; description: string; parameters: OpenAiFunctionSchema }[] {
  return tools.map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, schema] of Object.entries(t.inputSchema)) {
      properties[key] = zodToJsonSchema(schema);
      if ((schema as any)?._zod?.def?.type !== "optional") required.push(key);
    }
    return { name: t.name, description: t.description, parameters: { type: "object", properties, required } };
  });
}

// Adapts SDK tools to the provider-neutral ToolDef the http lane's tool loop
// runs. Every handler call still goes through the tool's own `rec(...)`, so
// calls made over this path land in the same ToolCall trace as the SDK lane.
export function toHttpTools(tools: SdkTool[]): ToolDef[] {
  return toOpenAiTools(tools).map((schema, i) => {
    const t = tools[i];
    // Model-supplied args are untrusted input: validate against the tool's own
    // zod shape before they reach a handler (a wrong-typed field, e.g. a number
    // where a handler expects a string, throws deep inside it otherwise).
    const shape = z.object(t.inputSchema as z.ZodRawShape);
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      run: async (args: unknown) => {
        const parsed = shape.safeParse(args);
        if (!parsed.success) return `invalid arguments: ${parsed.error.message}`;
        const result = await t.handler(parsed.data as any, {});
        return result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      },
    };
  });
}

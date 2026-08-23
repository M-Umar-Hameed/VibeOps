// Converts the SDK chat tools (zod v3 raw-shape input) into OpenAI-compatible
// function schemas for the http (OpenRouter) lane's tool-calling loop.
// ponytail: hand-rolled for the small subset of zod kinds buildChatTools
// actually uses (string/number/array/any/optional) - zod-to-json-schema is
// not installed and zod/v4's toJSONSchema only accepts v4 schemas.
import { z } from "zod";
import type { buildChatTools } from "./tools.js";
import type { ToolDef } from "./http-lane.js";

type SdkTool = ReturnType<typeof buildChatTools>[number];

function zodToJsonSchema(schema: any): unknown {
  const def = schema?._def;
  switch (def?.typeName) {
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const checks: { kind: string; value?: number }[] = def.checks ?? [];
      const out: Record<string, unknown> = { type: checks.some((c) => c.kind === "int") ? "integer" : "number" };
      const min = checks.find((c) => c.kind === "min");
      if (min) out.minimum = min.value;
      return out;
    }
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type) };
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
      if ((schema as any)?._def?.typeName !== "ZodOptional") required.push(key);
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

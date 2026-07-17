export type CommProfile = "off" | "caveman" | "humanizer";

const CAVEMAN_CLAUSE = `
Output must be extremely terse. Drop all filler words and pleasantries. Focus entirely on the technical problem. Do not write introductory or concluding remarks. Full sentences are not required.

However, the technical substance stays complete and exact. Code snippets, variable identifiers, and error messages must never be compressed or paraphrased. You must ensure all logic and commands are provided fully without skipping details.
`;

const HUMANIZER_CLAUSE = `
Write in plain natural prose. There should be no inflated language, no rule-of-three constructions, and no promotional adjectives. Use direct attribution instead of vague phrases like "some say". You should vary sentence length for a natural rhythm and rhythm. Do not use em-dash overuse. Keep explanations direct, grounded, and clear.
`;

export function styleClause(profile: string | null | undefined): string {
  if (profile === "caveman") {
    return CAVEMAN_CLAUSE;
  }
  if (profile === "humanizer") {
    return HUMANIZER_CLAUSE;
  }
  return "";
}

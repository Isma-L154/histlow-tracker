/**
 * Turning guide passages into steps for one achievement.
 *
 * The model is a rewriter, never a source. Everything it is allowed to say has
 * to come from the passages it is handed, for two reasons: it has no reliable
 * memory of any particular game's achievements, and a completionist who follows
 * an invented step loses hours before finding out. When the passages do not
 * answer the question, saying so is the correct output.
 *
 * Translation is the other half of the job. The best-rated guides for a given
 * game are frequently in Russian or English, and reading them is exactly the
 * work this page exists to remove.
 */

import { logFailure } from "./http.ts";
import type { Passage } from "./guides.ts";

export interface HowTo {
  steps: string;
  /** False when the model reported the passages do not cover the achievement. */
  answered: boolean;
}

/** Sentinel the model is told to emit when the passages fall short. */
const NO_ANSWER = "NO_INFORMATION";

const SYSTEM = [
  "You explain how Steam achievements are earned.",
  "",
  "Strict rules:",
  "- Use ONLY the information in the guide passages you are given.",
  "- Do not use your own knowledge of the game. If it is not in the passages, it does not exist.",
  "- Never invent names of items, areas, bosses, levels or requirements.",
  `- If the passages do not explain how the achievement is earned, reply exactly ${NO_ANSWER} and nothing else.`,
  "- The passages may be in English, Spanish or Russian: always answer in English.",
  "",
  "Answer format:",
  "- One opening sentence summarising what has to be done.",
  "- Then the concrete steps as a dash list, in order.",
  "- At most 200 words. No preamble and no sign-off.",
].join("\n");

export async function explainAchievement(
  ai: Ai,
  model: string,
  achievement: { name: string; description: string },
  passages: Passage[],
): Promise<HowTo | null> {
  if (passages.length === 0) return null;

  const context = passages
    .map((passage, index) =>
      [
        `--- Passage ${index + 1} (guide: "${passage.guideTitle}", section: "${passage.section}") ---`,
        passage.text,
      ].join("\n"),
    )
    .join("\n\n");

  const prompt = [
    `Logro: "${achievement.name}"`,
    achievement.description ? `Official Steam description: "${achievement.description}"` : "",
    "",
    "Community guide passages:",
    context,
    "",
    `How is the achievement "${achievement.name}" earned?`,
  ]
    .filter(Boolean)
    .join("\n");

  let output: unknown;
  try {
    output = await ai.run(model as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      // Enough for a short list; the cap is also what keeps a single answer
      // from eating a meaningful slice of the daily free allocation.
      max_tokens: 400,
      // Low but not zero: the job is rewriting, not composing.
      temperature: 0.2,
    } as Parameters<Ai["run"]>[1]);
  } catch (error) {
    // Most often the daily free allocation is spent. The caller still has the
    // passages, so the page degrades to showing the source text.
    logFailure("workers ai call failed", error);
    return null;
  }

  const text = readResponse(output);
  if (!text) return null;

  const answered = !text.toUpperCase().includes(NO_ANSWER);
  return {
    steps: answered
      ? text
      : "The guides found mention this achievement, but do not explain how it is earned.",
    answered,
  };
}

function readResponse(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output && typeof output === "object" && "response" in output) {
    const value = (output as { response: unknown }).response;
    if (typeof value === "string") return value.trim();
  }
  return "";
}

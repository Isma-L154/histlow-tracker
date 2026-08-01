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

import type { Passage } from "./guides.ts";

export interface HowTo {
  steps: string;
  /** False when the model reported the passages do not cover the achievement. */
  answered: boolean;
}

/** Sentinel the model is told to emit when the passages fall short. */
const NO_ANSWER = "SIN_INFORMACION";

const SYSTEM = [
  "Eres un asistente que explica cómo conseguir logros de videojuegos en Steam.",
  "",
  "Reglas estrictas:",
  "- Usa ÚNICAMENTE la información de los fragmentos de guía que se te entregan.",
  "- No uses conocimiento propio del juego. Si no está en los fragmentos, no existe.",
  "- No inventes nombres de objetos, zonas, jefes, niveles ni requisitos.",
  `- Si los fragmentos no explican cómo conseguir el logro, responde exactamente ${NO_ANSWER} y nada más.`,
  "- Los fragmentos pueden estar en inglés o en ruso: responde siempre en español.",
  "",
  "Formato de respuesta:",
  "- Una frase inicial que resuma qué hay que hacer.",
  "- Después, los pasos concretos en una lista con guiones, en orden.",
  "- Máximo 200 palabras. Sin introducción ni despedida.",
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
        `--- Fragmento ${index + 1} (guía: "${passage.guideTitle}", sección: "${passage.section}") ---`,
        passage.text,
      ].join("\n"),
    )
    .join("\n\n");

  const prompt = [
    `Logro: "${achievement.name}"`,
    achievement.description ? `Descripción oficial de Steam: "${achievement.description}"` : "",
    "",
    "Fragmentos de guías de la comunidad:",
    context,
    "",
    `¿Cómo se consigue el logro "${achievement.name}"?`,
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
    console.error("workers ai call failed", error);
    return null;
  }

  const text = readResponse(output);
  if (!text) return null;

  const answered = !text.toUpperCase().includes(NO_ANSWER);
  return {
    steps: answered
      ? text
      : "Las guías encontradas mencionan este logro, pero no explican cómo conseguirlo.",
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

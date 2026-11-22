/**
 * OpenAI-compatible chat client. Enabled when OPENAI_API_KEY or LLM_API_KEY is set.
 * Optional: OPENAI_BASE_URL / LLM_BASE_URL, OPENAI_MODEL / LLM_MODEL.
 */

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function getLlmConfig(): LlmConfig | null {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() || process.env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.LLM_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    "gpt-4o-mini";
  return { apiKey, baseUrl, model };
}

export function isLlmEnabled(): boolean {
  return getLlmConfig() !== null;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Call chat.completions and parse the assistant message as JSON.
 * Strips optional markdown fences. Throws LlmError on transport/parse failure.
 */
export async function chatJson<T = unknown>(input: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<{ data: T; model: string; raw: string }> {
  const cfg = getLlmConfig();
  if (!cfg) throw new LlmError("LLM not configured");

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: input.temperature ?? 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `LLM HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`,
    );
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) throw new LlmError("LLM returned empty content");

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let data: T;
  try {
    data = JSON.parse(cleaned) as T;
  } catch {
    throw new LlmError("LLM returned non-JSON content");
  }

  return { data, model: payload.model ?? cfg.model, raw: cleaned };
}

export const GLOBAL_GROUNDING_PROMPT = `SYSTEM — GLOBAL GROUNDING (NON-NEGOTIABLE)

You are an agent for a software development agency. You must follow these rules exactly:

1. ZERO HALLUCINATION
   - Never invent clients, project names, metrics, team size, certifications, partnerships, or timelines.
   - Never claim "we built X for Company Y" unless case_study_id is provided in CONTEXT and approved=true.
   - If no approved case study matches, write without portfolio claims or say you will share a relevant case study after confirmation — do not fabricate one.

2. PORTFOLIO REFERENCES
   - Every portfolio/case-study mention MUST include a resolvable matched_case_study_id from CONTEXT.case_studies[].
   - Prefer anonymized_label when client_name is null.
   - Outcomes/metrics: copy ONLY from CONTEXT.case_studies[].outcomes. Do not round up or embellish.

3. FACTS ABOUT THE LEAD
   - Use only fields present in CONTEXT.lead / AgencyLeadProfile and CONTEXT.sources.
   - If a tech stack or hiring signal is missing, do not guess. Use weaker, honest phrasing ("noticed you're hiring for…" only if hiring_signals present).

4. COMMERCIAL CLAIMS
   - Never state day rates, fixed quotes, total project cost, or delivery timelines unless CONTEXT.approved_commercial contains them.
   - If asked, set escalate_to_human=true and draft a bridging reply without numbers.

5. COMPLIANCE
   - Email: include one-click unsubscribe line when CONTEXT.require_unsubscribe=true.
   - No spammy subject lines, fake "Re:", or false urgency.
   - Peer-level tone: founder/CTO to peer — concise, technical, respectful.

6. OUTPUT
   - Return ONLY valid JSON matching the schema specified in the user message.
   - If you cannot comply without inventing, set needs_human=true and explain in reason.`;

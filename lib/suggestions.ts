// Pure logic for the next-steps plugin: prompt construction and parsing of the
// analysis thread's reply. No bb API here, so this module is unit-testable
// without a running server.

export interface NextStepSuggestion {
  /** What the developer would actually type to the agent. */
  text: string;
  /** Very short reason it matters now. */
  detail: string;
}

export interface SuggestionCache {
  suggestions: NextStepSuggestion[];
  generatedAtMs: number;
  /** The hidden analysis thread that produced this set. */
  sourceThreadId: string | null;
}

export const MIN_SUGGESTION_COUNT = 1;
export const MAX_SUGGESTION_COUNT = 5;
/**
 * The analysis is asked for more suggestions than are shown. The surplus is
 * what lets `rankByNovelty` drop repeats without leaving the list short when
 * the repository genuinely has the same top priorities as last time.
 */
export const CANDIDATE_SURPLUS = 3;
export const MAX_CANDIDATE_COUNT = MAX_SUGGESTION_COUNT + CANDIDATE_SURPLUS;
const MAX_SUGGESTION_TEXT_LENGTH = 160;
const MAX_SUGGESTION_DETAIL_LENGTH = 80;

/**
 * The prompt handed to the hidden analysis thread. It runs inside the
 * project's own environment, so it can read the real repository state.
 */
export function buildAnalysisPrompt(
  suggestionCount: number,
  alreadySuggested: readonly string[] = [],
): string {
  const count = clampCandidateCount(suggestionCount);
  const avoidSection =
    alreadySuggested.length === 0
      ? []
      : [
          "",
          "These were already offered to the developer recently. Do not repeat them.",
          "Propose different work, unless one of them is still so clearly the single",
          "most important thing that skipping it would be wrong — in which case say",
          "it differently and more specifically:",
          ...alreadySuggested.map((text) => `- ${text}`),
        ];
  return [
    "You are proposing the most beneficial next steps for this repository.",
    "The result becomes autocomplete suggestions above a developer's chat box,",
    "so each one must be something they could send to a coding agent verbatim.",
    "",
    "This task is READ-ONLY. Do not create, edit, or delete files. Do not run",
    "commands that change state (no commit, push, checkout, install, migrate).",
    "",
    "Keep it cheap. This is a background hint, not an audit: spend at most a",
    "handful of fast commands, skim rather than read files end to end, never",
    "run the test suite or a build, and do not launch subagents or workflows.",
    "Stop investigating as soon as you have enough to name concrete work.",
    "",
    "Look at whatever is cheap and actually present:",
    "- recent git log, and uncommitted changes in git status / git diff --stat",
    "- README, CLAUDE.md, AGENTS.md, or other in-repo instructions",
    "- TODO / FIXME markers and obviously half-finished work",
    "- tests or build/type-check config that are clearly missing or broken",
    "",
    `Then reply with ONLY a json code block containing exactly ${count} suggestions,`,
    "ordered most beneficial first. No prose before or after it.",
    "",
    "```json",
    '{"suggestions":[{"text":"...","detail":"..."}]}',
    "```",
    "",
    "Rules for each entry:",
    '- "text" is an imperative instruction of 4-14 words that names real files,',
    "  symbols, or commands from this repository.",
    '- "detail" is at most 8 words saying why it matters right now.',
    '- No generic filler ("add tests", "improve docs", "refactor code") unless it',
    "  names the specific file or function it applies to.",
    "- If the repository is clean and nothing is pending, suggest genuinely useful",
    "  work anyway, grounded in what the code actually contains.",
    ...avoidSection,
  ].join("\n");
}

/**
 * Comparison key for "have we shown this already". Deliberately loose —
 * wording drifts between runs, so casing, spacing, and trailing punctuation
 * must not make a repeat look new.
 */
export function suggestionKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/[\s\p{P}]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop suggestions the developer has already used in this project. */
export function excludeUsed(
  suggestions: readonly NextStepSuggestion[],
  usedKeys: readonly string[],
): NextStepSuggestion[] {
  const used = new Set(usedKeys);
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = suggestionKey(suggestion.text);
    if (used.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Append to a capped, most-recent-last history list without duplicates. */
export function appendHistory(
  history: readonly string[],
  additions: readonly string[],
  limit: number,
): string[] {
  const next = [...history];
  for (const addition of additions) {
    const existing = next.indexOf(addition);
    if (existing !== -1) next.splice(existing, 1);
    next.push(addition);
  }
  return next.slice(Math.max(0, next.length - limit));
}

export function clampSuggestionCount(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(
    MAX_SUGGESTION_COUNT,
    Math.max(MIN_SUGGESTION_COUNT, Math.trunc(value)),
  );
}

/** Clamp to the range the analysis may be asked to produce. */
export function clampCandidateCount(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(
    MAX_CANDIDATE_COUNT,
    Math.max(MIN_SUGGESTION_COUNT, Math.trunc(value)),
  );
}

/** How many suggestions to ask for, given how many will be shown. */
export function candidateCountFor(displayCount: number): number {
  return Math.min(
    MAX_CANDIDATE_COUNT,
    clampSuggestionCount(displayCount) + CANDIDATE_SURPLUS,
  );
}

/**
 * Order suggestions so ones the developer has not been shown recently come
 * first, then trim to the display count. Repeats are kept as backfill rather
 * than dropped, so a genuinely unchanged repository still produces a full
 * list instead of an empty one.
 */
export function rankByNovelty(
  suggestions: readonly NextStepSuggestion[],
  recentTexts: readonly string[],
  displayCount: number,
): NextStepSuggestion[] {
  const recent = new Set(recentTexts.map(suggestionKey));
  const fresh: NextStepSuggestion[] = [];
  const repeats: NextStepSuggestion[] = [];
  for (const suggestion of suggestions) {
    (recent.has(suggestionKey(suggestion.text)) ? repeats : fresh).push(
      suggestion,
    );
  }
  return [...fresh, ...repeats].slice(0, clampSuggestionCount(displayCount));
}

/**
 * Pull the suggestion list out of an assistant reply. Accepts a fenced json
 * block, a bare fenced block, or a raw object, because models drift. Returns
 * an empty array when nothing usable is present — callers treat that as a
 * failed generation rather than throwing.
 */
export function parseSuggestions(
  assistantText: string | null,
  limit: number,
): NextStepSuggestion[] {
  if (!assistantText) return [];
  for (const candidate of jsonCandidates(assistantText)) {
    const parsed = tryParseSuggestionObject(candidate);
    if (parsed.length > 0) {
      return parsed.slice(0, clampCandidateCount(limit));
    }
  }
  return [];
}

function* jsonCandidates(text: string): Generator<string> {
  const fencePattern = /```(?:json)?\s*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fencePattern)) {
    if (match[1]) yield match[1];
  }
  // Fall back to the outermost brace pair in the raw text.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    yield text.slice(firstBrace, lastBrace + 1);
  }
}

function tryParseSuggestionObject(candidate: string): NextStepSuggestion[] {
  let value: unknown;
  try {
    value = JSON.parse(candidate.trim());
  } catch {
    return [];
  }
  const rawList = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.suggestions)
      ? value.suggestions
      : [];
  const suggestions: NextStepSuggestion[] = [];
  for (const entry of rawList) {
    const normalized = normalizeSuggestion(entry);
    if (normalized) suggestions.push(normalized);
  }
  return suggestions;
}

function normalizeSuggestion(entry: unknown): NextStepSuggestion | null {
  if (typeof entry === "string") {
    const text = collapseWhitespace(entry);
    return text ? { text: truncate(text, MAX_SUGGESTION_TEXT_LENGTH), detail: "" } : null;
  }
  if (!isRecord(entry)) return null;
  const text = collapseWhitespace(
    typeof entry.text === "string" ? entry.text : "",
  );
  if (!text) return null;
  const detail = collapseWhitespace(
    typeof entry.detail === "string" ? entry.detail : "",
  );
  return {
    text: truncate(text, MAX_SUGGESTION_TEXT_LENGTH),
    detail: truncate(detail, MAX_SUGGESTION_DETAIL_LENGTH),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function isCacheStale(
  cache: SuggestionCache | undefined,
  refreshMinutes: number,
  nowMs: number,
): boolean {
  if (!cache || cache.suggestions.length === 0) return true;
  const refreshMs = Math.max(1, refreshMinutes) * 60_000;
  return nowMs - cache.generatedAtMs >= refreshMs;
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

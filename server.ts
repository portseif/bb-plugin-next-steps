// bb-plugin-next-steps — backend.
//
// Generates "what should I do next in this repo" suggestions by spawning a
// hidden analysis thread in the project (so it reads the real repository with
// the user's own provider), caches the parsed result per project, and serves it
// to the composer banner over rpc.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  appendHistory,
  buildAnalysisPrompt,
  candidateCountFor,
  clampSuggestionCount,
  excludeUsed,
  isCacheStale,
  parsePositiveInteger,
  parseSuggestions,
  rankByNovelty,
  suggestionKey,
  type SuggestionCache,
} from "./lib/suggestions";

/** Fallback when the refreshMinutes setting is blank or not a number. */
const DEFAULT_REFRESH_MINUTES = 10;
/** A generation that never reports back is abandoned after this long. */
const INFLIGHT_TIMEOUT_MS = 10 * 60_000;
/** Realtime channel the composer banner listens on. */
const SUGGESTIONS_CHANNEL = "suggestions";
/** How many used suggestions to remember per project, so they never return. */
const USED_HISTORY_LIMIT = 60;
/** How many recently proposed suggestions to feed back as "don't repeat these". */
const RECENT_HISTORY_LIMIT = 12;

const suggestionSchema = z.object({
  text: z.string(),
  detail: z.string(),
});

export const rpcContract = defineRpcContract({
  suggestions: {
    input: z
      .object({
        projectId: z.string().nullable(),
        /** The thread the composer is in, so analysis targets its workspace. */
        threadId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      state: z.enum(["ready", "generating", "unavailable"]),
      suggestions: z.array(suggestionSchema),
      generatedAtMs: z.number().nullable(),
      message: z.string().nullable(),
    }),
  },
  refresh: {
    input: z
      .object({ projectId: z.string(), threadId: z.string().nullable() })
      .strict(),
    output: z.object({
      started: z.boolean(),
      message: z.string().nullable(),
    }),
  },
  /** Records a suggestion the developer used so it is never offered again. */
  accept: {
    input: z.object({ projectId: z.string(), text: z.string() }).strict(),
    output: z.object({ remaining: z.number().int() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    suggestionCount: {
      type: "select",
      label: "Suggestions shown",
      options: ["1", "2", "3", "4", "5"],
      default: "3",
    },
    refreshMinutes: {
      type: "string",
      label: "Wait between refreshes (minutes)",
      default: "10",
    },
    autoGenerate: {
      type: "boolean",
      label: "Generate suggestions automatically",
      default: true,
    },
    refreshOnThreadIdle: {
      type: "boolean",
      label: "Refresh when a thread finishes",
      default: true,
    },
    arrowCycling: {
      type: "boolean",
      label: "Cycle suggestions with up/down arrows",
      default: true,
    },
  });

  const cacheKey = (projectId: string) => `cache:${projectId}`;
  const inflightKey = (projectId: string) => `inflight:${projectId}`;
  const analysisKey = (threadId: string) => `analysis:${threadId}`;
  /** Last spawn attempt, success or not — the cooldown that prevents retry loops. */
  const attemptKey = (projectId: string) => `attempt:${projectId}`;
  /** Comparison keys of suggestions the developer already used, per project. */
  const usedKey = (projectId: string) => `used:${projectId}`;
  /** Verbatim text of recently proposed suggestions, fed back into the prompt. */
  const recentKey = (projectId: string) => `recent:${projectId}`;

  // Synchronous companion to the kv inflight row. Two composers mounting at
  // once both await the kv read before either writes it, so the async lock
  // alone can let a second analysis through.
  const spawning = new Set<string>();

  async function readSuggestionCount(): Promise<number> {
    const { suggestionCount } = await settings.get();
    return clampSuggestionCount(Number.parseInt(suggestionCount, 10));
  }

  async function readUsedKeys(projectId: string): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>(usedKey(projectId))) ?? [];
  }

  /**
   * The cache is stored per project and read back with already-used
   * suggestions filtered out, so a suggestion the developer picked never
   * reappears even though it is still in the generated set.
   */
  async function readCache(
    projectId: string,
  ): Promise<SuggestionCache | undefined> {
    const cache = await bb.storage.kv.get<SuggestionCache>(cacheKey(projectId));
    if (!cache) return undefined;
    return {
      ...cache,
      suggestions: excludeUsed(cache.suggestions, await readUsedKeys(projectId)),
    };
  }

  async function readInflight(projectId: string) {
    const inflight = await bb.storage.kv.get<{
      threadId: string;
      startedAtMs: number;
    }>(inflightKey(projectId));
    if (!inflight) return undefined;
    if (Date.now() - inflight.startedAtMs > INFLIGHT_TIMEOUT_MS) {
      await clearInflight(projectId, inflight.threadId);
      return undefined;
    }
    return inflight;
  }

  async function clearInflight(projectId: string, threadId: string) {
    await bb.storage.kv.delete(inflightKey(projectId));
    await bb.storage.kv.delete(analysisKey(threadId));
  }

  /**
   * The analysis only reads the repository, so reuse an existing environment
   * rather than provisioning a fresh worktree per refresh. Prefer the
   * environment of the thread that asked — a project can own several
   * workspaces, and suggestions must describe the one in front of the user.
   * Falls back to any recent environment, then the project default.
   */
  async function resolveEnvironment(
    projectId: string,
    preferredThreadId: string | undefined,
  ): Promise<{ type: "reuse"; environmentId: string } | { type: "project-default" }> {
    if (preferredThreadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: preferredThreadId });
        if (thread.projectId === projectId && thread.environmentId) {
          return { type: "reuse", environmentId: thread.environmentId };
        }
      } catch (error) {
        bb.log.warn(`preferred environment lookup failed: ${describeError(error)}`);
      }
    }
    try {
      const threads = await bb.sdk.threads.list({
        projectId,
        archived: false,
        limit: 20,
      });
      const withEnvironment = threads.find(
        (thread) => thread.environmentId !== null,
      );
      if (withEnvironment?.environmentId) {
        return { type: "reuse", environmentId: withEnvironment.environmentId };
      }
    } catch (error) {
      bb.log.warn(`environment lookup failed: ${describeError(error)}`);
    }
    return { type: "project-default" };
  }

  /**
   * Spawn the hidden analysis thread unless one is already running or the cache
   * is still fresh. Returns whether a new generation started.
   */
  async function requestGeneration(
    projectId: string,
    options: { force: boolean; preferredThreadId?: string },
  ): Promise<{ started: boolean; message: string | null }> {
    if (spawning.has(projectId)) {
      return { started: false, message: "A suggestion run is already starting." };
    }
    const inflight = await readInflight(projectId);
    if (inflight) {
      return { started: false, message: "A suggestion run is already in flight." };
    }

    const { refreshMinutes, autoGenerate } = await settings.get();
    const cooldownMinutes = parsePositiveInteger(
      refreshMinutes,
      DEFAULT_REFRESH_MINUTES,
    );

    if (!options.force) {
      if (!autoGenerate) {
        return { started: false, message: "Automatic analysis is off." };
      }
      // The cooldown is keyed on the last ATTEMPT, not the last success. A run
      // that fails or returns unparseable output must not be retried on the
      // next rpc call, or an empty result becomes an infinite spawn loop.
      const lastAttemptMs =
        (await bb.storage.kv.get<number>(attemptKey(projectId))) ?? 0;
      if (Date.now() - lastAttemptMs < cooldownMinutes * 60_000) {
        return { started: false, message: null };
      }
      const cache = await readCache(projectId);
      if (!isCacheStale(cache, cooldownMinutes, Date.now())) {
        return { started: false, message: null };
      }
    }

    spawning.add(projectId);
    try {
      const suggestionCount = await readSuggestionCount();
      const recent =
        (await bb.storage.kv.get<string[]>(recentKey(projectId))) ?? [];
      await bb.storage.kv.set(attemptKey(projectId), Date.now());
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: await resolveEnvironment(projectId, options.preferredThreadId),
        prompt: buildAnalysisPrompt(candidateCountFor(suggestionCount), recent),
        title: "Next steps analysis",
        visibility: "hidden",
        permissionMode: "auto",
      });
      await bb.storage.kv.set(inflightKey(projectId), {
        threadId: thread.id,
        startedAtMs: Date.now(),
      });
      await bb.storage.kv.set(analysisKey(thread.id), projectId);
      bb.log.info(`analysis thread ${thread.id} started for ${projectId}`);
      bb.realtime.publish(SUGGESTIONS_CHANNEL, { projectId, state: "generating" });
      return { started: true, message: null };
    } catch (error) {
      const message = describeError(error);
      bb.log.warn(`could not start analysis for ${projectId}: ${message}`);
      return { started: false, message };
    } finally {
      spawning.delete(projectId);
    }
  }

  /** Turn a finished analysis thread into a cached suggestion set. */
  async function completeGeneration(
    projectId: string,
    threadId: string,
    assistantText: string | null,
  ) {
    const suggestionCount = await readSuggestionCount();
    const recent = (await bb.storage.kv.get<string[]>(recentKey(projectId))) ?? [];
    // Parse the surplus, drop anything already used, then let unseen
    // suggestions win the limited slots before repeats backfill them.
    const suggestions = rankByNovelty(
      excludeUsed(
        parseSuggestions(assistantText, candidateCountFor(suggestionCount)),
        await readUsedKeys(projectId),
      ),
      recent,
      suggestionCount,
    );
    await clearInflight(projectId, threadId);

    if (suggestions.length === 0) {
      bb.log.warn(`analysis thread ${threadId} returned no usable suggestions`);
      bb.realtime.publish(SUGGESTIONS_CHANNEL, { projectId, state: "empty" });
    } else {
      const cache: SuggestionCache = {
        suggestions,
        generatedAtMs: Date.now(),
        sourceThreadId: threadId,
      };
      await bb.storage.kv.set(cacheKey(projectId), cache);
      // Remember what was proposed so the next run is told to vary from it.
      await bb.storage.kv.set(
        recentKey(projectId),
        appendHistory(
          recent,
          suggestions.map((suggestion) => suggestion.text),
          RECENT_HISTORY_LIMIT,
        ),
      );
      bb.log.info(`cached ${suggestions.length} suggestions for ${projectId}`);
      bb.realtime.publish(SUGGESTIONS_CHANNEL, { projectId, state: "ready" });
    }

    // The analysis thread is disposable; keep it out of the user's way.
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch (error) {
      bb.log.warn(`could not archive ${threadId}: ${describeError(error)}`);
    }
  }

  bb.rpc.register(rpcContract, {
    async suggestions({ projectId, threadId }) {
      if (!projectId) {
        return {
          state: "unavailable" as const,
          suggestions: [],
          generatedAtMs: null,
          message: "No project selected.",
        };
      }
      const cache = await readCache(projectId);
      const inflight = await readInflight(projectId);

      if (!inflight) {
        // Fire and forget so the composer never waits on this. Every guard
        // (auto-generate off, cooldown, fresh cache) lives inside
        // requestGeneration, so repeated reads cannot start repeated runs.
        void requestGeneration(projectId, {
          force: false,
          preferredThreadId: threadId ?? undefined,
        }).catch((error) => {
          bb.log.warn(`background generation failed: ${describeError(error)}`);
        });
      }

      const suggestions = cache?.suggestions ?? [];
      // Only report "generating" when a run is genuinely in flight — a stale
      // cache sitting inside its cooldown is not progress.
      const state: "ready" | "generating" | "unavailable" =
        suggestions.length > 0
          ? "ready"
          : inflight
            ? "generating"
            : "unavailable";
      return {
        state,
        suggestions,
        generatedAtMs: cache?.generatedAtMs ?? null,
        message: null,
      };
    },

    async refresh({ projectId, threadId }) {
      return requestGeneration(projectId, {
        force: true,
        preferredThreadId: threadId ?? undefined,
      });
    },

    async accept({ projectId, text }) {
      await bb.storage.kv.set(
        usedKey(projectId),
        appendHistory(
          await readUsedKeys(projectId),
          [suggestionKey(text)],
          USED_HISTORY_LIMIT,
        ),
      );
      const remaining = (await readCache(projectId))?.suggestions.length ?? 0;
      // Other open composers on this project drop the row too.
      bb.realtime.publish(SUGGESTIONS_CHANNEL, { projectId, state: "ready" });
      return { remaining };
    },
  });

  // A thread finishing is the moment the project's next steps actually change.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const analysisProjectId = await bb.storage.kv.get<string>(
      analysisKey(thread.id),
    );
    if (analysisProjectId) {
      await completeGeneration(analysisProjectId, thread.id, lastAssistantText);
      return;
    }
    if (thread.originPluginId === bb.pluginId) return;
    const { refreshOnThreadIdle } = await settings.get();
    if (!refreshOnThreadIdle) return;
    await requestGeneration(thread.projectId, {
      force: false,
      preferredThreadId: thread.id,
    });
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    const analysisProjectId = await bb.storage.kv.get<string>(
      analysisKey(thread.id),
    );
    if (!analysisProjectId) return;
    bb.log.warn(`analysis thread ${thread.id} failed: ${error ?? "unknown"}`);
    await clearInflight(analysisProjectId, thread.id);
    bb.realtime.publish(SUGGESTIONS_CHANNEL, {
      projectId: analysisProjectId,
      state: "empty",
    });
  });

  bb.cli.register({
    name: "next-steps",
    summary: "Suggested next steps for the current project",
    commands: [
      {
        name: "show",
        summary: "Print the cached suggestions",
        usage: "bb next-steps show [--project <projectId>]",
      },
      {
        name: "refresh",
        summary: "Start a fresh analysis run now",
        usage: "bb next-steps refresh [--project <projectId>]",
      },
      {
        name: "clear",
        summary: "Drop the cached suggestions and the refresh cooldown",
        usage: "bb next-steps clear [--project <projectId>]",
      },
      {
        name: "forget",
        summary: "Forget which suggestions were already used or proposed",
        usage: "bb next-steps forget [--project <projectId>]",
      },
    ],
    async run(argv, ctx) {
      const [command = "show", ...rest] = argv;
      const projectId = readProjectFlag(rest) ?? ctx.projectId;
      if (!projectId) {
        return {
          exitCode: 1,
          stderr: "No project in context — pass --project <projectId>.\n",
        };
      }

      if (command === "clear") {
        await bb.storage.kv.delete(cacheKey(projectId));
        await bb.storage.kv.delete(attemptKey(projectId));
        return { exitCode: 0, stdout: `Cleared suggestions for ${projectId}.\n` };
      }

      if (command === "forget") {
        await bb.storage.kv.delete(usedKey(projectId));
        await bb.storage.kv.delete(recentKey(projectId));
        return {
          exitCode: 0,
          stdout: `Forgot used and recent suggestions for ${projectId}.\n`,
        };
      }

      if (command === "refresh") {
        const result = await requestGeneration(projectId, { force: true });
        return result.started
          ? { exitCode: 0, stdout: "Analysis started.\n" }
          : {
              exitCode: 1,
              stderr: `${result.message ?? "Nothing to do."}\n`,
            };
      }

      if (command !== "show") {
        return { exitCode: 1, stderr: `Unknown command: ${command}\n` };
      }

      const cache = await readCache(projectId);
      if (!cache || cache.suggestions.length === 0) {
        const inflight = await readInflight(projectId);
        return {
          exitCode: 0,
          stdout: inflight
            ? "Analysis in progress.\n"
            : "No suggestions cached — run `bb next-steps refresh`.\n",
        };
      }
      const lines = cache.suggestions.map((suggestion, index) =>
        suggestion.detail
          ? `${index + 1}. ${suggestion.text}  (${suggestion.detail})`
          : `${index + 1}. ${suggestion.text}`,
      );
      const age = Math.round((Date.now() - cache.generatedAtMs) / 60_000);
      lines.push(`\nGenerated ${age} minute(s) ago.`);
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

function readProjectFlag(argv: string[]): string | undefined {
  const index = argv.indexOf("--project");
  return index === -1 ? undefined : argv[index + 1];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

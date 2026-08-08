// bb-plugin-next-steps — frontend.
//
// Renders a bare banner directly above an empty composer listing AI-generated
// next steps for the current project. Right arrow drops the highlighted one
// into the composer; up/down cycle; Escape hides the banner for now.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
  useSettings,
  type PluginComposerScope,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { cn } from "@/lib/utils";

interface Suggestion {
  text: string;
  detail: string;
}

type SuggestionState = "ready" | "generating" | "unavailable";

function resolveProjectId(
  scope: PluginComposerScope,
  contextProjectId: string | null,
): string | null {
  if (scope.kind === "new-thread") return scope.projectId;
  if (scope.kind === "side-chat") return scope.projectId;
  return contextProjectId;
}

/**
 * Arrow keys only belong to us while the caret sits in an empty composer —
 * anywhere else the host (or the browser) should keep them.
 */
function isComposerFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return (
    active.isContentEditable ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement
  );
}

function NextStepsBanner() {
  const view = useComposerView();
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: contextProjectId, threadId } = useBbContext();
  const { values } = useSettings();

  const projectId = resolveProjectId(view.scope, contextProjectId);
  const arrowCycling = values?.arrowCycling !== false;

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [state, setState] = useState<SuggestionState>("unavailable");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);

  const loadRef = useRef<() => void>(() => undefined);
  const load = useCallback(() => {
    if (!projectId) {
      setSuggestions([]);
      setState("unavailable");
      return;
    }
    void rpc
      .call("suggestions", { projectId, threadId })
      .then((result) => {
        setSuggestions(result.suggestions);
        setState(result.state);
        setActiveIndex((current) =>
          current < result.suggestions.length ? current : 0,
        );
      })
      .catch(() => {
        setSuggestions([]);
        setState("unavailable");
      });
  }, [projectId, threadId, rpc]);

  loadRef.current = load;

  // Reset per project so one project's list never leaks into another's view.
  // Keyed on projectId only — hook identities must not retrigger a fetch.
  useEffect(() => {
    setIsDismissed(false);
    setActiveIndex(0);
    loadRef.current();
  }, [projectId]);

  useRealtime("suggestions", (payload) => {
    const signal = payload as { projectId?: string } | null;
    if (!signal || signal.projectId !== projectId) return;
    loadRef.current();
  });

  const isVisible =
    !isDismissed &&
    view.draft.isEmpty &&
    view.draft.attachmentCount === 0 &&
    !view.run.isSubmitting &&
    (suggestions.length > 0 || state === "generating");

  // Keep the keydown handler reading fresh values without rebinding per render.
  const stateRef = useRef({ isVisible, suggestions, activeIndex, arrowCycling });
  stateRef.current = { isVisible, suggestions, activeIndex, arrowCycling };

  const accept = useCallback(
    (suggestion: Suggestion) => {
      composer.setText(suggestion.text);
      composer.focus();
      // Drop it locally right away, and tell the backend so it never comes
      // back for this project — in this composer or any other.
      setSuggestions((current) => {
        const next = current.filter((entry) => entry.text !== suggestion.text);
        setActiveIndex((index) => (index < next.length ? index : 0));
        return next;
      });
      if (projectId) {
        void rpc
          .call("accept", { projectId, text: suggestion.text })
          .catch(() => undefined);
      }
    },
    [composer, projectId, rpc],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const current = stateRef.current;
      if (!current.isVisible || current.suggestions.length === 0) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!isComposerFocused()) return;

      if (event.key === "ArrowRight") {
        const suggestion = current.suggestions[current.activeIndex];
        if (!suggestion) return;
        event.preventDefault();
        event.stopPropagation();
        accept(suggestion);
        return;
      }
      if (event.key === "Escape") {
        // Deliberately not prevented or stopped: Escape also closes host
        // overlays, and a plugin banner must never swallow that.
        setIsDismissed(true);
        return;
      }
      if (!current.arrowCycling) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(
          (index) =>
            (index + step + current.suggestions.length) %
            current.suggestions.length,
        );
      }
    }

    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [accept]);

  if (!isVisible) return null;

  if (suggestions.length === 0) {
    return (
      <div className="px-1 py-0.5 text-xs text-muted-foreground/70">
        Looking at the repo for useful next steps…
      </div>
    );
  }

  return (
    <div className="group/next-steps flex flex-col gap-0.5 px-1 py-0.5">
      {suggestions.map((suggestion, index) => {
        const isActive = index === activeIndex;
        return (
          <button
            key={`${index}-${suggestion.text}`}
            type="button"
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => accept(suggestion)}
            className={cn(
              "group flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground/70 hover:text-muted-foreground",
            )}
          >
            <span className="truncate">{suggestion.text}</span>
            {suggestion.detail ? (
              <span className="hidden truncate text-muted-foreground/60 sm:inline">
                {suggestion.detail}
              </span>
            ) : null}
            <span
              className={cn(
                "ml-auto shrink-0 text-[11px]",
                isActive ? "text-muted-foreground" : "opacity-0",
              )}
              title="Press the right arrow key to use this"
            >
              →
            </span>
          </button>
        );
      })}
      <div className="flex items-center gap-2 px-2 pt-0.5 text-[10px] text-muted-foreground/50 opacity-0 transition-opacity group-hover/next-steps:opacity-100">
        <span>
          {arrowCycling ? "↑↓ pick · → use · esc hide" : "→ use · esc hide"}
        </span>
        <button
          type="button"
          className="ml-auto hover:text-muted-foreground"
          onClick={() => {
            if (!projectId) return;
            setState("generating");
            setSuggestions([]);
            void rpc
              .call("refresh", { projectId, threadId })
              .catch(() => load());
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "next-steps",
    scopes: ["thread", "new-thread", "side-chat"],
    banners: [{ id: "suggestions", chrome: "bare", component: NextStepsBanner }],
  });
});

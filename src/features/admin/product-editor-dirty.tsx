"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type DirtyContextValue = {
  /** Reports whether the section identified by `key` currently has unsaved work. */
  report: (key: string, dirty: boolean) => void;
  /** True when nothing is dirty, or the admin confirmed discarding. Use for programmatic leaves (Cancel). */
  confirmDiscard: (message?: string) => boolean;
  /** Confirms (when dirty) and then steps back in history, skipping the guard's own history entry. */
  goBack: (message?: string) => void;
  /** Leaves to `href` without leaving the guard's extra history entry behind. Use for programmatic leaves (after create). */
  navigate: (href: string, options?: { replace?: boolean }) => void;
};

const DirtyContext = createContext<DirtyContextValue | null>(null);
const DEFAULT_MESSAGE = "You have unsaved changes. Leave this page and discard them?";

/**
 * One registry for the whole product editor: the main form and every nested manager report into it, and this
 * provider owns the ONLY leave-page guards (beforeunload + in-app link clicks), so confirmations never stack.
 * Switching tabs never touches it (panels stay mounted).
 */
export function ProductEditorDirtyProvider({ children }: { children: ReactNode }) {
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const dirty = dirtyKeys.size > 0;
  const dirtyRef = useRef(false);
  const sentinel = useRef(false); // an extra history entry is in place so the Back button can be intercepted
  const suppressPop = useRef(false);
  const unmounting = useRef(false);
  /** A leave that is waiting for the guard's history entry to be popped first. */
  const pendingNav = useRef<{ href: string; replace: boolean } | null>(null);
  const router = useRouter();

  useEffect(() => {
    return () => {
      unmounting.current = true; // declared first, so it runs before the guard cleanup below
    };
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const report = useCallback((key: string, isDirty: boolean) => {
    setDirtyKeys((prev) => {
      if (prev.has(key) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const confirmDiscard = useCallback(
    (message: string = DEFAULT_MESSAGE) => !dirtyRef.current || window.confirm(message),
    [],
  );

  const navigate = useCallback(
    (href: string, options?: { replace?: boolean }) => {
      const replace = options?.replace ?? false;
      if (sentinel.current) {
        // Pop the extra entry first; the popstate handler then performs the navigation from the real entry, so
        // history ends up [..., previous, destination] with no editor duplicate.
        sentinel.current = false;
        suppressPop.current = true;
        pendingNav.current = { href, replace };
        window.history.back();
      } else if (replace) router.replace(href);
      else router.push(href);
    },
    [router],
  );

  const goBack = useCallback((message: string = DEFAULT_MESSAGE) => {
    if (dirtyRef.current && !window.confirm(message)) return;
    if (sentinel.current) {
      sentinel.current = false;
      suppressPop.current = true;
      window.history.go(-2);
    } else {
      window.history.back();
    }
  }, []);

  // One always-mounted popstate listener, so a pending leave still completes if the dirty state clears first.
  useEffect(() => {
    const onPop = () => {
      if (suppressPop.current) {
        // Our own history.back()/go(): finish the leave that asked for it, if any.
        suppressPop.current = false;
        const next = pendingNav.current;
        pendingNav.current = null;
        if (next) {
          if (next.replace) router.replace(next.href);
          else router.push(next.href);
        }
        return;
      }
      // The user pressed Back and popped the guard's entry: ask before really leaving.
      if (!sentinel.current || !dirtyRef.current) return;
      sentinel.current = false;
      if (window.confirm(DEFAULT_MESSAGE)) {
        suppressPop.current = true;
        window.history.back();
      } else {
        window.history.pushState(window.history.state, "", window.location.href);
        sentinel.current = true;
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [router]);

  // While dirty keep exactly one extra same-URL entry so Back can be intercepted.
  useEffect(() => {
    if (!dirty) return;
    window.history.pushState(window.history.state, "", window.location.href);
    sentinel.current = true;
    return () => {
      // Saved while staying on the page: drop the extra entry. Never when unmounting or already leaving.
      if (sentinel.current && !unmounting.current) {
        sentinel.current = false;
        suppressPop.current = true;
        window.history.back();
      }
    };
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // Capture phase on the document runs before Next's <Link> handler, so declining really cancels the navigation.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // full page load: the beforeunload prompt covers it
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      // Always take over the click: either cancel it, or navigate ourselves once the extra history entry is gone.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!window.confirm(DEFAULT_MESSAGE)) return;
      navigate(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, navigate]);

  const value = useMemo(() => ({ report, confirmDiscard, goBack, navigate }), [report, confirmDiscard, goBack, navigate]);
  return <DirtyContext.Provider value={value}>{children}</DirtyContext.Provider>;
}

/** Registers a section's dirty state. Clears automatically when the section unmounts. Safe outside a provider. */
export function useReportDirty(key: string, dirty: boolean) {
  const report = useContext(DirtyContext)?.report;
  useEffect(() => {
    report?.(key, dirty);
  }, [report, key, dirty]);
  useEffect(() => () => report?.(key, false), [report, key]);
}

export function useConfirmDiscard(): (message?: string) => boolean {
  return useContext(DirtyContext)?.confirmDiscard ?? (() => true);
}

export function useEditorGoBack(): (message?: string) => void {
  return useContext(DirtyContext)?.goBack ?? (() => window.history.back());
}

/** Programmatic navigation that cooperates with the guard (falls back to the router outside a provider). */
export function useEditorNavigate(): (href: string, options?: { replace?: boolean }) => void {
  const router = useRouter();
  const ctxNavigate = useContext(DirtyContext)?.navigate;
  return ctxNavigate ?? ((href, options) => (options?.replace ? router.replace(href) : router.push(href)));
}

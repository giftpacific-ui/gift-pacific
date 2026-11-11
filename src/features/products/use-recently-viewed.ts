"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "recently-viewed-products";
const MAX_ITEMS = 12;

// ১. একটি static constant অ্যারে রাখা হলো যাতে Server Snapshot সবসময় একই Reference পায়
const EMPTY_ARRAY: string[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

// Initial snapshot
let cachedSnapshot: string[] = EMPTY_ARRAY;

function readFromStorage(): string[] {
  if (typeof window === "undefined") return EMPTY_ARRAY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : EMPTY_ARRAY;
  } catch {
    return EMPTY_ARRAY;
  }
}

function writeToStorage(ids: string[]) {
  cachedSnapshot = ids;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // localStorage may be unavailable (e.g. private browsing) — safe to ignore.
    }
  }
  listeners.forEach((listener) => listener());
}

/** Re-reads localStorage into the module cache and notifies subscribers if changed. */
function primeFromStorage() {
  const current = readFromStorage();

  // Shallow check to prevent unnecessary re-renders if content is identical
  const isDifferent =
    current.length !== cachedSnapshot.length ||
    current.some((id, index) => id !== cachedSnapshot[index]);

  if (isDifferent) {
    cachedSnapshot = current;
    listeners.forEach((listener) => listener());
  }
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string[] {
  return cachedSnapshot;
}

function getServerSnapshot(): string[] {
  // Server/Hydration Snapshot specific reference returning constant array
  return EMPTY_ARRAY;
}

/** Call once on a product detail page to record that it was viewed. */
export function useRecordRecentlyViewed(productId: string) {
  useEffect(() => {
    const existing = readFromStorage().filter((id) => id !== productId);
    writeToStorage([productId, ...existing].slice(0, MAX_ITEMS));
  }, [productId]);
}

/** Returns recently viewed product IDs (most recent first), excluding one product. */
export function useRecentlyViewedIds(excludeProductId?: string): string[] {
  const ids = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    primeFromStorage();
  }, []);

  return useMemo(
    () =>
      excludeProductId ? ids.filter((id) => id !== excludeProductId) : ids,
    [ids, excludeProductId],
  );
}

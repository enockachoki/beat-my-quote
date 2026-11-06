"use client";

import { useCallback, useRef, useState } from "react";
import { newIdempotencyKey, type ApiError, type ApiResult } from "./api";

/**
 * Wraps a submit action:
 * - ignores repeat clicks while a request is running (duplicate protection);
 * - keeps ONE idempotency key per logical submission until it succeeds, so a
 *   retry after a timeout is recognised by the server as the same request;
 * - exposes busy/error state for loading indicators and messages.
 */
export function useSubmit<A extends unknown[], T>(fn: (key: string, ...args: A) => Promise<ApiResult<T>>) {
  const inFlight = useRef(false);
  const keyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(
    async (...args: A): Promise<ApiResult<T> | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      keyRef.current ??= newIdempotencyKey();
      try {
        const r = await fn(keyRef.current, ...args);
        if (r.ok) keyRef.current = null;
        else {
          setError(r.error);
          // Definitive client errors get a new key next time; transient ones keep it.
          if (r.error.status >= 400 && r.error.status < 500 && r.error.code !== "IDEMPOTENCY_IN_PROGRESS") keyRef.current = null;
        }
        return r;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [fn],
  );

  return { run, busy, error, setError };
}

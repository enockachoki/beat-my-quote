import "server-only";
import { config } from "../config";
import { LocalStorageProvider } from "./local";
import { SupabaseStorageProvider } from "./supabase";
import type { StorageProvider } from "./types";

let provider: StorageProvider | undefined;

export function storage(): StorageProvider {
  if (!provider) {
    const cfg = config();
    if (cfg.STORAGE_PROVIDER === "supabase") {
      if (!cfg.NEXT_PUBLIC_SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY || !cfg.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error("Supabase storage is not configured");
      provider = new SupabaseStorageProvider(cfg.NEXT_PUBLIC_SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, cfg.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    } else {
      if (cfg.APP_ENV === "production") throw new Error("Local storage is not allowed in production");
      provider = new LocalStorageProvider(cfg.LOCAL_STORAGE_DIR, localStorageSecret(), cfg.APP_ORIGIN);
    }
  }
  return provider;
}

export function localStorageSecret(): string {
  const cfg = config();
  const secret = cfg.STORAGE_SIGNING_SECRET ?? cfg.SESSION_SECRET;
  if (!secret) throw new Error("STORAGE_SIGNING_SECRET is required for local storage");
  return secret;
}

export function setStorageForTests(p: StorageProvider | undefined): void {
  provider = p;
}

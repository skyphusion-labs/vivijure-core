import type { Database } from "./platform/types.js";

/** D1-shaped database binding for ported vivijure DB helpers. */
export interface DbEnv {
  DB: Database;
}

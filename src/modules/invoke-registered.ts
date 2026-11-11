// cf#879 MA-14: the ONE way the core invokes a registered module's hook.
//
// A config_schema field marked `scope: "install"` belongs to the operator, who sets it once on the
// settings page (operator-config.ts). It is never the render caller's to set. Before this, the stored
// install value reached a module only on the `notify` hook, and every other hook sent whatever the
// render config held, including an install-scope key a caller chose. `invokeRegistered` closes both
// halves on every hook: each install-scope key in the outgoing config is REPLACED by the stored
// install value (or its schema default), and render-scope keys pass through untouched.
//
// `invokeModule` stays the raw transport. tests/invoke-registered-879.test.ts sweeps src/ and fails
// when any file but this one and registry.ts calls it directly, so a new hook cannot skip this.
import type { Env } from "../platform/orchestrator-context.js";
import type { FetcherLike } from "../platform/types.js";
import type { InvokeRequest, InvokeResponse, RegisteredModule } from "./types.js";
import { invokeModule } from "./registry.js";
import { loadInstallConfig } from "../operator-config.js";

/** What invokeRegistered needs to know about the target: its name (the install store's key) and its
 *  schema (which fields are install-scope). A RegisteredModule satisfies it. */
export type InvokeTarget = Pick<RegisteredModule, "name" | "config_schema">;

/** The config a hook invoke carries: the render config with every install-scope field replaced by the
 *  operator's stored value (or its default). A module with no install-scope field reads no store. */
export async function invokeConfig(
  env: Env,
  target: InvokeTarget,
  config: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  // loadInstallConfig returns {} without a store read when no field is install-scope.
  return { ...(config ?? {}), ...(await loadInstallConfig(env, target.name, target.config_schema)) };
}

/** Invoke one hook on a registered module, with install-scope config owned by the operator. */
export async function invokeRegistered<I = unknown, O = unknown>(
  env: Env,
  target: InvokeTarget,
  fetcher: FetcherLike,
  request: InvokeRequest<I>,
): Promise<InvokeResponse<O>> {
  return invokeModule<I, O>(fetcher, { ...request, config: await invokeConfig(env, target, request.config) });
}

/** The invoke target behind a chain step's binding (a chain stores bindings, not modules). A binding
 *  no registered module carries any more has no schema to read, so it gets no install overlay. */
export function invokeTargetFor(modules: readonly RegisteredModule[], binding: string): InvokeTarget {
  return modules.find((m) => m.binding === binding) ?? { name: binding };
}

// Best-effort notify on a scatter render's terminal state (mirrors film-orchestrator fireNotify).

import type { Env } from "./platform/orchestrator-context.js";
import { discoverModules, invokeModule, resolveFetcher, servingForHook, validateConfig } from "./modules/registry.js";
import { loadInstallConfig } from "./operator-config.js";
import type { NotifyInput, NotifyOutput, RegisteredModule } from "./modules/types.js";
import { presignR2Get, FILM_DOWNLOAD_TTL_SECONDS } from "./presign.js";
import type { ScatterJob } from "./scatter-orchestrator-types.js";


/** core#357: `render.failed` is not a completion, as on the film path. A failure still announces, and
 *  presigns `opts.key` when a retained cut should be linked without becoming `film_key`. A completion
 *  with no artifact has nothing to announce. */
export async function fireNotifyForScatter(
  env: Env,
  job: ScatterJob,
  preModules?: RegisteredModule[],
  opts?: { event?: "render.complete" | "render.failed"; key?: string },
): Promise<void> {
  const event = opts?.event ?? "render.complete";
  const key = opts?.key ?? job.film_key;
  if (event === "render.complete" && !key) return;
  try {
    const envRec = env as unknown as Record<string, unknown>;
    const notifiers = servingForHook(preModules ?? await discoverModules(envRec), "notify");
    if (!notifiers.length) return;
    const download_url = key ? await presignR2Get(env, key, FILM_DOWNLOAD_TTL_SECONDS) : undefined;
    const input: NotifyInput = {
      event,
      film_id: job.scatter_id,
      project: job.project,
      ...(download_url ? { download_url } : {}),
    };
    const context = { project: job.project, job_id: job.scatter_id };
    for (const m of notifiers) {
      const fetcher = resolveFetcher(envRec, m.binding);
      if (!fetcher) continue;
      try {
        // Inject the operator-set install-config (e.g. notify-email's notify_email recipient) as the
        // user config, then clamp through the contract; render-scope fields stay at their defaults.
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule<NotifyInput, NotifyOutput>(fetcher, {
          hook: "notify",
          input,
          config: validateConfig(m.config_schema ?? {}, installConfig),
          context,
        });
      } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn(`scatter notify failed for ${job.scatter_id}: ${(e as Error).message}`);
  }
}

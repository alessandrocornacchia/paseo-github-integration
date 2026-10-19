import type { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  BaseChoice,
  LaunchDefaults,
  launchDefaults,
  listCheckouts,
  saveLaunchDefaults,
  sendOptions,
  sendToChat,
} from "../../shared/board";
import { checkedOutConflict, launchCard, listProjectCheckouts, repositoryIdFor } from "../../shared/launch";
import type { WorktreeStart } from "../../shared/launch";
import { baseKey, readSettings, updateSettings } from "../settings/settings";
import { ensureLocalBranch, gitWorktrees, localBranchExists } from "./checkouts";
import { fetchBaseBranch, findProject, remoteNameFor } from "./project-index";
import type { PaseoApi, ProjectRecord } from "./project-index";

/**
 * The project one card can be sent to, or a refusal that says what to do about
 * it. Both handlers below start here, so "no project" reads the same whether
 * the dialog is opening or the send is running.
 */
export async function requireProject(
  paseo: PaseoApi,
  repository: string,
  url: string,
): Promise<ProjectRecord> {
  const repositoryId = repositoryIdFor(repository, url);
  if (repositoryId === null) {
    throw new Error(`${repository} has no repository URL to match a project against.`);
  }

  const project = await findProject(paseo, repositoryId);
  if (project === undefined) {
    throw new Error(
      `No Paseo project has a git remote pointing at ${repository}. Add it as a project — or add it as a remote on the fork you already have — then send this card again.`,
    );
  }
  return project;
}

export async function listCheckoutsHandler(
  { repository, url }: z.output<typeof listCheckouts.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof listCheckouts.output>> {
  const project = await requireProject(paseo, repository, url);
  if (project.kind !== "git") return { checkouts: [] };
  const worktrees = await gitWorktrees(project.rootPath);
  return { checkouts: await listProjectCheckouts(paseo, project, worktrees) };
}

export async function sendOptionsHandler(
  { repository, url }: z.output<typeof sendOptions.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof sendOptions.output>> {
  const [project, settings] = await Promise.all([
    requireProject(paseo, repository, url),
    readSettings(),
  ]);
  const supportsWorktree = project.kind === "git";
  return {
    project: {
      id: project.projectId,
      name: project.displayName,
      rootPath: project.rootPath,
      supportsWorktree,
    },
    // A worktree preference saved against a git project must not survive into a
    // project that has no worktrees to offer, or the dialog opens on a choice
    // its own picker cannot show.
    defaults: supportsWorktree ? settings.launch : { ...settings.launch, isolation: "local" },
  };
}

export async function launchDefaultsHandler(
  _input: z.output<typeof launchDefaults.input>,
): Promise<z.input<typeof launchDefaults.output>> {
  return (await readSettings()).launch;
}

export async function saveLaunchDefaultsHandler({
  launch,
  base,
}: z.output<typeof saveLaunchDefaults.input>): Promise<z.input<typeof saveLaunchDefaults.output>> {
  await saveLaunch(launch, base === null ? null : { ...base, base: base.choice });
  return { ok: true };
}

/**
 * Saves the next card's defaults and, for a worktree send, the base it used —
 * merged into the remembered bases rather than replacing them, so one
 * repository's choice never forgets another's.
 */
async function saveLaunch(
  launch: LaunchDefaults,
  base: { repository: string; url: string; pullRequest: boolean; base: BaseChoice } | null,
): Promise<void> {
  const repositoryId = base === null ? null : repositoryIdFor(base.repository, base.url);
  if (base === null || repositoryId === null) {
    await updateSettings({ launch });
    return;
  }
  const { bases } = await readSettings();
  await updateSettings({
    launch,
    bases: { ...bases, [baseKey(repositoryId, base.pullRequest)]: base.base },
  });
}

/**
 * A send to the host this board belongs to. The workspace and agent are made by
 * `launchCard`, the same function the dialog runs itself for a send to any
 * other connected host; what only this side can do is find the project through
 * a fork's other git remotes, fetch a base branch the checkout has never seen,
 * and save the next card's defaults in the same round trip.
 */
export async function sendToChatHandler(
  { hostId, pullRequest, pullRequestHead, base, ...input }: z.output<typeof sendToChat.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof sendToChat.output>> {
  const project = await requireProject(paseo, input.repository, input.url);
  const start =
    input.isolation === "worktree"
      ? await resolveStart(project.rootPath, input.repository, input.url, base, pullRequestHead)
      : ({ kind: "default" } as const);
  const result = await launchCard(paseo, project, { ...input, start });

  // Saved only once the send has actually worked, so a configuration that the
  // host rejected is not what the next card opens on.
  const { provider, model, modeId, thinkingOptionId, isolation } = input;
  await saveLaunch(
    { provider, model, modeId, thinkingOptionId, isolation, hostId },
    isolation === "worktree" && base !== null
      ? { repository: input.repository, url: input.url, pullRequest, base }
      : null,
  );

  return result;
}

/**
 * The daemon is asked for the base as a remote-tracking ref on the remote that
 * points at the card's repository — a fork's `upstream`, not its `origin` — and
 * that ref is fetched first, so a branch the checkout has never seen resolves.
 * No base, or no such remote, leaves the daemon on the default branch.
 *
 * The two starts that check a branch out rather than cut one are checked
 * against the worktrees first, because the daemon forks instead of failing
 * (see `WorktreeStart`): a branch some worktree already has is refused with
 * a pointer at Existing checkout, and a pull request whose head branch is
 * already local is checked out as that branch rather than as a `-1` copy of it.
 */
async function resolveStart(
  root: string,
  repository: string,
  url: string,
  base: BaseChoice | null,
  pullRequestHead: string | null,
): Promise<WorktreeStart> {
  const checkoutBranch = base?.kind === "pull-request" ? pullRequestHead : base?.checkout === true ? base.name : null;
  if (checkoutBranch !== null) {
    const worktrees = (await gitWorktrees(root)) ?? [];
    const conflict = checkedOutConflict(
      worktrees.map((worktree) => ({ ...worktree, main: false, workspaceId: null, workspaceName: null })),
      checkoutBranch,
    );
    if (conflict !== null) throw new Error(conflict);
  }
  if (base?.kind === "pull-request") {
    return pullRequestHead !== null && (await localBranchExists(root, pullRequestHead))
      ? { kind: "branch", branch: pullRequestHead }
      : { kind: "pull-request" };
  }
  const repositoryId = repositoryIdFor(repository, url);
  const remote = repositoryId === null ? null : await remoteNameFor(root, repositoryId);
  if (base === null || remote === null) return { kind: "default" };
  if (base.checkout === true) {
    await ensureLocalBranch(root, remote, base.name);
    return { kind: "branch", branch: base.name };
  }
  await fetchBaseBranch(root, remote, base.name);
  return { kind: "ref", ref: `refs/remotes/${remote}/${base.name}` };
}

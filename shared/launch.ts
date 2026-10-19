import type { Checkout, Isolation } from "./board";
import { BOARD_ITEM_TIMELINE_KIND, BOARD_ITEM_TIMELINE_VERSION } from "./timeline";

/**
 * Cutting a workspace for one card and starting its agent, written once for
 * both places a send can run: the daemon's `sendToChatHandler`, for the host
 * the board belongs to, and the launch dialog itself, for any *other* connected
 * host the user picked.
 *
 * The two hand it different APIs — the handler's `paseo`, the dialog's
 * `getPaseoClient(serverId)` — of the same `PaseoApi` type. `shared/` may not
 * import that type (a runtime-specific SDK entry, see
 * `scripts/check-import-boundaries.mjs`), so `LaunchApi` below names only the
 * slice this module calls, and both APIs satisfy it structurally.
 *
 * Like `shared/timeline.ts`, which is its one runtime import, this file imports
 * nothing else at runtime — `./board` is types only — so it stays loadable from
 * the standalone server transpile.
 */

/** Workspace titles are capped at the same length the daemon caps agent titles. */
const MAX_TITLE_CHARS = 200;

export interface LaunchProject {
  projectId: string;
  rootPath: string;
  displayName: string;
  /** `git`, `non_git`, or `directory`; only `git` can be worktreed. */
  kind: string;
}

interface LaunchAgent {
  readonly id: string;
  readonly timeline: {
    append(item: {
      type: "plugin";
      id: string;
      kind: string;
      version: number;
      data: { repository: string; number: number; title: string; url: string; author: string | null; labels: string[] };
    }): Promise<unknown>;
  };
}

interface LaunchWorkspace {
  readonly id: string;
  readonly name: string | null;
  readonly agents: {
    create(options: {
      config: { provider: string; modeId?: string; thinkingOptionId?: string };
      prompt: string;
    }): Promise<LaunchAgent>;
  };
}

type WorktreeSource = { kind: "worktree"; cwd: string; projectId: string } & (
  | { action?: undefined }
  | { action: "branch-off"; refName: string }
  | { action: "checkout"; refName: string }
  | { action: "checkout"; checkoutSource: { kind: "change_request"; forge: "github"; number: number } }
);

export interface LaunchApi {
  readonly workspaces: {
    create(options: {
      title: string;
      firstAgentContext: { prompt: string; attachments: [] };
      source: WorktreeSource | { kind: "directory"; path: string; projectId: string };
    }): Promise<LaunchWorkspace>;
    /** A workspace that already exists, which an Existing send's agent joins. */
    ref(workspaceId: string): LaunchWorkspace;
  };
}

/** The slice of a host's workspace list an Existing send's checkouts are read from. */
export interface WorkspaceListApi {
  readonly workspaces: {
    list(options: { filter: { projectId: string } }): Promise<{
      entries: readonly {
        id: string;
        name: string;
        workspaceDirectory?: string | undefined;
        activityAt: string | null;
        gitRuntime?: { currentBranch?: string | null | undefined } | null | undefined;
      }[];
    }>;
  };
}

/**
 * Where a worktree starts, as the daemon is asked for it. `ref` is always a
 * remote-tracking ref (`refs/remotes/<remote>/<branch>`): the daemon fetches a
 * remote-tracking base before branching, so the agent starts at the remote tip
 * rather than at a local branch nobody has pulled — but only a ref the checkout
 * has fetched at least once resolves, which is why the board's own host fetches
 * it first (`sendToChatHandler`). `pull-request` has the daemon fetch and check
 * out the card's own head branch, forks included. `branch` has it check out a
 * local branch as it is, with no new branch on top — fetched from `origin`
 * first when there is no local branch of that name yet. `default` leaves the
 * base to the daemon, which branches off the checkout's default branch as it
 * stands.
 *
 * The daemon quietly forks rather than fails in two cases a caller has to rule
 * out first, because the fork is exactly the stray branch these starts exist to
 * avoid: `branch` on a branch some worktree already has checked out gets a
 * `<branch>-1` cut from it, and `pull-request` with a local branch of the head's
 * name already there checks the pull request out as `<head>-1`.
 */
export type WorktreeStart =
  | { kind: "ref"; ref: string }
  | { kind: "branch"; branch: string }
  | { kind: "pull-request" }
  | { kind: "default" };

/** Every project a host's daemon knows about, as `projects.list` reports it. */
export interface ProjectListApi {
  readonly projects: {
    list(): Promise<{
      projects: readonly {
        projectId: string;
        projectRootPath: string;
        projectDisplayName: string;
        projectKey?: string | null | undefined;
        projectKind: string;
      }[];
    }>;
  };
}

export interface LaunchInput {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  labels: string[];
  prompt: string;
  isolation: Isolation;
  /** Ignored unless `isolation` is `worktree`. */
  start: WorktreeStart;
  /** Required when `isolation` is `existing`, ignored otherwise. */
  existing: Pick<Checkout, "path" | "workspaceId" | "workspaceName"> | null;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
}

export interface LaunchOutcome {
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  agentId: string;
}

/**
 * A repository's identity as both a project key and a git remote spell it:
 * `<host>/<owner>/<name>`, lowercased. The host comes from the item's own URL
 * rather than a hardcoded `github.com`, so a GitHub Enterprise card matches the
 * enterprise project and not a same-named repository on github.com.
 */
export function repositoryIdFor(repository: string, url: string): string | null {
  if (!repository.includes("/")) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (host === "") return null;
  return `${host}/${repository}`.toLowerCase();
}

/**
 * The project on some host whose own key is this repository. Paseo keys a
 * project with a git remote as `remote:<host>/<owner>/<name>`, which is exactly
 * a card's identity.
 *
 * This is the whole lookup for a *remote* host: the board's own host also
 * scans every project's other git remotes (a fork's `upstream`), but that needs
 * a `git` subprocess on the machine holding the checkout, which the dialog
 * cannot run on someone else's daemon.
 */
export async function findProjectByKey(
  paseo: ProjectListApi,
  repositoryId: string,
): Promise<LaunchProject | undefined> {
  const { projects } = await paseo.projects.list();
  const match = projects.find(
    (project) => (project.projectKey ?? "").toLowerCase() === `remote:${repositoryId}`,
  );
  if (match === undefined) return undefined;
  return {
    projectId: match.projectId,
    rootPath: match.projectRootPath,
    displayName: match.projectDisplayName,
    kind: match.projectKind,
  };
}

/**
 * No `worktreeSlug` in either: the daemon mints a mnemonic one, and then renames
 * the branch after the prompt once the agent is running. A checked-out pull
 * request keeps its own head branch name instead.
 */
function worktreeSource(project: LaunchProject, start: WorktreeStart, number: number): WorktreeSource {
  const where = { kind: "worktree" as const, cwd: project.rootPath, projectId: project.projectId };
  switch (start.kind) {
    case "default":
      return where;
    case "pull-request":
      return { ...where, action: "checkout", checkoutSource: { kind: "change_request", forge: "github", number } };
    case "branch":
      // A bare `refName` with no `checkoutSource` is the daemon's checkout-branch.
      return { ...where, action: "checkout", refName: start.branch };
    case "ref":
      return { ...where, action: "branch-off", refName: start.ref };
  }
}

/**
 * The workspace an Existing send's agent goes into: the one Paseo already has
 * open on that directory, or else a new one on it — a worktree another tool
 * made has none until now. Either way nothing is cut and no branch is made;
 * the agent works on whatever the checkout has checked out.
 */
async function existingWorkspace(
  paseo: LaunchApi,
  project: LaunchProject,
  existing: NonNullable<LaunchInput["existing"]>,
  create: (source: { kind: "directory"; path: string; projectId: string }) => Promise<LaunchWorkspace>,
): Promise<LaunchWorkspace> {
  if (existing.workspaceId === null) {
    return create({ kind: "directory", path: existing.path, projectId: project.projectId });
  }
  const joined = paseo.workspaces.ref(existing.workspaceId);
  // A handle made from a bare id knows no name until refreshed; the list did.
  return { id: joined.id, name: joined.name ?? existing.workspaceName, agents: joined.agents };
}

export async function launchCard(
  paseo: LaunchApi,
  project: LaunchProject,
  input: LaunchInput,
): Promise<LaunchOutcome> {
  const { repository, number, title, url, author, labels, prompt, isolation, start, existing } = input;
  if (isolation === "worktree" && project.kind !== "git") {
    throw new Error(`${project.displayName} is not a git checkout, so it cannot be worktreed.`);
  }
  if (isolation === "existing" && existing === null) {
    throw new Error("Choose the checkout to send this card to.");
  }

  const trimmed = title.trim();
  /**
   * `firstAgentContext` is passed here and *only* here, because this function
   * really does create the agent it promises. The daemon reads it two ways: as
   * naming context for the workspace and its branch, and as `expectsInitialAgent`,
   * which flips the new workspace to an optimistic `running`. A caller that
   * passes it and then creates nothing leaves a workspace spinning until it
   * settles on `done`.
   */
  const create = (source: Parameters<LaunchApi["workspaces"]["create"]>[0]["source"]) =>
    paseo.workspaces
      .create({
        title: (trimmed === "" ? `${repository} #${number}` : trimmed).slice(0, MAX_TITLE_CHARS),
        firstAgentContext: { prompt, attachments: [] },
        source,
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (isolation === "worktree" && start.kind === "ref" && detail.includes("Base branch not found")) {
          throw new Error(
            `${start.ref.replace(/^refs\/remotes\//, "")} has never been fetched in ${project.displayName} on that host. Run \`git fetch\` there, then send this card again.`,
          );
        }
        if (isolation === "worktree" && start.kind === "branch" && detail.includes("Unknown branch")) {
          throw new Error(
            `${start.branch} is neither a local branch nor on origin in ${project.displayName} on that host. Run \`git fetch\` there, then send this card again.`,
          );
        }
        throw cause;
      });
  const workspace =
    isolation === "existing" && existing !== null
      ? await existingWorkspace(paseo, project, existing, create)
      : await create(
          isolation === "worktree"
            ? worktreeSource(project, start, number)
            : { kind: "directory", path: project.rootPath, projectId: project.projectId },
        );

  /**
   * The agent is created *in* the workspace, so the SDK places it on the
   * workspace's own directory — the worktree's path, not the project root, when
   * one was cut. `prompt` rides along as the first message rather than being
   * sent afterwards, so there is no window where the workspace exists with a
   * silent agent in it.
   */
  const agent = await workspace.agents
    .create({
      config: {
        // `provider/model`, which is the only spelling the SDK accepts.
        provider: `${input.provider}/${input.model}`,
        ...(input.modeId === null ? {} : { modeId: input.modeId }),
        ...(input.thinkingOptionId === null ? {} : { thinkingOptionId: input.thinkingOptionId }),
      },
      prompt,
    })
    .catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Workspace “${workspace.name ?? project.displayName}” was created, but the agent could not be started: ${detail}`,
      );
    });

  /**
   * The card the agent is working on, as a persisted row in its own transcript.
   *
   * It lands *after* the opening prompt rather than above it, because the prompt
   * rides along with `agents.create` and there is no agent to append to until
   * that has resolved. That ordering is the price of not opening a window where
   * the workspace exists with a silent agent in it, which matters more.
   *
   * Deliberately not fatal. By this point the workspace and the agent both
   * exist and the prompt has been delivered — the send the user asked for has
   * happened. Failing it here would report an error for a launch that worked and
   * invite the user to send the card a second time, which would cut a second
   * worktree. A missing row costs the transcript its header and nothing else.
   */
  await agent.timeline
    .append({
      type: "plugin",
      id: `${BOARD_ITEM_TIMELINE_KIND}:${repository}#${number}`,
      kind: BOARD_ITEM_TIMELINE_KIND,
      version: BOARD_ITEM_TIMELINE_VERSION,
      data: { repository, number, title, url, author, labels },
    })
    .catch((cause: unknown) => {
      console.warn("[github-board] could not append the timeline row", cause);
    });

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name ?? project.displayName,
    projectName: project.displayName,
    agentId: agent.id,
  };
}

/**
 * `git worktree list --porcelain`, read into the checkouts it names: one block
 * per worktree, the main checkout first. A bare repository has no files to work
 * in and a prunable worktree's directory is gone, so neither is offered.
 */
export function parseWorktreeList(stdout: string): { path: string; branch: string | null }[] {
  const worktrees: { path: string; branch: string | null }[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined || path === "") continue;
    if (lines.some((line) => line === "bare" || line.startsWith("prunable"))) continue;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    worktrees.push({ path, branch: ref === undefined ? null : ref.replace(/^refs\/heads\//, "") });
  }
  return worktrees;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Every checkout of one project an Existing send can join, from what its host
 * reports. `worktrees` is `git worktree list` where it could be run — the
 * board's own host — and null elsewhere, where the checkouts are only those
 * Paseo has a workspace open on, plus the project's own root.
 *
 * Each checkout is matched to the workspace open on its directory, the most
 * recently active one when Local sends have stacked several on the main
 * checkout. Main first, then by path, so the menu reads the same each time.
 */
export async function listProjectCheckouts(
  paseo: WorkspaceListApi,
  project: Pick<LaunchProject, "projectId" | "rootPath">,
  worktrees: readonly { path: string; branch: string | null }[] | null,
): Promise<Checkout[]> {
  const { entries } = await paseo.workspaces.list({ filter: { projectId: project.projectId } });
  const workspaces = [...entries]
    .filter((entry) => typeof entry.workspaceDirectory === "string" && entry.workspaceDirectory !== "")
    .sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? ""));

  const found: { path: string; branch: string | null }[] =
    worktrees === null
      ? [{ path: project.rootPath, branch: null }, ...workspaces.map((entry) => ({
          path: entry.workspaceDirectory ?? "",
          branch: entry.gitRuntime?.currentBranch ?? null,
        }))]
      : [...worktrees];

  const checkouts: Checkout[] = [];
  for (const { path, branch } of found) {
    if (checkouts.some((checkout) => samePath(checkout.path, path))) continue;
    const workspace = workspaces.find((entry) => samePath(entry.workspaceDirectory ?? "", path));
    checkouts.push({
      path,
      // git's answer when there is one; the workspace's own reading otherwise.
      branch: branch ?? workspace?.gitRuntime?.currentBranch ?? null,
      main: samePath(path, project.rootPath),
      workspaceId: workspace?.id ?? null,
      workspaceName: workspace?.name ?? null,
    });
  }
  return checkouts.sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
}

/**
 * Why a new worktree on `branch` would not be what was asked for: some checkout
 * already has it, so the daemon would fork it instead (see `WorktreeStart`).
 * Null when nothing does.
 */
export function checkedOutConflict(checkouts: readonly Checkout[], branch: string | null): string | null {
  if (branch === null) return null;
  const holder = checkouts.find((checkout) => checkout.branch === branch);
  if (holder === undefined) return null;
  return `${branch} is already checked out at ${holder.path}, so a new worktree would fork it. Choose Existing checkout to work there instead.`;
}

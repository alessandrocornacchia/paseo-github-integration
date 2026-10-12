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
 * Like `shared/timeline.ts`, which is its one import, this file imports nothing
 * else at runtime, so it stays loadable from the standalone server transpile.
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
  | { action: "checkout"; checkoutSource: { kind: "change_request"; forge: "github"; number: number } }
);

export interface LaunchApi {
  readonly workspaces: {
    create(options: {
      title: string;
      firstAgentContext: { prompt: string; attachments: [] };
      source: WorktreeSource | { kind: "directory"; path: string; projectId: string };
    }): Promise<LaunchWorkspace>;
  };
}

/**
 * Where a worktree starts, as the daemon is asked for it. `ref` is always a
 * remote-tracking ref (`refs/remotes/<remote>/<branch>`): the daemon fetches a
 * remote-tracking base before branching, so the agent starts at the remote tip
 * rather than at a local branch nobody has pulled — but only a ref the checkout
 * has fetched at least once resolves, which is why the board's own host fetches
 * it first (`sendToChatHandler`). `pull-request` has the daemon fetch and check
 * out the card's own head branch, forks included. `default` leaves the base to
 * the daemon, which branches off the checkout's default branch as it stands.
 */
export type WorktreeStart = { kind: "ref"; ref: string } | { kind: "pull-request" } | { kind: "default" };

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
  isolation: "local" | "worktree";
  /** Ignored unless `isolation` is `worktree`. */
  start: WorktreeStart;
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
  if (start.kind === "default") return where;
  return start.kind === "pull-request"
    ? {
        ...where,
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number },
      }
    : { ...where, action: "branch-off", refName: start.ref };
}

export async function launchCard(
  paseo: LaunchApi,
  project: LaunchProject,
  input: LaunchInput,
): Promise<LaunchOutcome> {
  const { repository, number, title, url, author, labels, prompt, isolation, start } = input;
  if (isolation === "worktree" && project.kind !== "git") {
    throw new Error(`${project.displayName} is not a git checkout, so it cannot be worktreed.`);
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
  const workspace = await paseo.workspaces
    .create({
      title: (trimmed === "" ? `${repository} #${number}` : trimmed).slice(0, MAX_TITLE_CHARS),
      firstAgentContext: { prompt, attachments: [] },
      source:
        isolation === "worktree"
          ? worktreeSource(project, start, number)
          : { kind: "directory", path: project.rootPath, projectId: project.projectId },
    })
    .catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (start.kind === "ref" && detail.includes("Base branch not found")) {
        throw new Error(
          `${start.ref.replace(/^refs\/remotes\//, "")} has never been fetched in ${project.displayName} on that host. Run \`git fetch\` there, then send this card again.`,
        );
      }
      throw cause;
    });

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

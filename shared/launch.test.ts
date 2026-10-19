import { describe, expect, it } from "vitest";
import {
  checkedOutConflict,
  findProjectByKey,
  launchCard,
  listProjectCheckouts,
  parseWorktreeList,
  repositoryIdFor,
} from "./launch";
import type { LaunchApi, LaunchInput, LaunchProject, WorkspaceListApi } from "./launch";

const projects = {
  projects: {
    list: async () => ({
      projects: [
        {
          projectId: "p1",
          projectRootPath: "/srv/nika",
          projectDisplayName: "nika",
          projectKey: "remote:github.com/sands-lab/nika",
          projectKind: "git",
        },
        {
          projectId: "p2",
          projectRootPath: "/srv/scratch",
          projectDisplayName: "scratch",
          projectKey: "host:abc:/srv/scratch",
          projectKind: "directory",
        },
      ],
    }),
  },
};

describe("findProjectByKey", () => {
  it("matches a card to the project keyed by its repository, ignoring case", async () => {
    const id = repositoryIdFor("Sands-Lab/NIKA", "https://github.com/Sands-Lab/NIKA/issues/3");
    expect(id).toBe("github.com/sands-lab/nika");
    const project = await findProjectByKey(projects, id ?? "");
    expect(project).toEqual({ projectId: "p1", rootPath: "/srv/nika", displayName: "nika", kind: "git" });
  });

  it("finds nothing for a repository no project is keyed by", async () => {
    expect(await findProjectByKey(projects, "github.com/octocat/hello")).toBeUndefined();
  });
});

describe("launchCard", () => {
  const input: LaunchInput = {
    repository: "sands-lab/nika",
    number: 3,
    title: "  ",
    url: "https://github.com/sands-lab/nika/issues/3",
    author: "octocat",
    labels: ["bug"],
    prompt: "Fix it",
    isolation: "worktree",
    start: { kind: "default" },
    existing: null,
    provider: "claude",
    model: "opus",
    modeId: null,
    thinkingOptionId: "high",
  };

  function fakeApi() {
    const calls: { workspace?: unknown; joined?: string; agent?: unknown; row?: unknown } = {};
    const agents = {
      create: async (agentOptions: unknown) => {
        calls.agent = agentOptions;
        return {
          id: "a1",
          timeline: {
            append: async (row: unknown) => {
              calls.row = row;
              throw new Error("not fatal");
            },
          },
        };
      },
    };
    const api: LaunchApi = {
      workspaces: {
        create: async (options) => {
          calls.workspace = options;
          return { id: "w1", name: null, agents };
        },
        ref: (workspaceId) => {
          calls.joined = workspaceId;
          return { id: workspaceId, name: null, agents };
        },
      },
    };
    return { api, calls };
  }

  const git: LaunchProject = { projectId: "p1", rootPath: "/srv/nika", displayName: "nika", kind: "git" };

  it("cuts a worktree, starts the agent, and survives a failed timeline row", async () => {
    const { api, calls } = fakeApi();
    const result = await launchCard(api, git, input);
    expect(result).toEqual({ workspaceId: "w1", workspaceName: "nika", projectName: "nika", agentId: "a1" });
    expect(calls.workspace).toMatchObject({
      title: "sands-lab/nika #3",
      source: { kind: "worktree", cwd: "/srv/nika", projectId: "p1" },
    });
    expect(calls.agent).toEqual({
      config: { provider: "claude/opus", thinkingOptionId: "high" },
      prompt: "Fix it",
    });
    expect(calls.row).toMatchObject({ type: "plugin", data: { number: 3, labels: ["bug"] } });
  });

  it("branches off a remote-tracking base, or checks out the pull request", async () => {
    const branch = fakeApi();
    await launchCard(branch.api, git, { ...input, start: { kind: "ref", ref: "refs/remotes/origin/dev" } });
    expect(branch.calls.workspace).toMatchObject({
      source: { kind: "worktree", action: "branch-off", refName: "refs/remotes/origin/dev" },
    });

    const pr = fakeApi();
    await launchCard(pr.api, git, { ...input, start: { kind: "pull-request" } });
    expect(pr.calls.workspace).toMatchObject({
      source: {
        kind: "worktree",
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number: 3 },
      },
    });
  });

  it("checks a branch out as it is, with no new branch on top", async () => {
    const { api, calls } = fakeApi();
    await launchCard(api, git, { ...input, start: { kind: "branch", branch: "feat/x" } });
    expect(calls.workspace).toMatchObject({
      source: { kind: "worktree", action: "checkout", refName: "feat/x" },
    });
    expect(calls.workspace).not.toHaveProperty("source.checkoutSource");
  });

  it("joins the workspace an existing checkout already has, creating nothing", async () => {
    const { api, calls } = fakeApi();
    const result = await launchCard(api, git, {
      ...input,
      isolation: "existing",
      existing: { path: "/srv/nika-feat", workspaceId: "w9", workspaceName: "feat" },
    });
    expect(calls.workspace).toBeUndefined();
    expect(calls.joined).toBe("w9");
    expect(result).toMatchObject({ workspaceId: "w9", workspaceName: "feat", agentId: "a1" });
  });

  it("opens a directory workspace on an existing checkout Paseo has none on", async () => {
    const { api, calls } = fakeApi();
    await launchCard(api, git, {
      ...input,
      isolation: "existing",
      existing: { path: "/srv/nika-other", workspaceId: null, workspaceName: null },
    });
    expect(calls.joined).toBeUndefined();
    expect(calls.workspace).toMatchObject({
      source: { kind: "directory", path: "/srv/nika-other", projectId: "p1" },
    });
  });

  it("refuses an existing send with no checkout chosen", async () => {
    const { api } = fakeApi();
    await expect(launchCard(api, git, { ...input, isolation: "existing" })).rejects.toThrow(
      "Choose the checkout",
    );
  });

  it("explains a base branch the target checkout has never fetched", async () => {
    const api: LaunchApi = {
      workspaces: {
        create: async () => {
          throw new Error("Base branch not found: refs/remotes/origin/dev");
        },
        ref: () => {
          throw new Error("not joined");
        },
      },
    };
    await expect(
      launchCard(api, git, { ...input, start: { kind: "ref", ref: "refs/remotes/origin/dev" } }),
    ).rejects.toThrow("origin/dev has never been fetched in nika on that host");
  });

  it("refuses a worktree on a project that is not a git checkout", async () => {
    const { api } = fakeApi();
    await expect(launchCard(api, { ...git, kind: "directory" }, input)).rejects.toThrow(
      "cannot be worktreed",
    );
  });
});

const PORCELAIN = `worktree /srv/nika
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /srv/nika-feat
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/x

worktree /srv/nika-detached
HEAD 3333333333333333333333333333333333333333
detached

worktree /srv/gone
HEAD 4444444444444444444444444444444444444444
branch refs/heads/old
prunable gitdir file points to non-existent location
`;

describe("parseWorktreeList", () => {
  it("reads every live worktree with its branch, dropping prunable ones", () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: "/srv/nika", branch: "main" },
      { path: "/srv/nika-feat", branch: "feat/x" },
      { path: "/srv/nika-detached", branch: null },
    ]);
  });
});

describe("listProjectCheckouts", () => {
  const workspaces = (
    entries: Awaited<ReturnType<WorkspaceListApi["workspaces"]["list"]>>["entries"],
  ): WorkspaceListApi & { asked?: unknown } => {
    const api: WorkspaceListApi & { asked?: unknown } = {
      workspaces: {
        list: async (options) => {
          api.asked = options;
          return { entries };
        },
      },
    };
    return api;
  };
  const project = { projectId: "p1", rootPath: "/srv/nika" };

  it("matches git's worktrees to the most recently active workspace on each", async () => {
    const api = workspaces([
      { id: "old", name: "Old", workspaceDirectory: "/srv/nika", activityAt: "2026-01-01T00:00:00Z" },
      { id: "new", name: "New", workspaceDirectory: "/srv/nika/", activityAt: "2026-02-01T00:00:00Z" },
      { id: "feat", name: "Feat", workspaceDirectory: "/srv/nika-feat", activityAt: null },
    ]);
    const checkouts = await listProjectCheckouts(api, project, parseWorktreeList(PORCELAIN));
    expect(api.asked).toEqual({ filter: { projectId: "p1" } });
    expect(checkouts).toEqual([
      { path: "/srv/nika", branch: "main", main: true, workspaceId: "new", workspaceName: "New" },
      { path: "/srv/nika-detached", branch: null, main: false, workspaceId: null, workspaceName: null },
      { path: "/srv/nika-feat", branch: "feat/x", main: false, workspaceId: "feat", workspaceName: "Feat" },
    ]);
  });

  it("falls back to the workspaces Paseo has, plus the root, without git", async () => {
    const api = workspaces([
      {
        id: "feat",
        name: "Feat",
        workspaceDirectory: "/srv/nika-feat",
        activityAt: null,
        gitRuntime: { currentBranch: "feat/x" },
      },
    ]);
    expect(await listProjectCheckouts(api, project, null)).toEqual([
      { path: "/srv/nika", branch: null, main: true, workspaceId: null, workspaceName: null },
      { path: "/srv/nika-feat", branch: "feat/x", main: false, workspaceId: "feat", workspaceName: "Feat" },
    ]);
  });
});

describe("checkedOutConflict", () => {
  const checkouts = [
    { path: "/srv/nika-feat", branch: "feat/x", main: false, workspaceId: null, workspaceName: null },
  ];

  it("names the checkout already holding the branch", () => {
    expect(checkedOutConflict(checkouts, "feat/x")).toContain("already checked out at /srv/nika-feat");
  });

  it("finds nothing for a free branch, or no branch at all", () => {
    expect(checkedOutConflict(checkouts, "feat/y")).toBeNull();
    expect(checkedOutConflict(checkouts, null)).toBeNull();
  });
});

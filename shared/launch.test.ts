import { describe, expect, it } from "vitest";
import { findProjectByKey, launchCard, repositoryIdFor } from "./launch";
import type { LaunchApi, LaunchInput, LaunchProject } from "./launch";

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
    provider: "claude",
    model: "opus",
    modeId: null,
    thinkingOptionId: "high",
  };

  function fakeApi() {
    const calls: { workspace?: unknown; agent?: unknown; row?: unknown } = {};
    const api: LaunchApi = {
      workspaces: {
        create: async (options) => {
          calls.workspace = options;
          return {
            id: "w1",
            name: null,
            agents: {
              create: async (agentOptions) => {
                calls.agent = agentOptions;
                return {
                  id: "a1",
                  timeline: {
                    append: async (row) => {
                      calls.row = row;
                      throw new Error("not fatal");
                    },
                  },
                };
              },
            },
          };
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

  it("explains a base branch the target checkout has never fetched", async () => {
    const api: LaunchApi = {
      workspaces: {
        create: async () => {
          throw new Error("Base branch not found: refs/remotes/origin/dev");
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

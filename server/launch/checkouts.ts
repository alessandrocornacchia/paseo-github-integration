import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWorktreeList } from "../../shared/launch";
import { MAX_OUTPUT_BYTES } from "../github/gh";

const execFileAsync = promisify(execFile);

/**
 * Every worktree of the checkout at `root`, whoever made it — Paseo, another
 * tool, or `git worktree add` by hand — with the branch each is on. Null for a
 * directory git cannot read, which leaves the dialog offering only what Paseo
 * itself knows about rather than failing to open.
 */
export async function gitWorktrees(root: string): Promise<{ path: string; branch: string | null }[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return parseWorktreeList(stdout);
  } catch (cause: unknown) {
    console.warn(`[github-board] could not list worktrees of ${root}`, cause);
    return null;
  }
}

/** Whether `root` has a local branch of this name, checked out anywhere or not. */
export async function localBranchExists(root: string, branch: string): Promise<boolean> {
  return execFileAsync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/**
 * Creates a local branch from the card repository's remote when there is none
 * yet, so a checkout of a branch only GitHub has resolves — the daemon itself
 * would only try `origin`, which on a fork is the fork. An existing local
 * branch is left exactly where it is: it may hold work nobody has pushed.
 * Failure is left to the daemon, which reports the unknown branch by name.
 */
export async function ensureLocalBranch(root: string, remote: string, branch: string): Promise<void> {
  if (await localBranchExists(root, branch)) return;
  await execFileAsync(
    "git",
    ["-C", root, "fetch", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`],
    { maxBuffer: MAX_OUTPUT_BYTES, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).catch((cause: unknown) => {
    console.warn(`[github-board] could not fetch ${remote}/${branch} as a local branch`, cause);
  });
}

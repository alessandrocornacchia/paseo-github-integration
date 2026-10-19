import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";

import type { BaseChoice, BoardItem } from "../../shared/board";
import { listBranches } from "../../shared/board";
import type { WorktreeStart } from "../../shared/launch";
import type { ChipMenu } from "./isolation-control";
import type { Choice } from "./pickers";

/** The menu id of "this pull request's own branch"; branches are listed by name. */
const PULL_REQUEST_ID = ":pull-request";

/** What a worktree started from a branch does with it: cut a new one, or take it as is. */
export const BRANCH_MODE_CHOICES: readonly Choice[] = [
  { id: "branch-off", label: "New branch", description: "Cut a new branch from it, as Paseo does." },
  {
    id: "checkout",
    label: "Same branch",
    description: "Check that branch itself out, with no new branch on top.",
  },
];

/**
 * The start a *remote* host is asked for. Its project was matched by its own
 * key, which Paseo takes from `origin`, so `origin` is the remote that points at
 * the card's repository. The board's own host resolves this server-side
 * instead, where it can see a fork's `upstream` and fetch first.
 */
export function remoteStartFor(base: BaseChoice | null): WorktreeStart {
  if (base === null) return { kind: "default" };
  if (base.kind === "pull-request") return { kind: "pull-request" };
  return base.checkout === true
    ? { kind: "branch", branch: base.name }
    : { kind: "ref", ref: `refs/remotes/origin/${base.name}` };
}

/** The branch-mode chip's menu, or null while there is no branch to take as is. */
export function branchModeMenu(
  mode: BaseBranch["branchMode"],
  onSelect: (id: string) => void,
): ChipMenu | null {
  if (mode === null) return null;
  const label = BRANCH_MODE_CHOICES.find((choice) => choice.id === mode)?.label ?? "";
  return { choices: BRANCH_MODE_CHOICES, selectedId: mode, label, onSelect };
}

function branchChoice(name: string, checkout: boolean): BaseChoice {
  return checkout ? { kind: "branch", name, checkout: true } : { kind: "branch", name };
}

/** What one base reads as: its menu id, its branch mode, and the branch it would check out. */
function describeBase(base: BaseChoice | null, pullRequestHead: string | null) {
  if (base === null) return { baseId: null, branchMode: null, checkoutBranch: null };
  if (base.kind === "pull-request") {
    return { baseId: PULL_REQUEST_ID, branchMode: null, checkoutBranch: pullRequestHead };
  }
  const checkout = base.checkout === true;
  return {
    baseId: base.name,
    branchMode: checkout ? ("checkout" as const) : ("branch-off" as const),
    checkoutBranch: checkout ? base.name : null,
  };
}

/** What `useBaseBranch` exposes to the dialog. */
export interface BaseBranch {
  /** Null until the branch list has loaded, and if it could not be; the daemon then picks. */
  base: BaseChoice | null;
  baseId: string | null;
  label: string;
  choices: readonly Choice[];
  selectBase: (id: string) => void;
  /** Null unless the base is a branch, the only start that can be cut or taken as is. */
  branchMode: "branch-off" | "checkout" | null;
  selectBranchMode: (id: string) => void;
  /** The pull request's head branch, when it is in the card's own repository. */
  pullRequestHead: string | null;
  /**
   * The branch this start would check out rather than cut, which no worktree
   * may already hold: the pull request's head, or a branch taken as is.
   */
  checkoutBranch: string | null;
}

/**
 * Where a new worktree starts, for one card: its own branch for a pull request,
 * otherwise a branch of its repository — whatever this repository was last sent
 * with for this kind of card, else the pull request's branch or the default.
 *
 * The list is GitHub's, read once per dialog by the board's own daemon, so it
 * is the same whichever host the card ends up on. A remembered branch that no
 * longer exists, or has fallen out of the hundred most recent, falls back to
 * the default rather than failing the send.
 */
export function useBaseBranch({
  item,
  pullRequest,
}: {
  item: BoardItem;
  pullRequest: boolean;
}): BaseBranch {
  const load = useRpc(listBranches);
  const [listed, setListed] = useState<{
    defaultBranch: string | null;
    branches: string[];
    remembered: BaseChoice | null;
    pullRequestHead: string | null;
  } | null>(null);
  const [chosen, setChosen] = useState<BaseChoice | null>(null);

  useEffect(() => {
    let cancelled = false;
    load({ repository: item.repository, url: item.url, pullRequest, number: item.number })
      .then((result) => {
        if (!cancelled) setListed(result);
      })
      .catch((cause: unknown) => {
        // Not fatal: without a list the worktree starts where the daemon would
        // have started it before this menu existed.
        console.warn("[github-board] could not list branches", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [item.number, item.repository, item.url, load, pullRequest]);

  const choices = useMemo<Choice[]>(() => {
    if (listed === null) return [];
    const branches = listed.branches.map((name) => ({
      id: name,
      label: `From ${name}`,
      description: name === listed.defaultBranch ? "Default branch" : null,
    }));
    return pullRequest
      ? [
          {
            id: PULL_REQUEST_ID,
            label: `PR #${item.number} branch`,
            description: "Check out this pull request's own branch",
          },
          ...branches,
        ]
      : branches;
  }, [item.number, listed, pullRequest]);

  const offered = useCallback(
    (choice: BaseChoice | null): choice is BaseChoice =>
      choice !== null &&
      (choice.kind === "pull-request"
        ? pullRequest
        : (listed?.branches.includes(choice.name) ?? false)),
    [listed, pullRequest],
  );

  let base: BaseChoice | null = null;
  if (listed !== null) {
    const fallback: BaseChoice | null = pullRequest
      ? { kind: "pull-request" }
      : listed.defaultBranch === null
        ? null
        : { kind: "branch", name: listed.defaultBranch };
    base = offered(chosen) ? chosen : offered(listed.remembered) ? listed.remembered : fallback;
  }

  const pullRequestHead = listed?.pullRequestHead ?? null;
  const { baseId, branchMode, checkoutBranch } = describeBase(base, pullRequestHead);

  // A new base keeps the branch mode the old one had, so the toggle reads as a
  // setting of the chip beside it rather than resetting under the user.
  const checkout = branchMode === "checkout";
  const selectBase = useCallback(
    (id: string) => setChosen(id === PULL_REQUEST_ID ? { kind: "pull-request" } : branchChoice(id, checkout)),
    [checkout],
  );

  const selectBranchMode = useCallback(
    (id: string) => {
      if (base?.kind === "branch") setChosen(branchChoice(base.name, id === "checkout"));
    },
    [base],
  );

  // Taken as is, the chip names the branch itself rather than "From" it.
  const listedLabel = choices.find((choice) => choice.id === baseId)?.label ?? "Default branch";
  return {
    base,
    baseId,
    label: checkout && baseId !== null ? baseId : listedLabel,
    choices,
    selectBase,
    branchMode,
    selectBranchMode,
    pullRequestHead,
    checkoutBranch,
  };
}

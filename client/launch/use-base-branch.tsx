import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";

import type { BaseChoice, BoardItem } from "../../shared/board";
import { listBranches } from "../../shared/board";
import type { WorktreeStart } from "../../shared/launch";
import type { Choice } from "./pickers";

/** The menu id of "this pull request's own branch"; branches are listed by name. */
const PULL_REQUEST_ID = ":pull-request";

/**
 * The start a *remote* host is asked for. Its project was matched by its own
 * key, which Paseo takes from `origin`, so `origin` is the remote that points at
 * the card's repository. The board's own host resolves this server-side
 * instead, where it can see a fork's `upstream` and fetch first.
 */
export function remoteStartFor(base: BaseChoice | null): WorktreeStart {
  if (base === null) return { kind: "default" };
  return base.kind === "pull-request"
    ? { kind: "pull-request" }
    : { kind: "ref", ref: `refs/remotes/origin/${base.name}` };
}

/** What `useBaseBranch` exposes to the dialog. */
export interface BaseBranch {
  /** Null until the branch list has loaded, and if it could not be; the daemon then picks. */
  base: BaseChoice | null;
  baseId: string | null;
  label: string;
  choices: readonly Choice[];
  selectBase: (id: string) => void;
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
  } | null>(null);
  const [chosen, setChosen] = useState<BaseChoice | null>(null);

  useEffect(() => {
    let cancelled = false;
    load({ repository: item.repository, url: item.url, pullRequest })
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
  }, [item.repository, item.url, load, pullRequest]);

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

  const selectBase = useCallback((id: string) => {
    setChosen(id === PULL_REQUEST_ID ? { kind: "pull-request" } : { kind: "branch", name: id });
  }, []);

  const baseId = base === null ? null : base.kind === "pull-request" ? PULL_REQUEST_ID : base.name;
  return {
    base,
    baseId,
    label: choices.find((choice) => choice.id === baseId)?.label ?? "Default branch",
    choices,
    selectBase,
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";

import type { BoardItem, Checkout, Isolation } from "../../shared/board";
import { listCheckouts } from "../../shared/board";
import { checkedOutConflict, listProjectCheckouts } from "../../shared/launch";
import type { Choice } from "./pickers";
import type { HostApi, SendProject } from "./use-launch-target";

/** What `useCheckouts` exposes to the dialog. */
export interface Checkouts {
  /** Null until the selected host has answered. */
  checkouts: readonly Checkout[] | null;
  /** The checkout an Existing send would join; null while there is none to offer. */
  selected: Checkout | null;
  choices: readonly Choice[];
  label: string;
  select: (path: string) => void;
}

/**
 * The checkouts of the card's project on the selected host, for an Existing
 * send to join and for a new worktree to be checked against.
 *
 * The board's own host answers with every `git worktree list` entry, made by
 * whatever made it. Any other host is read through its API, which sees only the
 * checkouts Paseo has a workspace open on: a worktree another tool cut there
 * shows up once Paseo has opened it, and not before.
 *
 * Preselected: the checkout already on the pull request's head branch, which is
 * the one a card is most likely being sent back to; otherwise the main
 * checkout, the one choice that means the same thing on every card.
 */
export function useCheckouts({
  item,
  project,
  api,
  isRemote,
  hostId,
  pullRequestHead,
}: {
  item: BoardItem;
  project: SendProject | null;
  api: HostApi | null;
  isRemote: boolean;
  hostId: string;
  pullRequestHead: string | null;
}): Checkouts {
  const load = useRpc(listCheckouts);
  const [listed, setListed] = useState<{ hostId: string; checkouts: Checkout[] } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const projectId = project?.id ?? null;
  const rootPath = project?.rootPath ?? null;
  const supportsWorktree = project?.supportsWorktree === true;
  useEffect(() => {
    setChosen(null);
    if (projectId === null || rootPath === null || !supportsWorktree) return undefined;
    if (isRemote && api === null) return undefined;
    let cancelled = false;
    const lookup =
      !isRemote || api === null
        ? load({ repository: item.repository, url: item.url }).then((result) => result.checkouts)
        : listProjectCheckouts(api, { projectId, rootPath }, null);
    lookup
      .then((checkouts) => {
        if (!cancelled) setListed({ hostId, checkouts });
      })
      .catch((cause: unknown) => {
        // Not fatal: Existing simply has nothing to offer, and the other two
        // isolations never needed the list.
        console.warn("[github-board] could not list checkouts", cause);
        if (!cancelled) setListed({ hostId, checkouts: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, hostId, isRemote, item.repository, item.url, load, projectId, rootPath, supportsWorktree]);

  // An answer for the previously selected host is not this host's answer.
  const checkouts = listed?.hostId === hostId ? listed.checkouts : null;

  const selected = useMemo(() => {
    if (checkouts === null || checkouts.length === 0) return null;
    return (
      checkouts.find((checkout) => checkout.path === chosen) ??
      (pullRequestHead === null ? undefined : checkouts.find((checkout) => checkout.branch === pullRequestHead)) ??
      checkouts.find((checkout) => checkout.main) ??
      checkouts[0] ??
      null
    );
  }, [checkouts, chosen, pullRequestHead]);

  const choices = useMemo<Choice[]>(
    () =>
      (checkouts ?? []).map((checkout) => ({
        id: checkout.path,
        label: checkoutLabel(checkout),
        description: [
          checkout.main ? "Main checkout" : null,
          checkout.branch !== null && checkout.branch === pullRequestHead ? "This pull request's branch" : null,
          checkout.workspaceName === null ? null : `Workspace “${checkout.workspaceName}”`,
          checkout.path,
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
      })),
    [checkouts, pullRequestHead],
  );

  const select = useCallback((path: string) => setChosen(path), []);

  return {
    checkouts,
    selected,
    choices,
    label: selected === null ? (checkouts === null ? "Checkouts…" : "No checkouts") : checkoutLabel(selected),
    select,
  };
}

/**
 * What the chosen isolation needs from the checkouts before a send can go.
 *
 * `error` is why it cannot go as configured, before it is tried: a new worktree
 * that would check out a branch some checkout already holds — which the daemon
 * answers by quietly forking it — or an Existing send with nothing to join.
 * The board's own host checks the first again with git at send time; on any
 * other host this is the only check there is. `existing` is the checkout an
 * Existing send joins, and `ready` is false while one is still being looked up.
 */
export function sendTarget({
  isolation,
  checkouts,
  checkoutBranch,
  project,
  hostLabel,
}: {
  isolation: Isolation;
  checkouts: Checkouts;
  checkoutBranch: string | null;
  /** The project and host, as the message names them. */
  project: SendProject | null;
  hostLabel: string;
}): { error: string | null; ready: boolean; existing: Checkout | null } {
  if (isolation === "worktree") {
    const error = checkedOutConflict(checkouts.checkouts ?? [], checkoutBranch);
    return { error, ready: error === null, existing: null };
  }
  if (isolation === "local") return { error: null, ready: true, existing: null };
  const { selected } = checkouts;
  const error =
    checkouts.checkouts !== null && selected === null
      ? `${project?.name ?? "This project"} has no checkout on ${hostLabel} that Paseo can see.`
      : null;
  return { error, ready: selected !== null, existing: selected };
}

function checkoutLabel(checkout: Checkout): string {
  return checkout.branch ?? `Detached at ${checkout.path.split("/").pop() ?? checkout.path}`;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import * as pluginClient from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";

import type { BoardItem } from "../../shared/board";
import { sendOptions } from "../../shared/board";
import { findProjectByKey, launchCard, repositoryIdFor } from "../../shared/launch";
import type { LaunchInput, LaunchOutcome } from "../../shared/launch";
import type { Choice } from "./pickers";

/**
 * `useHosts` and `getPaseoClient` arrived in Paseo 0.9.0, and this plugin still
 * loads on 0.8. The app hands a plugin its SDK as a plain module object, so on
 * an older app they are simply absent: the dialog then offers the board's own
 * host only, which is what it did before the picker existed.
 */
const multiHost = pluginClient as Partial<typeof pluginClient>;
const getPaseoClient = multiHost.getPaseoClient;
const NO_HOSTS: readonly never[] = [];
const useHosts = multiHost.useHosts ?? (() => NO_HOSTS);

/** A host's whole API, as both `usePaseo()` and `getPaseoClient()` return it. */
export type HostApi = ReturnType<typeof usePaseo>;

export interface SendProject {
  id: string;
  name: string;
  rootPath: string;
  supportsWorktree: boolean;
}

/** What `useLaunchTarget` exposes: where the card goes, and the project it lands in there. */
export interface LaunchTarget {
  /** Every host a card can be sent to right now; one entry hides the chip. */
  hosts: readonly Choice[];
  hostId: string;
  hostLabel: string;
  /** False for the host this board belongs to, whose daemon runs the send itself. */
  isRemote: boolean;
  /** The selected host's API, or null while a remote one cannot be reached. */
  api: HostApi | null;
  selectHost: (id: string) => void;
  project: SendProject | null;
  projectError: string | null;
}

/**
 * Which Paseo host a card is sent to, and the project it lands in there.
 *
 * The board is still bound to the daemon that contributed it — the cards are
 * that host's `gh` — but the *send* need not be: since Paseo 0.11 a plugin
 * client can borrow any online host's API with `getPaseoClient`, the same
 * `PaseoApi` the daemon hands `sendToChatHandler`. So the board's own host keeps
 * its RPC path, which can match a fork through its `upstream` remote, and any
 * other host is asked directly for a project keyed by the card's repository.
 *
 * Offered hosts are the online ones plus the board's own, which is online by
 * construction — the surface could not have rendered otherwise. The last host a
 * card was sent to is preselected while it is still online, and the board's
 * host otherwise, the same "a preference, not a promise" rule the model follows.
 */
export function useLaunchTarget({
  item,
  boardHost,
  savedHostId,
}: {
  item: BoardItem;
  boardHost: { id: string; label: string };
  /** Undefined until the saved defaults have loaded; null for the board's host. */
  savedHostId: string | null | undefined;
}): LaunchTarget {
  const local = usePaseo();
  const loadOptions = useRpc(sendOptions);
  const configured = useHosts();

  const hosts = useMemo<Choice[]>(() => {
    const online = configured.filter(
      (host) => host.status === "online" && host.serverId !== boardHost.id,
    );
    return [
      { id: boardHost.id, label: boardHost.label, description: "This board's host" },
      ...online.map((host) => ({ id: host.serverId, label: host.label, description: null })),
    ];
  }, [boardHost.id, boardHost.label, configured]);

  const [chosen, setChosen] = useState<string | null>(null);
  const savedOnline =
    savedHostId === undefined || savedHostId === null
      ? undefined
      : hosts.find((host) => host.id === savedHostId)?.id;
  // A host that went offline after it was picked falls back to the board's.
  const hostId = hosts.find((host) => host.id === chosen)?.id ?? savedOnline ?? boardHost.id;
  const isRemote = hostId !== boardHost.id;
  const hostLabel = hosts.find((host) => host.id === hostId)?.label ?? boardHost.label;

  const [remote, setRemote] = useState<{ api: HostApi | null; error: string | null }>({
    api: null,
    error: null,
  });
  useEffect(() => {
    if (!isRemote || getPaseoClient === undefined) return;
    try {
      setRemote({ api: getPaseoClient(hostId), error: null });
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setRemote({ api: null, error: `${hostLabel} cannot be reached: ${detail}` });
    }
  }, [hostId, hostLabel, isRemote]);
  const api = isRemote ? remote.api : local;

  const [resolved, setResolved] = useState<{
    hostId: string;
    project: SendProject | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    // Nothing is resolved until the saved host is known, or the dialog would
    // look the card up on the board's host only to throw the answer away.
    if (savedHostId === undefined) return undefined;
    if (isRemote && api === null) return undefined;
    let cancelled = false;
    const settle = (project: SendProject | null, error: string | null) => {
      if (!cancelled) setResolved({ hostId, project, error });
    };
    const lookup: Promise<SendProject> =
      !isRemote || api === null
        ? loadOptions({ repository: item.repository, url: item.url }).then((result) => result.project)
        : findRemoteProject(api, item, hostLabel);
    lookup
      .then((project) => settle(project, null))
      .catch((cause: unknown) => settle(null, cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [api, hostId, hostLabel, isRemote, item, loadOptions, savedHostId]);

  const selectHost = useCallback((id: string) => setChosen(id), []);

  // An answer for the previously selected host is not this host's answer.
  const current = resolved?.hostId === hostId ? resolved : null;
  return {
    hosts,
    hostId,
    hostLabel,
    isRemote,
    api,
    selectHost,
    project: current?.project ?? null,
    projectError: (isRemote ? remote.error : null) ?? current?.error ?? null,
  };
}

async function findRemoteProject(api: HostApi, item: BoardItem, hostLabel: string): Promise<SendProject> {
  const repositoryId = repositoryIdFor(item.repository, item.url);
  if (repositoryId === null) {
    throw new Error(`${item.repository} has no repository URL to match a project against.`);
  }
  const project = await findProjectByKey(api, repositoryId);
  if (project === undefined) {
    throw new Error(
      `No project on ${hostLabel} has ${item.repository} as its git remote. Add it as a project there, then send this card again.`,
    );
  }
  return {
    id: project.projectId,
    name: project.displayName,
    rootPath: project.rootPath,
    supportsWorktree: project.kind === "git",
  };
}

/**
 * A send to a host other than the board's, run from the dialog against that
 * host's own API — its project as `useLaunchTarget` found it — and then the
 * board's daemon told what to open on next. That save is not fatal: the agent
 * is already running.
 */
export async function launchOnRemoteHost(
  api: HostApi,
  project: SendProject,
  input: LaunchInput,
  remember: () => Promise<unknown>,
): Promise<LaunchOutcome> {
  const result = await launchCard(
    api,
    {
      projectId: project.id,
      rootPath: project.rootPath,
      displayName: project.name,
      kind: project.supportsWorktree ? "git" : "directory",
    },
    input,
  );
  await remember().catch((cause: unknown) => {
    console.warn("[github-board] could not save launch defaults", cause);
  });
  return result;
}

import type { z } from "zod";
import type { listBranches } from "../../shared/board";
import { repositoryIdFor } from "../../shared/launch";
import { gh } from "../github/gh";
import { baseKey, readSettings } from "../settings/settings";

/**
 * The default branch and the hundred most recently committed others, in one
 * query. A repository with more branches than that keeps its long tail off the
 * menu, the same trade the label menu makes: the branches anyone starts work
 * from are the recent ones.
 */
const BRANCHES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes { name }
    }
  }
}`;

interface BranchesPayload {
  data?: {
    repository?: {
      defaultBranchRef?: { name?: unknown } | null;
      refs?: { nodes?: unknown };
    } | null;
  };
}

export async function listBranchesHandler({
  repository,
  url,
  pullRequest,
}: z.output<typeof listBranches.input>): Promise<z.input<typeof listBranches.output>> {
  const [owner, name] = repository.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "") {
    throw new Error(`"${repository}" is not an owner/name repository.`);
  }
  const [raw, settings] = await Promise.all([
    gh(["api", "graphql", "-f", `query=${BRANCHES_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`]),
    readSettings(),
  ]);

  const found = (JSON.parse(raw) as BranchesPayload).data?.repository;
  const defaultName = found?.defaultBranchRef?.name;
  const defaultBranch = typeof defaultName === "string" && defaultName !== "" ? defaultName : null;
  const nodes: unknown[] = Array.isArray(found?.refs?.nodes) ? found.refs.nodes : [];
  const names = nodes
    .map((node) => (typeof node === "object" && node !== null ? (node as { name?: unknown }).name : null))
    .filter((entry): entry is string => typeof entry === "string" && entry !== "");
  // The default first, then the rest by recency, so the menu opens on the usual choice.
  const branches = defaultBranch === null ? names : [defaultBranch, ...names.filter((n) => n !== defaultBranch)];

  const repositoryId = repositoryIdFor(repository, url);
  const remembered = repositoryId === null ? undefined : settings.bases[baseKey(repositoryId, pullRequest)];
  return { defaultBranch, branches, remembered: remembered ?? null };
}

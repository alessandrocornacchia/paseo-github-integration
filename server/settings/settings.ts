import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type {
  BaseChoice,
  LaunchDefaults,
  PromptSet,
  PromptSettings,
  legacySettingsTaken,
  saveLogin,
  takeLegacySettings,
} from "../../shared/board";
import { resolveViewerLogin } from "../github/gh";

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

/**
 * Where this plugin keeps what only the daemon may read: the login every `gh`
 * call runs as, and the launch defaults. The directory is named after the
 * plugin id, which the daemon also uses as its config key.
 */
function settingsPath(): string {
  return join(paseoHome(), "plugins", "github-integration", "settings.json");
}

/**
 * The same file under the id this plugin had before it became a repository of
 * its own. Read when the current path has nothing, so a rename does not make a
 * user re-pick their login and launch defaults; the first write lands on the
 * new path and the old file is then dead.
 */
function legacyIdSettingsPath(): string {
  return join(paseoHome(), "plugins", "github-board", "settings.json");
}

/**
 * What the launch dialog opens on before the user touches it. Written by the
 * send itself, so the second card starts where the first one finished.
 *
 * Nothing here is authoritative: the dialog validates every field against the
 * host's live provider snapshot and drops what no longer exists, which is why
 * the whole record is nullable rather than seeded with a guess.
 */
const EMPTY_LAUNCH: LaunchDefaults = {
  provider: null,
  model: null,
  modeId: null,
  thinkingOptionId: null,
  isolation: "local",
  hostId: null,
};

/**
 * The four column ids, as a *historical* constant rather than an import of
 * `COLUMN_IDS`. Everything this module takes from `shared/board` is an
 * `import type` so the server half still transpiles and runs standalone (see
 * CLAUDE.md), and this reads a file format frozen by what older versions wrote
 * — so it should not track a schema that may yet gain a column.
 */
const LEGACY_PROMPT_KEYS: readonly (keyof PromptSet)[] = [
  "issues",
  "draft-prs",
  "open-prs",
  "discussions",
];

/**
 * The three values this file used to own and no longer does, as a version
 * before 0.4.0 wrote them. Held only until the app has copied them into the
 * host settings store, because the daemon cannot write there itself — see
 * `takeLegacySettingsHandler`.
 */
interface LegacySettings {
  hiddenRepositories: string[] | null;
  prompts: PromptSettings | null;
  detailWidthFraction: number | null;
}

/**
 * What the *daemon* keeps, which since 0.4.0 is only what its own handlers act
 * on. The repository filter, the prompt templates and the detail panel's width
 * moved to the host settings store, where the app reads them directly — see
 * `shared/settings.ts`.
 */
export interface Settings {
  /** Null until the user pins one; the caller falls back to the gh viewer. */
  login: string | null;
  launch: LaunchDefaults;
  /**
   * The base each repository was last sent with, keyed `<host>/<owner>/<name>`
   * for issues and discussions and `…#pr` for pull requests — a pull request
   * usually wants its own branch, an issue a branch to start from, so one
   * choice must not overwrite the other.
   */
  bases: Record<string, BaseChoice>;
  /**
   * Non-null only on a file written before the move, and only until the app
   * acknowledges having taken them. Every write puts them back untouched, so a
   * login change made before the app ever loads the board cannot drop them.
   */
  legacy: LegacySettings | null;
}

const EMPTY_SETTINGS: Settings = {
  login: null,
  launch: { ...EMPTY_LAUNCH },
  bases: {},
  legacy: null,
};

/** A share of the body, or null for anything that is not one. */
function readFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : null;
}

/**
 * The old `prompts` blob, structurally. Deliberately loose: this reads a file
 * written by an older version, so anything unrecognisable is dropped rather
 * than failing the migration for the keys that are fine.
 */
function readLegacyPrompts(value: unknown): PromptSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { byType?: unknown; byProject?: unknown };
  const byTypeRaw = typeof raw.byType === "object" && raw.byType !== null ? raw.byType : {};
  const byType: Partial<PromptSet> = {};
  for (const key of LEGACY_PROMPT_KEYS) {
    const template = asString((byTypeRaw as Record<string, unknown>)[key]);
    if (template !== null) byType[key] = template;
  }

  const byProjectRaw =
    typeof raw.byProject === "object" && raw.byProject !== null ? raw.byProject : {};
  const byProject: PromptSettings["byProject"] = {};
  for (const [projectId, overrides] of Object.entries(byProjectRaw as Record<string, unknown>)) {
    if (typeof overrides !== "object" || overrides === null) continue;
    const kept: Partial<PromptSet> = {};
    for (const key of LEGACY_PROMPT_KEYS) {
      const template = asString((overrides as Record<string, unknown>)[key]);
      if (template !== null) kept[key] = template;
    }
    if (Object.keys(kept).length > 0) byProject[projectId] = kept;
  }

  if (Object.keys(byType).length === 0 && Object.keys(byProject).length === 0) return null;
  // `byType` is completed against the defaults by the client, which owns them.
  return { byType: byType as PromptSet, byProject };
}

/**
 * The legacy block, or null when there is nothing to hand over: a file already
 * stamped `settingsMigratedAt`, a fresh install, or a file whose old keys are
 * all absent or unreadable.
 */
function readLegacy(parsed: Record<string, unknown>): LegacySettings | null {
  if (asString(parsed.settingsMigratedAt) !== null) return null;
  const hiddenRepositories = Array.isArray(parsed.hiddenRepositories)
    ? parsed.hiddenRepositories.filter((entry): entry is string => typeof entry === "string")
    : null;
  const prompts = readLegacyPrompts(parsed.prompts);
  const detailWidthFraction = readFraction(parsed.detailWidthFraction);
  if (hiddenRepositories === null && prompts === null && detailWidthFraction === null) return null;
  return { hiddenRepositories, prompts, detailWidthFraction };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Reads back a saved launch selection, defaulting every field it cannot make
 * sense of. A settings file written by an older version of this plugin has no
 * `launch` key at all, which is the same case as a blank one.
 */
function readLaunch(value: unknown): LaunchDefaults {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    provider: asString(raw.provider),
    model: asString(raw.model),
    modeId: asString(raw.modeId),
    thinkingOptionId: asString(raw.thinkingOptionId),
    isolation: raw.isolation === "worktree" ? "worktree" : "local",
    hostId: asString(raw.hostId),
  };
}

/** Remembered bases, dropping any entry an older or hand-edited file got wrong. */
function readBases(value: unknown): Record<string, BaseChoice> {
  if (typeof value !== "object" || value === null) return {};
  const bases: Record<string, BaseChoice> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.kind === "pull-request") bases[key] = { kind: "pull-request" };
    const name = asString(entry.name);
    if (entry.kind === "branch" && name !== null) bases[key] = { kind: "branch", name };
  }
  return bases;
}

/** The key a card's base is remembered under; see `Settings.bases`. */
export function baseKey(repositoryId: string, pullRequest: boolean): string {
  return pullRequest ? `${repositoryId}#pr` : repositoryId;
}

export async function readSettings(): Promise<Settings> {
  for (const path of [settingsPath(), legacyIdSettingsPath()]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const login = record.login;
      return {
        login: typeof login === "string" && login.trim() !== "" ? login.trim() : null,
        launch: readLaunch(record.launch),
        bases: readBases(record.bases),
        legacy: readLegacy(record),
      };
    } catch {
      // This path has nothing, or holds a file we can no longer parse. Try the
      // older one; when neither answers, the caller falls back to the
      // authenticated viewer, which always resolves.
    }
  }
  return EMPTY_SETTINGS;
}

/**
 * Read-modify-write, because the login and the launch defaults are saved by
 * separate handlers and a whole-file write from either would drop the other.
 *
 * The legacy block is written back verbatim while it exists, so a login change
 * made before the app has migrated cannot destroy the values it is about to
 * take. Once it is gone the file is stamped instead, which is what makes
 * `readLegacy` return null forever after.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  const { legacy, ...owned } = next;
  const serialized =
    legacy === null
      ? { ...owned, settingsMigratedAt: new Date().toISOString() }
      : {
          ...owned,
          ...(legacy.hiddenRepositories === null
            ? {}
            : { hiddenRepositories: legacy.hiddenRepositories }),
          ...(legacy.prompts === null ? {} : { prompts: legacy.prompts }),
          ...(legacy.detailWidthFraction === null
            ? {}
            : { detailWidthFraction: legacy.detailWidthFraction }),
        };
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Hands the pre-0.4.0 settings to the app, which is the only side that can
 * write a settings document. Nothing is cleared here: the file keeps them
 * until `legacySettingsTakenHandler` confirms they landed.
 */
export async function takeLegacySettingsHandler(): Promise<
  z.input<typeof takeLegacySettings.output>
> {
  const { legacy } = await readSettings();
  if (legacy === null) return { found: false };
  return {
    found: true,
    hiddenRepositories: legacy.hiddenRepositories,
    prompts: legacy.prompts,
    detailWidthFraction: legacy.detailWidthFraction,
  };
}

export async function legacySettingsTakenHandler(): Promise<
  z.input<typeof legacySettingsTaken.output>
> {
  await updateSettings({ legacy: null });
  return {};
}

export async function saveLoginHandler({
  login,
}: z.output<typeof saveLogin.input>): Promise<z.input<typeof saveLogin.output>> {
  const trimmed = login.trim();
  const resolved = trimmed === "" || trimmed === "@me" ? await resolveViewerLogin() : trimmed;
  await updateSettings({ login: resolved });
  return { login: resolved };
}

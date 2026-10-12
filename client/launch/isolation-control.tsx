import { View } from "react-native";

import type { Isolation } from "../../shared/board";
import type { Styles } from "../theme/use-styles";
import { ChoicePopover, ControlChip, ISOLATION_CHOICES } from "./pickers";
import type { Choice } from "./pickers";
import type { SendProject } from "./use-send-dialog";

/**
 * Where the workspace is cut: the dialog's first control row. It holds the host
 * the card is sent to — shown only when more than one is connected, so a
 * single-host setup sees the dialog it always had — the isolation, and, for a
 * new worktree, the branch it starts from. A non-git project has no worktree to
 * cut, so that chip reads Local and the press is disabled rather than offering
 * a choice that fails.
 *
 * Its own row, out-stacking the scrim so its popover stays clickable — the
 * row raises above the second control row's while its own popover is open.
 */
export function IsolationControl({
  styles,
  project,
  isolation,
  open,
  onToggle,
  onSelect,
  hosts,
  hostId,
  hostLabel,
  hostOpen,
  onToggleHost,
  onSelectHost,
  baseChoices,
  baseId,
  baseLabel,
  baseOpen,
  onToggleBase,
  onSelectBase,
}: {
  styles: Styles;
  project: SendProject | null;
  isolation: Isolation;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  hosts: readonly Choice[];
  hostId: string;
  hostLabel: string;
  hostOpen: boolean;
  onToggleHost: () => void;
  onSelectHost: (id: string) => void;
  baseChoices: readonly Choice[];
  baseId: string | null;
  baseLabel: string;
  baseOpen: boolean;
  onToggleBase: () => void;
  onSelectBase: (id: string) => void;
}) {
  const showBase = isolation === "worktree";
  return (
    <View style={[styles.controlRow, open || hostOpen || baseOpen ? styles.controlRowRaised : null]}>
      {hosts.length > 1 ? (
        <ControlChip styles={styles} label={hostLabel} onPress={onToggleHost} />
      ) : null}
      <ControlChip
        styles={styles}
        label={isolation === "worktree" ? "New worktree" : "Local"}
        disabled={project === null || !project.supportsWorktree}
        onPress={onToggle}
      />
      {open ? (
        <ChoicePopover
          styles={styles}
          direction="down"
          options={ISOLATION_CHOICES}
          selectedId={isolation}
          onSelect={onSelect}
        />
      ) : null}
      {showBase ? (
        <ControlChip
          styles={styles}
          label={baseLabel}
          disabled={baseChoices.length === 0}
          onPress={onToggleBase}
        />
      ) : null}
      {showBase && baseOpen ? (
        <ChoicePopover
          styles={styles}
          direction="down"
          options={baseChoices}
          selectedId={baseId}
          onSelect={onSelectBase}
        />
      ) : null}
      {hostOpen ? (
        <ChoicePopover
          styles={styles}
          direction="down"
          options={hosts}
          selectedId={hostId}
          onSelect={onSelectHost}
        />
      ) : null}
    </View>
  );
}

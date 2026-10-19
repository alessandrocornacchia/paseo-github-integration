import { View } from "react-native";

import type { Isolation } from "../../shared/board";
import type { Styles } from "../theme/use-styles";
import { ChoicePopover, ControlChip, ISOLATION_CHOICES } from "./pickers";
import type { Choice, PickerId } from "./pickers";
import { BRANCH_MODE_CHOICES } from "./use-base-branch";
import type { SendProject } from "./use-send-dialog";

/** One chip and the menu it opens, as the row below lays them out. */
export interface ChipMenu {
  choices: readonly Choice[];
  selectedId: string | null;
  label: string;
  onSelect: (id: string) => void;
}

/**
 * Where the workspace is cut: the dialog's first control row. It holds the host
 * the card is sent to — shown only when more than one is connected, so a
 * single-host setup sees the dialog it always had — the isolation, and what
 * that isolation needs next: for a new worktree, the branch it starts from and,
 * when that is a branch, whether a new branch is cut from it or it is checked
 * out itself; for an existing checkout, which one. A non-git project has
 * neither to offer, so that chip reads Local and the press is disabled rather
 * than offering a choice that fails.
 *
 * Its own row, out-stacking the scrim so its popover stays clickable — the
 * row raises above the second control row's while one of its popovers is open.
 */
export function IsolationControl({
  styles,
  project,
  isolation,
  picker,
  onTogglePicker,
  onSelectIsolation,
  host,
  base,
  branchMode,
  checkout,
}: {
  styles: Styles;
  project: SendProject | null;
  isolation: Isolation;
  picker: PickerId | null;
  onTogglePicker: (id: PickerId) => void;
  onSelectIsolation: (id: string) => void;
  host: ChipMenu;
  base: ChipMenu;
  /** Null unless the worktree starts from a branch. */
  branchMode: ChipMenu | null;
  checkout: ChipMenu;
}) {
  const chips: { id: PickerId; menu: ChipMenu; shown: boolean }[] = [
    { id: "base", menu: base, shown: isolation === "worktree" },
    {
      id: "branch-mode",
      menu: branchMode ?? { choices: BRANCH_MODE_CHOICES, selectedId: null, label: "", onSelect: () => {} },
      shown: isolation === "worktree" && branchMode !== null,
    },
    { id: "checkout", menu: checkout, shown: isolation === "existing" },
  ];
  const raised = picker === "host" || picker === "isolation" || chips.some((chip) => chip.id === picker);
  return (
    <View style={[styles.controlRow, raised ? styles.controlRowRaised : null]}>
      {host.choices.length > 1 ? (
        <ControlChip styles={styles} label={host.label} onPress={() => onTogglePicker("host")} />
      ) : null}
      <ControlChip
        styles={styles}
        label={ISOLATION_CHOICES.find((choice) => choice.id === isolation)?.label ?? "Local"}
        disabled={project === null || !project.supportsWorktree}
        onPress={() => onTogglePicker("isolation")}
      />
      {picker === "isolation" ? (
        <ChoicePopover
          styles={styles}
          direction="down"
          options={ISOLATION_CHOICES}
          selectedId={isolation}
          onSelect={onSelectIsolation}
        />
      ) : null}
      {chips.map((chip) =>
        chip.shown ? (
          <ControlChip
            key={chip.id}
            styles={styles}
            label={chip.menu.label}
            disabled={chip.menu.choices.length === 0}
            onPress={() => onTogglePicker(chip.id)}
          />
        ) : null,
      )}
      {chips.map((chip) =>
        chip.shown && picker === chip.id ? (
          <ChoicePopover
            key={`${chip.id}-menu`}
            styles={styles}
            direction="down"
            options={chip.menu.choices}
            selectedId={chip.menu.selectedId}
            onSelect={chip.menu.onSelect}
          />
        ) : null,
      )}
      {picker === "host" ? (
        <ChoicePopover
          styles={styles}
          direction="down"
          options={host.choices}
          selectedId={host.selectedId}
          onSelect={host.onSelect}
        />
      ) : null}
    </View>
  );
}

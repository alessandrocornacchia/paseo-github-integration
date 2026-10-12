import type { PluginServerContext } from "@getpaseo/plugin/server";

import { loadBoardHandler } from "./server/board/handler";
import { listLabelsHandler, toggleLabelHandler } from "./server/items/labels";
import { loadCommentsHandler } from "./server/items/comments";
import { approveHandler, mergeHandler } from "./server/items/review";
import { loadItemHandler } from "./server/items/details";
import { loadImageHandler } from "./server/images/images";
import {
  launchDefaultsHandler,
  saveLaunchDefaultsHandler,
  sendOptionsHandler,
  sendToChatHandler,
} from "./server/launch/handler";
import { listBranchesHandler } from "./server/launch/branches";
import { listProjectsHandler } from "./server/projects/list";
import { loadProjectHandler } from "./server/projects/single";
import {
  legacySettingsTakenHandler,
  saveLoginHandler,
  takeLegacySettingsHandler,
} from "./server/settings/settings";
import {
  approvePullRequest,
  listLabels,
  listProjects,
  loadBoard,
  loadComments,
  loadImage,
  loadItem,
  loadProject,
  launchDefaults,
  legacySettingsTaken,
  listBranches,
  mergePullRequest,
  saveLaunchDefaults,
  saveLogin,
  takeLegacySettings,
  sendOptions,
  sendToChat,
  toggleLabel,
} from "./shared/board";
import { displaySettings, promptSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.handle(loadBoard, loadBoardHandler);
  server.handle(listProjects, listProjectsHandler);
  server.handle(loadProject, loadProjectHandler);
  server.handle(loadItem, loadItemHandler);
  server.handle(loadComments, loadCommentsHandler);
  server.handle(loadImage, loadImageHandler);
  server.handle(saveLogin, saveLoginHandler);
  server.handle(takeLegacySettings, takeLegacySettingsHandler);
  server.handle(legacySettingsTaken, legacySettingsTakenHandler);
  server.handle(sendOptions, sendOptionsHandler);
  server.handle(sendToChat, sendToChatHandler);
  server.handle(launchDefaults, launchDefaultsHandler);
  server.handle(saveLaunchDefaults, saveLaunchDefaultsHandler);
  server.handle(listBranches, listBranchesHandler);
  server.handle(listLabels, listLabelsHandler);
  server.handle(toggleLabel, toggleLabelHandler);
  server.handle(approvePullRequest, approveHandler);
  server.handle(mergePullRequest, mergeHandler);

  // Storage lives on the host; registering the definitions is what makes the
  // client's `useSettings` reads and writes valid for this installation.
  server.registerSettings(displaySettings);
  server.registerSettings(promptSettings);

  // Every handler awaits its own gh subprocess, so there is nothing to release.
  return () => {};
}

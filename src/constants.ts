import type { Config, PersistedState, TrackerPersistedState } from "./types";

export const APP_STORAGE_KEY = "rally-notifier-state";
export const CONFIG_STORAGE_KEY = "rally-notifier-config";

export const DEFAULT_CONFIG: Omit<Config, "apiKey"> = {
  baseUrl: "https://rally1.rallydev.com",
  workspaceOid: "",
  projectOids: [],
  iterationOid: "",
  iterationName: "",
  iterationStartDate: "",
  pollIntervalMinutes: 5,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
};

export const DEFAULT_TRACKER_STATE: TrackerPersistedState = {
  scopeKey: "",
  cursor: null,
  seenChangeIds: [],
  lastNotificationAt: null,
  history: [],
  lastCheckedAt: null,
  testingRequiredStories: []
};

export const DEFAULT_PERSISTED_STATE: PersistedState = {
  activeTrackerId: null,
  trackers: {}
};

export const STATE_CHANGE_FIELDS = new Set([
  "ScheduleState",
  "State",
  "KanbanState",
  "Blocked",
  "BlockedReason"
]);

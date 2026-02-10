import {
  APP_STORAGE_KEY,
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_PERSISTED_STATE,
  DEFAULT_TRACKER_STATE
} from "./constants";
import type {
  PersistedState,
  StoryChange,
  TestingRequiredStoryRef,
  TrackerConfig,
  TrackerPersistedState
} from "./types";

export type StoredTracker = TrackerConfig;

export function loadTrackers(): StoredTracker[] {
  const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as
      | Partial<StoredTracker>[]
      | (Partial<Omit<StoredTracker, "id" | "name" | "createdAt">> & {
          projectOid?: string;
          projectOids?: string[];
        });

    if (Array.isArray(parsed)) {
      return parsed
        .map((tracker, index) => hydrateTracker(tracker, index))
        .filter((tracker): tracker is StoredTracker => tracker !== null);
    }

    const migrated = hydrateLegacyTracker(parsed);
    return migrated ? [migrated] : [];
  } catch {
    return [];
  }
}

export function saveTrackers(trackers: StoredTracker[]): void {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(trackers));
}

export function loadPersistedState(): PersistedState {
  const raw = localStorage.getItem(APP_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_PERSISTED_STATE };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState> & {
      history?: StoryChange[];
      scopeKey?: string;
      cursor?: string | null;
      seenChangeIds?: string[];
      lastNotificationAt?: string | null;
      lastCheckedAt?: string | null;
    };

    // migration: old single tracker state shape
    if (!parsed.trackers && (parsed.history || parsed.scopeKey || parsed.cursor)) {
      return {
        activeTrackerId: null,
        trackers: {
          legacy: sanitizeTrackerState(parsed)
        }
      };
    }

    const trackers: Record<string, TrackerPersistedState> = {};
    if (parsed.trackers && typeof parsed.trackers === "object") {
      for (const [trackerId, state] of Object.entries(parsed.trackers)) {
        trackers[trackerId] = sanitizeTrackerState(state);
      }
    }

    return {
      activeTrackerId: typeof parsed.activeTrackerId === "string" ? parsed.activeTrackerId : null,
      trackers
    };
  } catch {
    return { ...DEFAULT_PERSISTED_STATE };
  }
}

export function savePersistedState(state: PersistedState): void {
  const trimmed: PersistedState = {
    activeTrackerId: state.activeTrackerId,
    trackers: {}
  };

  for (const [trackerId, trackerState] of Object.entries(state.trackers)) {
    trimmed.trackers[trackerId] = trimTrackerState(trackerState);
  }

  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(trimmed));
}

export function trimTrackerState(state: TrackerPersistedState): TrackerPersistedState {
  const retentionMs = 45 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const history = state.history.filter((entry) => {
    const ts = Date.parse(entry.changedAt);
    return Number.isFinite(ts) && now - ts <= retentionMs;
  });

  return {
    ...state,
    history,
    seenChangeIds: state.seenChangeIds.slice(-2000)
  };
}

export function mergeHistory(existing: StoryChange[], incoming: StoryChange[]): StoryChange[] {
  const map = new Map<string, StoryChange>();
  for (const change of existing) {
    map.set(change.changeId, change);
  }
  for (const change of incoming) {
    map.set(change.changeId, change);
  }

  return [...map.values()].sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
}

export function createScopeKey(config: Pick<StoredTracker, "workspaceOid" | "projectOids" | "iterationOid">): string {
  const sortedProjects = [...config.projectOids].sort().join(",");
  return `${config.workspaceOid}|${sortedProjects}|${config.iterationOid}`;
}

export function createFreshTrackerState(scopeKey: string, iterationStartDate: string): TrackerPersistedState {
  return {
    ...DEFAULT_TRACKER_STATE,
    scopeKey,
    cursor: iterationStartDate || null
  };
}

export function generateTrackerId(): string {
  return `trk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hydrateTracker(tracker: Partial<StoredTracker>, index: number): StoredTracker | null {
  if (!tracker.workspaceOid || !tracker.iterationOid) {
    return null;
  }

  const projectOids = Array.isArray(tracker.projectOids) ? tracker.projectOids : [];
  if (projectOids.length === 0) {
    return null;
  }
  const projectNames = Array.isArray(tracker.projectNames)
    ? tracker.projectNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];

  return {
    id: typeof tracker.id === "string" && tracker.id ? tracker.id : `trk_legacy_${index}`,
    name:
      typeof tracker.name === "string" && tracker.name.trim().length > 0
        ? tracker.name
        : tracker.iterationName || `Sprint ${index + 1}`,
    createdAt:
      typeof tracker.createdAt === "string" && tracker.createdAt
        ? tracker.createdAt
        : new Date().toISOString(),
    baseUrl: tracker.baseUrl || DEFAULT_CONFIG.baseUrl,
    teamsWebhookUrl:
      typeof tracker.teamsWebhookUrl === "string" && tracker.teamsWebhookUrl.trim().length > 0
        ? tracker.teamsWebhookUrl.trim()
        : undefined,
    workspaceOid: tracker.workspaceOid,
    projectOids,
    projectNames,
    iterationOid: tracker.iterationOid,
    iterationName: tracker.iterationName || "",
    iterationStartDate: tracker.iterationStartDate || "",
    pollIntervalMinutes:
      tracker.pollIntervalMinutes === 1 || tracker.pollIntervalMinutes === 10
        ? tracker.pollIntervalMinutes
        : 5,
    timezone: tracker.timezone || DEFAULT_CONFIG.timezone
  };
}

function hydrateLegacyTracker(
  legacy: Partial<Omit<StoredTracker, "id" | "name" | "createdAt">> & {
    projectOid?: string;
    projectOids?: string[];
  }
): StoredTracker | null {
  const projectOids = Array.isArray(legacy.projectOids)
    ? legacy.projectOids
    : legacy.projectOid
      ? [legacy.projectOid]
      : [];

  if (!legacy.workspaceOid || !legacy.iterationOid || projectOids.length === 0) {
    return null;
  }

  return {
    id: generateTrackerId(),
    name: legacy.iterationName || "Sprint Tracker",
    projectNames: [],
    createdAt: new Date().toISOString(),
    baseUrl: legacy.baseUrl || DEFAULT_CONFIG.baseUrl,
    teamsWebhookUrl:
      typeof legacy.teamsWebhookUrl === "string" && legacy.teamsWebhookUrl.trim().length > 0
        ? legacy.teamsWebhookUrl.trim()
        : undefined,
    workspaceOid: legacy.workspaceOid,
    projectOids,
    iterationOid: legacy.iterationOid,
    iterationName: legacy.iterationName || "",
    iterationStartDate: legacy.iterationStartDate || "",
    pollIntervalMinutes:
      legacy.pollIntervalMinutes === 1 || legacy.pollIntervalMinutes === 10
        ? legacy.pollIntervalMinutes
        : 5,
    timezone: legacy.timezone || DEFAULT_CONFIG.timezone
  };
}

function sanitizeTrackerState(state: unknown): TrackerPersistedState {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { ...DEFAULT_TRACKER_STATE };
  }

  const typed = state as Partial<TrackerPersistedState>;
  return {
    ...DEFAULT_TRACKER_STATE,
    ...typed,
    history: Array.isArray(typed.history) ? typed.history : [],
    seenChangeIds: Array.isArray(typed.seenChangeIds) ? typed.seenChangeIds : [],
    testingRequiredStories: sanitizeTestingRequiredStories(typed.testingRequiredStories)
  };
}

function sanitizeTestingRequiredStories(value: unknown): TestingRequiredStoryRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const stories: TestingRequiredStoryRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const storyObjectId = Number(record.storyObjectId);
    const formattedId = typeof record.formattedId === "string" ? record.formattedId.trim() : "";
    if (!Number.isFinite(storyObjectId) || formattedId.length === 0) {
      continue;
    }

    stories.push({ storyObjectId, formattedId });
  }

  return stories;
}

export interface Config {
  baseUrl: string;
  apiKey: string;
  workspaceOid: string;
  projectOids: string[];
  iterationOid: string;
  iterationName: string;
  iterationStartDate: string;
  pollIntervalMinutes: 1 | 5 | 10;
  timezone: string;
}

export interface TrackerConfig extends Omit<Config, "apiKey"> {
  id: string;
  name: string;
  projectNames: string[];
  createdAt: string;
}

export interface WorkspaceOption {
  objectId: string;
  name: string;
}

export interface ProjectOption {
  objectId: string;
  name: string;
}

export interface IterationOption {
  objectId: string;
  name: string;
  projectName?: string;
  startDate?: string;
  endDate?: string;
}

export interface StoryChange {
  changeId: string;
  storyObjectId: number;
  formattedId: string;
  name: string;
  ownerName?: string;
  statusName?: string;
  ready?: boolean;
  scheduleState?: string;
  scheduleStateFrom?: string;
  scheduleStateTo?: string;
  projectName: string;
  changedAt: string;
  changedFields: string[];
  changedBy?: string;
  url: string;
}

export interface SprintStory {
  storyObjectId: number;
  formattedId: string;
  name: string;
  ownerName?: string;
  statusName?: string;
  ready?: boolean;
  scheduleState?: string;
  projectName: string;
  url: string;
}

export interface PollResult {
  currentStories: SprintStory[];
  newChanges: StoryChange[];
  cursor: string;
  apiLatencyMs: number;
  errors?: string[];
}

export interface TestingRequiredStoryRef {
  storyObjectId: number;
  formattedId: string;
}

export interface TrackerPersistedState {
  scopeKey: string;
  cursor: string | null;
  seenChangeIds: string[];
  lastNotificationAt: string | null;
  history: StoryChange[];
  lastCheckedAt: string | null;
  testingRequiredStories: TestingRequiredStoryRef[];
}

export interface PersistedState {
  activeTrackerId: string | null;
  trackers: Record<string, TrackerPersistedState>;
}

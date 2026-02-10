import { RallyClient } from "./rallyClient";
import type { Config, PollResult, SprintStory, StoryChange } from "./types";

const SNAPSHOT_OVERLAP_MS = 15 * 60 * 1000;

export async function fetchStoryChanges(
  client: RallyClient,
  config: Config,
  cursor: string,
  seenIds: Set<string>
): Promise<PollResult> {
  const startedAt = performance.now();

  if (!config.iterationOid) {
    return {
      currentStories: [],
      newChanges: [],
      cursor,
      apiLatencyMs: performance.now() - startedAt,
      errors: ["Select a sprint before polling."]
    };
  }

  const snapshotSince = computeSnapshotSince(cursor, config.iterationStartDate);
  const [currentStories, snapshots] = await Promise.all([
    client.fetchStoriesInIteration(config.iterationOid, config.projectOids),
    client.fetchSnapshots(snapshotSince, config.projectOids, config.iterationOid)
  ]);
  const currentStoryById = new Map<number, SprintStory>();
  for (const story of currentStories) {
    currentStoryById.set(story.storyObjectId, story);
  }

  const storyObjectIds = new Set<number>();
  const projectObjectIds = new Set<number>();
  for (const snapshot of snapshots) {
    const objectId = Number(snapshot.ObjectID);
    if (Number.isFinite(objectId)) {
      storyObjectIds.add(objectId);
    }

    const projectObjectId = extractProjectObjectId(snapshot.Project);
    if (projectObjectId !== null) {
      projectObjectIds.add(projectObjectId);
    }
  }

  const [storyMeta, projectNames] = await Promise.all([
    client.fetchStoryMetadata([...storyObjectIds]),
    client.fetchProjectNames([...projectObjectIds])
  ]);
  const changes: StoryChange[] = [];

  for (const snapshot of snapshots) {
    const storyObjectId = Number(snapshot.ObjectID);
    if (!Number.isFinite(storyObjectId)) {
      continue;
    }

    const changedAt = String(snapshot._ValidFrom ?? "");
    if (!changedAt) {
      continue;
    }

    const changedFields = extractChangedFields(snapshot);
    if (changedFields.length === 0) {
      continue;
    }
    const previousValues = extractPreviousValues(snapshot);

    const changedBy =
      typeof snapshot._User === "string"
        ? snapshot._User
        : typeof snapshot.UserName === "string"
          ? snapshot.UserName
          : undefined;

    const keyBase = `${storyObjectId}:${changedAt}:${changedFields.join(",")}`;
    const changeId = simpleHash(keyBase);

    if (seenIds.has(changeId)) {
      continue;
    }

    const metadata = storyMeta.get(storyObjectId);
    const currentStory = currentStoryById.get(storyObjectId);
    const fallbackName = String(snapshot.Name ?? `Story ${storyObjectId}`);
    const snapshotFormattedId =
      typeof snapshot.FormattedID === "string" && snapshot.FormattedID.trim().length > 0
        ? snapshot.FormattedID
        : undefined;
    const snapshotScheduleState =
      typeof snapshot.ScheduleState === "string" && snapshot.ScheduleState.trim().length > 0
        ? snapshot.ScheduleState
        : undefined;
    const previousScheduleState =
      typeof previousValues.ScheduleState === "string" &&
      previousValues.ScheduleState.trim().length > 0
        ? previousValues.ScheduleState
        : undefined;
    const snapshotOwnerName = extractOwnerName(snapshot.Owner);
    const snapshotStatusName = extractStatusName(snapshot.Status);
    const snapshotReady = extractReadyFlag(snapshot.Ready);
    const snapshotProjectName = extractProjectName(snapshot.Project, projectNames);

    changes.push({
      changeId,
      storyObjectId,
      formattedId:
        currentStory?.formattedId ??
        metadata?.formattedId ??
        snapshotFormattedId ??
        `US${storyObjectId}`,
      name: currentStory?.name ?? metadata?.name ?? fallbackName,
      ownerName: currentStory?.ownerName ?? metadata?.ownerName ?? snapshotOwnerName,
      statusName: snapshotStatusName ?? currentStory?.statusName ?? metadata?.statusName,
      ready: snapshotReady ?? currentStory?.ready ?? metadata?.ready,
      scheduleState: currentStory?.scheduleState ?? metadata?.scheduleState ?? snapshotScheduleState,
      scheduleStateFrom: previousScheduleState,
      scheduleStateTo:
        currentStory?.scheduleState ??
        metadata?.scheduleState ??
        snapshotScheduleState ??
        previousScheduleState,
      projectName:
        currentStory?.projectName ?? metadata?.projectName ?? snapshotProjectName ?? "Unknown Project",
      changedAt,
      changedFields,
      changedBy,
      url: currentStory?.url ?? `${config.baseUrl}/#/detail/userstory/${storyObjectId}`
    });
  }

  changes.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));

  return {
    currentStories: currentStories.sort((a, b) => a.formattedId.localeCompare(b.formattedId)),
    newChanges: dedupe(changes),
    cursor: new Date().toISOString(),
    apiLatencyMs: performance.now() - startedAt
  };
}

function computeSnapshotSince(cursor: string, iterationStartDate: string): string {
  const cursorMs = Date.parse(cursor);
  const iterationStartMs = Date.parse(iterationStartDate);

  if (!Number.isFinite(cursorMs)) {
    return cursor;
  }

  let sinceMs = cursorMs - SNAPSHOT_OVERLAP_MS;
  if (Number.isFinite(iterationStartMs)) {
    sinceMs = Math.max(sinceMs, iterationStartMs);
  }

  return new Date(sinceMs).toISOString();
}

function extractChangedFields(snapshot: Record<string, unknown>): string[] {
  const previous = extractPreviousValues(snapshot);
  return Object.keys(previous).filter((field) => !field.startsWith("_"));
}

function extractPreviousValues(snapshot: Record<string, unknown>): Record<string, unknown> {
  const previous = snapshot._PreviousValues;
  if (typeof previous === "object" && previous && !Array.isArray(previous)) {
    return previous as Record<string, unknown>;
  }

  return {};
}

function dedupe(changes: StoryChange[]): StoryChange[] {
  const map = new Map<string, StoryChange>();
  for (const change of changes) {
    map.set(change.changeId, change);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function extractProjectObjectId(project: unknown): number | null {
  if (typeof project === "number" && Number.isFinite(project)) {
    return project;
  }

  if (typeof project === "string") {
    const fromPath = /\/project\/(\d+)/i.exec(project);
    if (fromPath) {
      return Number(fromPath[1]);
    }

    const numeric = Number(project);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  if (typeof project === "object" && project && !Array.isArray(project)) {
    const record = project as Record<string, unknown>;

    const refValue = record._ref;
    if (typeof refValue === "string") {
      const fromRef = /\/project\/(\d+)/i.exec(refValue);
      if (fromRef) {
        return Number(fromRef[1]);
      }
    }

    const objectIdValue = record.ObjectID;
    if (typeof objectIdValue === "number" && Number.isFinite(objectIdValue)) {
      return objectIdValue;
    }

    if (typeof objectIdValue === "string") {
      const numeric = Number(objectIdValue);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }

  return null;
}

function extractProjectName(
  project: unknown,
  projectNames: Map<number, string>
): string | null {
  const projectObjectId = extractProjectObjectId(project);
  if (projectObjectId !== null) {
    const resolved = projectNames.get(projectObjectId);
    if (resolved) {
      return resolved;
    }
  }

  if (typeof project === "object" && project && !Array.isArray(project)) {
    const record = project as Record<string, unknown>;
    if (typeof record._refObjectName === "string" && record._refObjectName.trim().length > 0) {
      return record._refObjectName;
    }
    if (typeof record.Name === "string" && record.Name.trim().length > 0) {
      return record.Name;
    }
  }

  return null;
}

function extractOwnerName(owner: unknown): string | undefined {
  if (!owner) {
    return undefined;
  }

  if (typeof owner === "string") {
    const trimmed = owner.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof owner === "object" && !Array.isArray(owner)) {
    const record = owner as Record<string, unknown>;
    const fields = ["_refObjectName", "DisplayName", "Name", "UserName"];
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }

  return undefined;
}

function extractStatusName(status: unknown): string | undefined {
  if (!status) {
    return undefined;
  }

  if (typeof status === "string") {
    const trimmed = status.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof status === "object" && !Array.isArray(status)) {
    const record = status as Record<string, unknown>;
    const fields = ["_refObjectName", "Name", "DisplayName"];
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }

  return undefined;
}

function extractReadyFlag(ready: unknown): boolean | undefined {
  if (typeof ready === "boolean") {
    return ready;
  }

  if (typeof ready === "string") {
    const normalized = ready.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

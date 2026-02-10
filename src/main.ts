import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createFreshTrackerState,
  createScopeKey,
  generateTrackerId,
  loadPersistedState,
  loadTrackers,
  mergeHistory,
  savePersistedState,
  saveTrackers,
  type StoredTracker
} from "./appState";
import { fetchStoryChanges } from "./changeFetcher";
import { DEFAULT_CONFIG } from "./constants";
import { NotificationEngine } from "./notificationEngine";
import { RallyAuthError, RallyClient } from "./rallyClient";
import type {
  Config,
  IterationOption,
  PersistedState,
  ProjectOption,
  SprintStory,
  TrackerPersistedState,
  WorkspaceOption
} from "./types";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Missing app root");
}

appRoot.innerHTML = `
  <main class="app-shell">
    <header class="top-bar">
      <div>
        <p class="eyebrow">Rally Story Notifier</p>
        <h1>Sprint Trackers</h1>
      </div>
      <button id="settings-open" class="btn">Add Tracker</button>
    </header>

    <section class="tracker-section">
      <p class="label">Tracked Sprints</p>
      <div class="tracker-controls">
        <select id="tracker-select" class="tracker-select"></select>
        <button id="delete-tracker" class="btn btn-danger" type="button">Delete</button>
      </div>
    </section>

    <section class="status-grid">
      <article>
        <p class="label">Last checked</p>
        <div class="last-checked-row">
          <p id="last-checked">Never</p>
          <button id="refresh-now" class="btn btn-subtle btn-compact" type="button">Refresh</button>
        </div>
      </article>
      <article>
        <p class="label">Status</p>
        <p id="status-text">Add a sprint tracker to start polling.</p>
      </article>
    </section>

    <section class="tabs">
      <button id="tab-stories" class="chip chip-active">Current Stories</button>
      <button id="tab-all" class="chip">Logs</button>
      <button id="tab-testing" class="chip">Testing Required</button>
    </section>

    <section>
      <ul id="panel-list" class="change-list"></ul>
    </section>
  </main>

  <dialog id="settings-modal">
    <form id="settings-form" method="dialog" class="settings-form">
      <h2>Add Sprint Tracker</h2>

      <label>
        Rally base URL
        <input id="base-url" required placeholder="https://rally1.rallydev.com" />
      </label>

      <label>
        API key
        <input id="api-key" required type="password" placeholder="_abc123..." />
      </label>

      <div class="inline-row">
        <label>
          Workspace
          <select id="workspace-oid"></select>
        </label>
        <button type="button" id="load-workspaces" class="btn btn-subtle">Load</button>
      </div>

      <div class="inline-row">
        <label>
          Projects (multi-select)
          <select id="project-oids" multiple size="8"></select>
          <span class="input-hint">Hold Command to select multiple projects.</span>
        </label>
        <button type="button" id="load-projects" class="btn btn-subtle">Load</button>
      </div>

      <div class="inline-row">
        <label>
          Sprint
          <select id="iteration-oid"></select>
          <span class="input-hint">Select one sprint to track.</span>
        </label>
        <button type="button" id="load-sprints" class="btn btn-subtle">Load</button>
      </div>

      <label>
        Polling interval
        <select id="poll-interval">
          <option value="1">1 minute</option>
          <option value="5" selected>5 minutes</option>
          <option value="10">10 minutes</option>
        </select>
      </label>

      <div class="footer-actions">
        <button type="button" id="test-connection" class="btn btn-subtle">Test connection</button>
        <button type="submit" id="save-settings" class="btn" disabled>Add Tracker</button>
      </div>
      <p id="settings-feedback" class="feedback"></p>
    </form>
  </dialog>
`;

const settingsModal = query<HTMLDialogElement>("#settings-modal");
const settingsForm = query<HTMLFormElement>("#settings-form");
const settingsOpen = query<HTMLButtonElement>("#settings-open");
const loadWorkspacesButton = query<HTMLButtonElement>("#load-workspaces");
const loadProjectsButton = query<HTMLButtonElement>("#load-projects");
const loadSprintsButton = query<HTMLButtonElement>("#load-sprints");
const testConnectionButton = query<HTMLButtonElement>("#test-connection");
const saveSettingsButton = query<HTMLButtonElement>("#save-settings");

const storiesTabButton = query<HTMLButtonElement>("#tab-stories");
const allTabButton = query<HTMLButtonElement>("#tab-all");
const testingTabButton = query<HTMLButtonElement>("#tab-testing");

const baseUrlInput = query<HTMLInputElement>("#base-url");
const apiKeyInput = query<HTMLInputElement>("#api-key");
const workspaceSelect = query<HTMLSelectElement>("#workspace-oid");
const projectsSelect = query<HTMLSelectElement>("#project-oids");
const sprintSelect = query<HTMLSelectElement>("#iteration-oid");
const pollIntervalSelect = query<HTMLSelectElement>("#poll-interval");
const feedbackText = query<HTMLParagraphElement>("#settings-feedback");

const trackerSelect = query<HTMLSelectElement>("#tracker-select");
const deleteTrackerButton = query<HTMLButtonElement>("#delete-tracker");
const refreshNowButton = query<HTMLButtonElement>("#refresh-now");
const lastCheckedText = query<HTMLParagraphElement>("#last-checked");
const statusText = query<HTMLParagraphElement>("#status-text");
const panelList = query<HTMLUListElement>("#panel-list");

const notificationEngine = new NotificationEngine();

type ActiveTab = "stories" | "all" | "testing";

let trackers: StoredTracker[] = loadTrackers();
let appState: PersistedState = loadPersistedState();
let apiKey = "";
let pollingTimer: number | null = null;
let pollInFlight = false;
let activeTab: ActiveTab = "stories";
const BROWSER_API_KEY_STORAGE = "rally-notifier-api-key";

let workspaces: WorkspaceOption[] = [];
let projects: ProjectOption[] = [];
let visibleSprints: IterationOption[] = [];

const currentStoriesByTracker = new Map<string, SprintStory[]>();
const statusByTracker = new Map<string, string>();
const lastPollByTracker = new Map<string, number>();

settingsOpen.addEventListener("click", () => {
  openSettingsForNewTracker();
});

for (const input of [
  baseUrlInput,
  apiKeyInput,
  workspaceSelect,
  projectsSelect,
  sprintSelect,
  pollIntervalSelect
]) {
  input.addEventListener("change", updateSaveButtonState);
  input.addEventListener("input", updateSaveButtonState);
}

workspaceSelect.addEventListener("change", () => {
  visibleSprints = [];
  setSingleSelectPlaceholder(sprintSelect, "Load sprints");
  updateSaveButtonState();
});

projectsSelect.addEventListener("change", () => {
  visibleSprints = [];
  setSingleSelectPlaceholder(sprintSelect, "Load sprints");
  updateSaveButtonState();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isSettingsFormComplete()) {
    feedbackText.textContent = "Fill all fields before adding tracker.";
    updateSaveButtonState();
    return;
  }

  const selectedProjectOids = getSelectedValues(projectsSelect);
  const selectedIterationOid = sprintSelect.value;
  const selectedIteration = visibleSprints.find((iteration) => iteration.objectId === selectedIterationOid);
  const nextApiKey = apiKeyInput.value.trim();

  if (!selectedIteration) {
    feedbackText.textContent = "Select a valid sprint.";
    return;
  }

  try {
    await saveApiKey(nextApiKey);
    apiKey = nextApiKey;

    const projectNameById = new Map(projects.map((project) => [project.objectId, project.name]));
    const selectedProjectNames = selectedProjectOids
      .map((projectOid) => projectNameById.get(projectOid))
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);

    const tracker: StoredTracker = {
      id: generateTrackerId(),
      name: selectedIteration.name,
      projectNames: selectedProjectNames,
      createdAt: new Date().toISOString(),
      baseUrl: baseUrlInput.value.trim(),
      workspaceOid: workspaceSelect.value,
      projectOids: selectedProjectOids,
      iterationOid: selectedIteration.objectId,
      iterationName: selectedIteration.name,
      iterationStartDate: selectedIteration.startDate ?? new Date().toISOString(),
      pollIntervalMinutes: Number(pollIntervalSelect.value) as 1 | 5 | 10,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    trackers = [tracker, ...trackers];
    saveTrackers(trackers);

    appState.trackers[tracker.id] = createFreshTrackerState(
      createScopeKey(tracker),
      tracker.iterationStartDate
    );
    appState.activeTrackerId = tracker.id;
    savePersistedState(appState);

    currentStoriesByTracker.set(tracker.id, []);
    statusByTracker.set(tracker.id, "Tracker created. Polling soon.");

    feedbackText.textContent = "Tracker added.";
    settingsModal.close();
    ensureActiveTracker();
    renderTrackerList();
    renderStatus();
    renderActiveTab();
    startPolling();
  } catch (error) {
    feedbackText.textContent = formatError(error, "Failed to add tracker.");
  }
});

loadWorkspacesButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim() || apiKey;
  if (!key) {
    feedbackText.textContent = "Enter an API key first.";
    return;
  }

  feedbackText.textContent = "Loading workspaces...";
  const client = new RallyClient(buildConfigForForm(key));

  try {
    workspaces = await client.listWorkspaces();
    populateSingleSelect(workspaceSelect, workspaces, workspaceSelect.value, "Select workspace");
    feedbackText.textContent = `Loaded ${workspaces.length} workspaces.`;
    updateSaveButtonState();
  } catch (error) {
    feedbackText.textContent = formatError(error, "Unable to load workspaces.");
  }
});

loadProjectsButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim() || apiKey;
  if (!key || !workspaceSelect.value) {
    feedbackText.textContent = "Choose a workspace and provide API key first.";
    return;
  }

  feedbackText.textContent = "Loading projects...";
  const client = new RallyClient(buildConfigForForm(key));

  try {
    projects = await client.listProjects(workspaceSelect.value);
    populateMultiSelect(projectsSelect, projects, getSelectedValues(projectsSelect));
    visibleSprints = [];
    setSingleSelectPlaceholder(sprintSelect, "Load sprints");
    feedbackText.textContent = `Loaded ${projects.length} projects. Select one or more.`;
    updateSaveButtonState();
  } catch (error) {
    feedbackText.textContent = formatError(error, "Unable to load projects.");
  }
});

loadSprintsButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim() || apiKey;
  const selectedProjectOids = getSelectedValues(projectsSelect);

  if (!key || !workspaceSelect.value) {
    feedbackText.textContent = "Choose a workspace and provide API key first.";
    return;
  }

  if (selectedProjectOids.length === 0) {
    feedbackText.textContent = "Select at least one project before loading sprints.";
    return;
  }

  feedbackText.textContent = "Loading sprints...";
  const client = new RallyClient(buildConfigForForm(key, selectedProjectOids));

  try {
    const iterationSets = await Promise.all(
      selectedProjectOids.map((projectOid) => client.listProjectIterations(projectOid))
    );

    const projectNameById = new Map(projects.map((project) => [project.objectId, project.name]));
    const merged = new Map<string, IterationOption>();
    for (let i = 0; i < iterationSets.length; i += 1) {
      const projectOid = selectedProjectOids[i];
      const projectName = projectNameById.get(projectOid) ?? `Project ${projectOid}`;
      for (const iteration of iterationSets[i]) {
        const dedupeKey = `${iteration.name.trim().toLowerCase()}|${iteration.startDate ?? ""}|${iteration.endDate ?? ""}|${projectOid}`;
        if (!merged.has(dedupeKey)) {
          merged.set(dedupeKey, {
            ...iteration,
            projectName
          });
        }
      }
    }

    visibleSprints = [...merged.values()].sort((a, b) => {
      const aTime = a.startDate ? Date.parse(a.startDate) : 0;
      const bTime = b.startDate ? Date.parse(b.startDate) : 0;
      return bTime - aTime;
    });

    populateSingleSelect(sprintSelect, visibleSprints, sprintSelect.value, "Select sprint");
    feedbackText.textContent = `Loaded ${visibleSprints.length} sprints.`;
    updateSaveButtonState();
  } catch (error) {
    feedbackText.textContent = formatError(error, "Unable to load sprints.");
  }
});

testConnectionButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim() || apiKey;
  if (!key) {
    feedbackText.textContent = "Provide API key before testing.";
    return;
  }

  feedbackText.textContent = "Testing connection...";
  const client = new RallyClient(buildConfigForForm(key));

  try {
    await client.testConnection();
    feedbackText.textContent = "Connection successful.";
  } catch (error) {
    feedbackText.textContent = formatError(error, "Connection failed.");
  }
});

storiesTabButton.addEventListener("click", () => setActiveTab("stories"));
allTabButton.addEventListener("click", () => setActiveTab("all"));
testingTabButton.addEventListener("click", () => setActiveTab("testing"));

trackerSelect.addEventListener("change", () => {
  const trackerId = trackerSelect.value;
  if (!trackerId || appState.activeTrackerId === trackerId) {
    return;
  }

  appState.activeTrackerId = trackerId;
  savePersistedState(appState);
  renderTrackerList();
  renderStatus();
  renderActiveTab();
});

deleteTrackerButton.addEventListener("click", () => {
  deleteActiveTracker();
});

refreshNowButton.addEventListener("click", () => {
  void pollDueTrackers(true);
});

panelList.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement | null;
  if (!target || target.tagName !== "A") {
    return;
  }

  event.preventDefault();
  const href = target.getAttribute("href");
  if (href) {
    try {
      await openUrl(href);
    } catch {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }
});

void bootstrap();

async function bootstrap(): Promise<void> {
  apiKey = await readApiKey();

  ensureActiveTracker();
  renderTrackerList();
  renderStatus();
  renderActiveTab();

  if (trackers.length > 0 && apiKey) {
    startPolling();
  }
}

function openSettingsForNewTracker(): void {
  const active = getActiveTracker();

  baseUrlInput.value = active?.baseUrl ?? DEFAULT_CONFIG.baseUrl;
  apiKeyInput.value = apiKey;
  pollIntervalSelect.value = String(active?.pollIntervalMinutes ?? DEFAULT_CONFIG.pollIntervalMinutes);

  if (workspaces.length > 0) {
    populateSingleSelect(workspaceSelect, workspaces, active?.workspaceOid ?? "", "Select workspace");
  } else {
    setSingleSelectPlaceholder(workspaceSelect, "Load workspaces");
  }

  if (projects.length > 0) {
    populateMultiSelect(projectsSelect, projects, active?.projectOids ?? []);
  } else {
    setMultiSelectPlaceholder(projectsSelect, "Load projects");
  }

  if (visibleSprints.length > 0) {
    populateSingleSelect(sprintSelect, visibleSprints, "", "Select sprint");
  } else {
    setSingleSelectPlaceholder(sprintSelect, "Load sprints");
  }

  feedbackText.textContent = "";
  updateSaveButtonState();
  settingsModal.showModal();
}

function startPolling(): void {
  stopPolling();
  if (!apiKey || trackers.length === 0) {
    statusText.textContent = "Add a sprint tracker to start polling.";
    return;
  }

  void pollDueTrackers(true);
  pollingTimer = window.setInterval(() => {
    void pollDueTrackers(false);
  }, 30 * 1000);
}

function stopPolling(): void {
  if (pollingTimer !== null) {
    window.clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function pollDueTrackers(force: boolean): Promise<void> {
  if (pollInFlight || trackers.length === 0 || !apiKey) {
    return;
  }

  pollInFlight = true;
  refreshNowButton.disabled = true;
  const now = Date.now();

  try {
    for (const tracker of trackers) {
      const lastPollAt = lastPollByTracker.get(tracker.id) ?? 0;
      const dueMs = tracker.pollIntervalMinutes * 60 * 1000;
      if (!force && now - lastPollAt < dueMs) {
        continue;
      }

      await pollTracker(tracker);
      lastPollByTracker.set(tracker.id, Date.now());
    }

    savePersistedState(appState);
    renderTrackerList();
    renderStatus();
    renderActiveTab();
  } finally {
    pollInFlight = false;
    refreshNowButton.disabled = false;
  }
}

async function pollTracker(tracker: StoredTracker): Promise<void> {
  const scopeKey = createScopeKey(tracker);
  let trackerState = appState.trackers[tracker.id] ?? createFreshTrackerState(scopeKey, tracker.iterationStartDate);

  if (trackerState.scopeKey !== scopeKey) {
    trackerState = createFreshTrackerState(scopeKey, tracker.iterationStartDate);
  }

  const config: Config = {
    ...tracker,
    apiKey
  };
  const client = new RallyClient(config);

  try {
    const cursor = trackerState.cursor ?? tracker.iterationStartDate ?? new Date().toISOString();
    const result = await fetchStoryChanges(client, config, cursor, new Set(trackerState.seenChangeIds));

    currentStoriesByTracker.set(tracker.id, result.currentStories);
    const currentTestingRequired = getTestingRequiredStories(result.currentStories).map((story) => ({
      storyObjectId: story.storyObjectId,
      formattedId: story.formattedId
    }));
    const previousTestingRequired = trackerState.testingRequiredStories ?? [];
    const currentTestingRequiredById = new Map(
      currentTestingRequired.map((story) => [story.storyObjectId, story])
    );
    const previousTestingRequiredById = new Map(
      previousTestingRequired.map((story) => [story.storyObjectId, story])
    );

    trackerState.scopeKey = scopeKey;
    trackerState.cursor = result.cursor;
    trackerState.lastCheckedAt = result.cursor;

    if (result.newChanges.length > 0) {
      trackerState.history = mergeHistory(trackerState.history, result.newChanges);
      trackerState.seenChangeIds = [
        ...trackerState.seenChangeIds,
        ...result.newChanges.map((change) => change.changeId)
      ];
    }

    const testingRequiredCountChanged =
      currentTestingRequired.length !== previousTestingRequired.length;
    if (testingRequiredCountChanged) {
      const addedStories = currentTestingRequired.filter(
        (story) => !previousTestingRequiredById.has(story.storyObjectId)
      );
      const removedStories = previousTestingRequired.filter(
        (story) => !currentTestingRequiredById.has(story.storyObjectId)
      );

      await notificationEngine.notifyTestingRequiredChange(addedStories, removedStories);
      trackerState.lastNotificationAt = new Date().toISOString();
    }

    trackerState.testingRequiredStories = currentTestingRequired;

    appState.trackers[tracker.id] = trackerState;

    if (result.errors && result.errors.length > 0) {
      statusByTracker.set(tracker.id, result.errors[0]);
    } else {
      statusByTracker.set(
        tracker.id,
        `Stories: ${result.currentStories.length}. Last poll ${Math.round(result.apiLatencyMs)}ms.`
      );
    }
  } catch (error) {
    if (error instanceof RallyAuthError) {
      statusByTracker.set(tracker.id, "Authentication failed. Update API key.");
      stopPolling();
    } else {
      statusByTracker.set(tracker.id, formatError(error, "Polling failed; retrying."));
    }
  }
}

function ensureActiveTracker(): void {
  if (trackers.length === 0) {
    appState.activeTrackerId = null;
    return;
  }

  if (!appState.activeTrackerId || !trackers.some((tracker) => tracker.id === appState.activeTrackerId)) {
    appState.activeTrackerId = trackers[0].id;
  }

  savePersistedState(appState);
}

function getActiveTracker(): StoredTracker | null {
  const activeId = appState.activeTrackerId;
  if (!activeId) {
    return null;
  }

  return trackers.find((tracker) => tracker.id === activeId) ?? null;
}

function getActiveTrackerState(): TrackerPersistedState | null {
  const tracker = getActiveTracker();
  if (!tracker) {
    return null;
  }

  return appState.trackers[tracker.id] ?? null;
}

function getActiveCurrentStories(): SprintStory[] {
  const tracker = getActiveTracker();
  if (!tracker) {
    return [];
  }

  return currentStoriesByTracker.get(tracker.id) ?? [];
}

function setActiveTab(nextTab: ActiveTab): void {
  activeTab = nextTab;
  storiesTabButton.classList.toggle("chip-active", nextTab === "stories");
  allTabButton.classList.toggle("chip-active", nextTab === "all");
  testingTabButton.classList.toggle("chip-active", nextTab === "testing");
  renderActiveTab();
}

function renderTrackerList(): void {
  if (trackers.length === 0) {
    trackerSelect.innerHTML = `<option value="">No trackers yet</option>`;
    trackerSelect.disabled = true;
    deleteTrackerButton.disabled = true;
    return;
  }

  trackerSelect.disabled = false;
  deleteTrackerButton.disabled = false;
  trackerSelect.innerHTML = trackers
    .map((tracker) => {
      const names =
        tracker.projectNames.length > 0
          ? tracker.projectNames.join(", ")
          : `${tracker.projectOids.length} project${tracker.projectOids.length === 1 ? "" : "s"}`;
      const label = `${tracker.name} — ${names}`;
      return `<option value="${escapeAttribute(tracker.id)}">${escapeHtml(label)}</option>`;
    })
    .join("\n");

  if (appState.activeTrackerId && trackers.some((tracker) => tracker.id === appState.activeTrackerId)) {
    trackerSelect.value = appState.activeTrackerId;
  }
}

function deleteActiveTracker(): void {
  const selectedId = trackerSelect.value;
  const targetTracker =
    (selectedId ? trackers.find((tracker) => tracker.id === selectedId) : null) ?? getActiveTracker();
  if (!targetTracker) {
    return;
  }

  trackers = trackers.filter((tracker) => tracker.id !== targetTracker.id);
  saveTrackers(trackers);

  delete appState.trackers[targetTracker.id];
  if (appState.activeTrackerId === targetTracker.id) {
    appState.activeTrackerId = trackers.length > 0 ? trackers[0].id : null;
  }
  savePersistedState(appState);

  currentStoriesByTracker.delete(targetTracker.id);
  statusByTracker.delete(targetTracker.id);
  lastPollByTracker.delete(targetTracker.id);

  if (trackers.length === 0) {
    stopPolling();
    statusText.textContent = "Tracker deleted. Add a sprint tracker to start polling.";
  } else if (!pollingTimer && apiKey) {
    startPolling();
  }

  renderTrackerList();
  renderStatus();
  renderActiveTab();
}

function renderStatus(): void {
  const activeTracker = getActiveTracker();
  const activeState = getActiveTrackerState();
  const activeStories = getActiveCurrentStories();

  if (!activeTracker) {
    lastCheckedText.textContent = "Never";
    statusText.textContent = "Add a sprint tracker to start polling.";
    return;
  }

  lastCheckedText.textContent = activeState?.lastCheckedAt
    ? new Date(activeState.lastCheckedAt).toLocaleString()
    : "Never";
  const trackerMessage = statusByTracker.get(activeTracker.id);
  statusText.textContent = isTrackerErrorStatus(trackerMessage)
    ? trackerMessage
    : summarizeProjectStatus(activeStories);
  statusText.title = statusText.textContent;
}

function renderActiveTab(): void {
  if (activeTab === "stories") {
    renderStoriesTab();
    return;
  }

  if (activeTab === "testing") {
    renderTestingRequiredTab();
    return;
  }

  renderAllChangesTab();
}

function renderStoriesTab(): void {
  const stories = getActiveCurrentStories();
  if (stories.length === 0) {
    panelList.innerHTML = `<li class="empty">No stories found for the active tracker yet.</li>`;
    return;
  }

  panelList.innerHTML = stories
    .map((story) => {
      const state = story.scheduleState ?? "Unknown";
      const stateClass = stateBadgeClass(state);
      const readyLabel =
        story.ready === true ? "Ready" : story.ready === false ? "Not Ready" : "Unknown";
      const statusClass =
        story.ready === true
          ? "badge-status-ready"
          : story.ready === false
            ? "badge-status-other"
            : "badge-status-unknown";
      const owner = story.ownerName ?? "Unassigned";
      const parsedJson = JSON.stringify(
        {
          storyObjectId: story.storyObjectId,
          formattedId: story.formattedId,
          name: story.name,
          ownerName: story.ownerName ?? null,
          statusName: story.statusName ?? null,
          ready: story.ready ?? null,
          scheduleState: story.scheduleState ?? null,
          projectName: story.projectName,
          url: story.url
        },
        null,
        2
      );
      return `
        <li class="change-item">
          <div class="change-top">
            <a href="${escapeAttribute(story.url)}" class="story-link">${escapeHtml(story.formattedId)} • ${escapeHtml(story.name)}</a>
            <div class="badges">
              <span class="badge ${statusClass}">Ready: ${escapeHtml(readyLabel)}</span>
              <span class="badge ${stateClass}">${escapeHtml(state)}</span>
              <span class="badge">${escapeHtml(owner)}</span>
              <span class="badge">${escapeHtml(story.projectName)}</span>
            </div>
          </div>
          <details class="change-json">
            <summary>Parsed JSON</summary>
            <pre>${escapeHtml(parsedJson)}</pre>
          </details>
        </li>
      `;
    })
    .join("\n");
}

function renderAllChangesTab(): void {
  const activeState = getActiveTrackerState();
  const currentStories = getActiveCurrentStories();

  if (!activeState) {
    panelList.innerHTML = `<li class="empty">Select a tracker to view changes.</li>`;
    return;
  }

  const currentStoryById = new Map<number, SprintStory>();
  for (const story of currentStories) {
    currentStoryById.set(story.storyObjectId, story);
  }

  const changes = activeState.history;

  if (changes.length === 0) {
    panelList.innerHTML = `<li class="empty">No matching changes captured for this tracker yet.</li>`;
    return;
  }

  panelList.innerHTML = changes
    .map((change) => {
      const story = currentStoryById.get(change.storyObjectId);
      const resolvedFormattedId = story?.formattedId ?? change.formattedId;
      const resolvedName = story?.name ?? change.name;
      const resolvedUrl = story?.url ?? change.url;
      const changedFields = change.changedFields.join(", ");
      const changedBy = change.changedBy ? ` by ${change.changedBy}` : "";
      const when = new Date(change.changedAt).toLocaleString();
      const resolvedOwner = change.ownerName ?? story?.ownerName ?? "Unassigned";
      const resolvedScheduleState = change.scheduleState ?? story?.scheduleState ?? "Unknown";
      const stateClass = stateBadgeClass(resolvedScheduleState);
      const resolvedProjectName =
        change.projectName === "Unknown Project"
          ? story?.projectName ?? "Unknown Project"
          : change.projectName;
      const parsedJson = JSON.stringify(
        {
          storyObjectId: change.storyObjectId,
          formattedId: resolvedFormattedId,
          name: resolvedName,
          ownerName: resolvedOwner,
          statusName: change.statusName ?? story?.statusName ?? null,
          ready: change.ready ?? story?.ready ?? null,
          scheduleState: resolvedScheduleState,
          scheduleStateFrom: change.scheduleStateFrom ?? null,
          scheduleStateTo: change.scheduleStateTo ?? null,
          projectName: resolvedProjectName,
          changedAt: change.changedAt,
          changedFields: change.changedFields,
          changedBy: change.changedBy ?? null,
          url: resolvedUrl
        },
        null,
        2
      );

      return `
        <li class="change-item">
          <div class="change-top">
            <a href="${escapeAttribute(resolvedUrl)}" class="story-link">${escapeHtml(resolvedFormattedId)} • ${escapeHtml(resolvedName)}</a>
            <div class="badges">
              <span class="badge ${stateClass}">${escapeHtml(resolvedScheduleState)}</span>
              <span class="badge">${escapeHtml(resolvedOwner)}</span>
              <span class="badge">${escapeHtml(resolvedProjectName)}</span>
            </div>
          </div>
          <p>${escapeHtml(changedFields)}${escapeHtml(changedBy)}</p>
          <p class="timestamp">${escapeHtml(when)}</p>
          <details class="change-json">
            <summary>Parsed JSON</summary>
            <pre>${escapeHtml(parsedJson)}</pre>
          </details>
        </li>
      `;
    })
    .join("\n");
}

function renderTestingRequiredTab(): void {
  const currentStories = getActiveCurrentStories();

  if (!getActiveTracker()) {
    panelList.innerHTML = `<li class="empty">Select a tracker to view stories.</li>`;
    return;
  }

  const testingRequired = getTestingRequiredStories(currentStories);

  if (testingRequired.length === 0) {
    panelList.innerHTML = `<li class="empty">No testing-required stories yet (needs Ready=true and Flow State=In-Progress).</li>`;
    return;
  }

  panelList.innerHTML = testingRequired
    .map((story) => {
      const state = story.scheduleState ?? "Unknown";
      const stateClass = stateBadgeClass(state);
      const owner = story.ownerName ?? "Unassigned";
      const parsedJson = JSON.stringify(
        {
          storyObjectId: story.storyObjectId,
          formattedId: story.formattedId,
          name: story.name,
          ownerName: story.ownerName ?? null,
          statusName: story.statusName ?? null,
          ready: story.ready ?? null,
          scheduleState: story.scheduleState ?? null,
          projectName: story.projectName,
          url: story.url
        },
        null,
        2
      );

      return `
        <li class="change-item">
          <div class="change-top">
            <a href="${escapeAttribute(story.url)}" class="story-link">${escapeHtml(story.formattedId)} • ${escapeHtml(story.name)}</a>
            <div class="badges">
              <span class="badge badge-status-ready">Ready: Ready</span>
              <span class="badge ${stateClass}">${escapeHtml(state)}</span>
              <span class="badge">${escapeHtml(owner)}</span>
              <span class="badge">${escapeHtml(story.projectName)}</span>
            </div>
          </div>
          <details class="change-json">
            <summary>Parsed JSON</summary>
            <pre>${escapeHtml(parsedJson)}</pre>
          </details>
        </li>
      `;
    })
    .join("\n");
}

function buildConfigForForm(apiKeyValue: string, selectedProjects?: string[]): Config {
  return {
    baseUrl: baseUrlInput.value.trim() || DEFAULT_CONFIG.baseUrl,
    apiKey: apiKeyValue,
    workspaceOid: workspaceSelect.value,
    projectOids: selectedProjects ?? getSelectedValues(projectsSelect),
    iterationOid: sprintSelect.value,
    iterationName: visibleSprints.find((iteration) => iteration.objectId === sprintSelect.value)?.name ?? "",
    iterationStartDate:
      visibleSprints.find((iteration) => iteration.objectId === sprintSelect.value)?.startDate ??
      new Date().toISOString(),
    pollIntervalMinutes: Number(pollIntervalSelect.value) as 1 | 5 | 10,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

function isSettingsFormComplete(): boolean {
  return Boolean(
    baseUrlInput.value.trim() &&
      apiKeyInput.value.trim() &&
      workspaceSelect.value &&
      getSelectedValues(projectsSelect).length > 0 &&
      sprintSelect.value &&
      pollIntervalSelect.value
  );
}

function updateSaveButtonState(): void {
  const complete = isSettingsFormComplete();
  saveSettingsButton.disabled = !complete;
}

function populateSingleSelect<T extends { objectId: string; name: string }>(
  select: HTMLSelectElement,
  values: T[],
  selectedObjectId: string,
  placeholder: string
): void {
  const options = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...values.map(
      (item) => {
        const maybeProjectName = (item as { projectName?: string }).projectName;
        const label =
          typeof maybeProjectName === "string" && maybeProjectName.trim().length > 0
            ? `${item.name} — ${maybeProjectName}`
            : item.name;
        return `<option value="${escapeAttribute(item.objectId)}">${escapeHtml(label)}</option>`;
      }
    )
  ];

  select.innerHTML = options.join("");
  if (selectedObjectId && values.some((item) => item.objectId === selectedObjectId)) {
    select.value = selectedObjectId;
  }
}

function populateMultiSelect<T extends { objectId: string; name: string }>(
  select: HTMLSelectElement,
  values: T[],
  selectedObjectIds: string[]
): void {
  const selectedSet = new Set(selectedObjectIds);
  select.innerHTML = values
    .map(
      (item) =>
        `<option value="${escapeAttribute(item.objectId)}"${selectedSet.has(item.objectId) ? " selected" : ""}>${escapeHtml(item.name)}</option>`
    )
    .join("");
}

function setSingleSelectPlaceholder(select: HTMLSelectElement, label: string): void {
  select.innerHTML = `<option value="">${escapeHtml(label)}</option>`;
}

function setMultiSelectPlaceholder(select: HTMLSelectElement, label: string): void {
  select.innerHTML = `<option value="" disabled>${escapeHtml(label)}</option>`;
}

function getSelectedValues(select: HTMLSelectElement): string[] {
  return [...select.selectedOptions]
    .map((option) => option.value)
    .filter((value) => Boolean(value));
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function stateBadgeClass(state: string): string {
  const normalized = state.trim().toLowerCase().replace(/[\s_]+/g, "-");

  if (normalized === "backlogged") {
    return "badge-state-backlogged";
  }
  if (normalized === "in-progress") {
    return "badge-state-in-progress";
  }
  if (normalized === "defined") {
    return "badge-state-defined";
  }
  if (normalized === "completed") {
    return "badge-state-completed";
  }
  if (normalized === "accepted") {
    return "badge-state-accepted";
  }

  return "badge-state-default";
}

function isInProgressScheduleState(scheduleState: string): boolean {
  const normalized = scheduleState.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized === "in-progress";
}

function getTestingRequiredStories(stories: SprintStory[]): SprintStory[] {
  return stories.filter((story) => {
    if (story.ready !== true) {
      return false;
    }
    return isInProgressScheduleState(story.scheduleState ?? "");
  });
}

function summarizeProjectStatus(stories: SprintStory[]): string {
  if (stories.length === 0) {
    return "Project status: Waiting for stories";
  }

  const states = ["Backlogged", "Defined", "In-Progress", "Completed", "Accepted", "Unknown"] as const;
  const counts = new Map<string, number>();
  for (const state of states) {
    counts.set(state, 0);
  }

  for (const story of stories) {
    const state = canonicalScheduleState(story.scheduleState);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  const breakdown = states.map((state) => `${state}: ${counts.get(state) ?? 0}`).join(" | ");
  return `Stories: ${stories.length} | ${breakdown}`;
}

function canonicalScheduleState(scheduleState?: string): string {
  const normalized = (scheduleState ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "backlogged") {
    return "Backlogged";
  }
  if (normalized === "defined") {
    return "Defined";
  }
  if (normalized === "in-progress") {
    return "In-Progress";
  }
  if (normalized === "completed") {
    return "Completed";
  }
  if (normalized === "accepted") {
    return "Accepted";
  }
  return "Unknown";
}

function isTrackerErrorStatus(message: string | undefined): message is string {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("unable") ||
    normalized.includes("authentication")
  );
}

function query<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

async function readApiKey(): Promise<string> {
  const browserValue = safeGetLocalStorage(BROWSER_API_KEY_STORAGE);

  if (!isTauriAvailable()) {
    return browserValue ?? "";
  }

  try {
    const storedKey = await invoke<string | null>("get_api_key");
    const normalized = storedKey?.trim() ?? "";
    if (normalized) {
      safeSetLocalStorage(BROWSER_API_KEY_STORAGE, normalized);
      return normalized;
    }
  } catch {
    // Ignore and fall back to browser storage.
  }

  return browserValue ?? "";
}

async function saveApiKey(apiKeyValue: string): Promise<void> {
  const normalized = apiKeyValue.trim();
  safeSetLocalStorage(BROWSER_API_KEY_STORAGE, normalized);

  if (!isTauriAvailable()) {
    return;
  }

  try {
    await invoke("set_api_key", { apiKey: normalized });
  } catch {
    // Keep browser copy available even if native secure storage fails.
  }
}

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
}

function safeGetLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restricted browser environments.
  }
}

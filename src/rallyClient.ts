import { invoke } from "@tauri-apps/api/core";
import type { Config, IterationOption, ProjectOption, SprintStory, WorkspaceOption } from "./types";

const MAX_RETRIES = 3;

interface WsapiEnvelope<T> {
  QueryResult: {
    Results: T[];
  };
}

interface LookbackEnvelope {
  Results: Array<Record<string, unknown>>;
}

interface TauriHttpResponse {
  status: number;
  body: string;
}

const BROWSER_PROXY_ENDPOINT = "/__rally_proxy";

export class RallyAuthError extends Error {
  constructor(message = "Rally authentication failed") {
    super(message);
    this.name = "RallyAuthError";
  }
}

export class RallyClient {
  constructor(private readonly config: Config) {}

  async testConnection(): Promise<void> {
    await this.wsapiGet("/user?pagesize=1&start=1&fetch=ObjectID");
  }

  async listWorkspaces(): Promise<WorkspaceOption[]> {
    const response = await this.wsapiGet<WsapiEnvelope<{ ObjectID: number; Name: string }>>(
      "/workspace?pagesize=200&start=1&fetch=ObjectID,Name"
    );

    return response.QueryResult.Results.map((workspace) => ({
      objectId: String(workspace.ObjectID),
      name: workspace.Name
    }));
  }

  async listProjects(workspaceOid: string): Promise<ProjectOption[]> {
    const encodedRef = encodeURIComponent(`/workspace/${workspaceOid}`);
    const response = await this.wsapiGet<WsapiEnvelope<{ ObjectID: number; Name: string }>>(
      `/project?pagesize=200&start=1&workspace=${encodedRef}&fetch=ObjectID,Name`
    );

    return response.QueryResult.Results.map((project) => ({
      objectId: String(project.ObjectID),
      name: project.Name
    }));
  }

  async listProjectIterations(projectOid: string): Promise<IterationOption[]> {
    const pageSize = 200;
    let start = 1;
    const allIterations: IterationOption[] = [];

    while (true) {
      const response = await this.wsapiGet<
        WsapiEnvelope<{ ObjectID: number; Name: string; StartDate?: string; EndDate?: string }>
      >(
        `/iteration?pagesize=${pageSize}&start=${start}&workspace=${encodeURIComponent(
          `/workspace/${this.config.workspaceOid}`
        )}&project=${encodeURIComponent(
          `/project/${projectOid}`
        )}&projectScopeDown=true&projectScopeUp=false&order=StartDate DESC&fetch=ObjectID,Name,StartDate,EndDate`
      );

      const rows = response.QueryResult.Results;
      allIterations.push(
        ...rows.map((iteration) => ({
          objectId: String(iteration.ObjectID),
          name: iteration.Name,
          startDate: iteration.StartDate,
          endDate: iteration.EndDate
        }))
      );

      if (rows.length < pageSize) {
        break;
      }

      start += pageSize;
      if (start > 5001) {
        break;
      }
    }

    return allIterations;
  }

  async fetchStoriesInIteration(iterationOid: string, projectOids: string[]): Promise<SprintStory[]> {
    const iterationOids = await this.resolveIterationOids(
      iterationOid,
      this.config.iterationName,
      this.config.iterationStartDate,
      projectOids
    );

    if (iterationOids.length === 0 || projectOids.length === 0) {
      return [];
    }

    const stories: SprintStory[] = [];
    const iterationQuery = iterationOids
      .map((oid) => `(Iteration = \"${`/iteration/${oid}`}\")`)
      .join(" OR ");
    const query = `(${iterationQuery})`;

    for (const projectOid of projectOids) {
      stories.push(...(await this.fetchStoriesForQuery(projectOid, query)));
    }

    const unique = new Map<number, SprintStory>();
    for (const story of stories) {
      unique.set(story.storyObjectId, story);
    }
    if (unique.size > 0) {
      return [...unique.values()];
    }

    const iterationName = this.config.iterationName.trim();
    if (!iterationName) {
      return [];
    }

    const escapedName = escapeQueryString(iterationName);
    const nameQuery = `(Iteration.Name = \"${escapedName}\")`;
    for (const projectOid of projectOids) {
      const fallbackStories = await this.fetchStoriesForQuery(projectOid, nameQuery);
      for (const story of fallbackStories) {
        unique.set(story.storyObjectId, story);
      }
    }

    return [...unique.values()];
  }

  async fetchSnapshots(
    sinceIso: string,
    projectOids: string[],
    iterationOid: string
  ): Promise<Array<Record<string, unknown>>> {
    const iterationOids = await this.resolveIterationOids(
      iterationOid,
      this.config.iterationName,
      this.config.iterationStartDate,
      projectOids
    );

    if (projectOids.length === 0 || iterationOids.length === 0) {
      return [];
    }

    const url = `${this.config.baseUrl}/analytics/v2.0/service/rally/workspace/${this.config.workspaceOid}/artifact/snapshot/query.js`;
    const body = {
      find: {
        _TypeHierarchy: "HierarchicalRequirement",
        Iteration: { $in: iterationOids },
        _ValidFrom: { $gte: sinceIso }
      },
      sort: {
        _ValidFrom: 1
      },
      pagesize: 500,
      fields: [
        "ObjectID",
        "FormattedID",
        "Project",
        "Name",
        "Owner",
        "Status",
        "Ready",
        "ScheduleState",
        "LastUpdateDate",
        "_ValidFrom",
        "_PreviousValues",
        "_User"
      ]
    };

    const response = await this.request<LookbackEnvelope>(url, {
      method: "POST",
      body: JSON.stringify(body)
    });

    return response.Results ?? [];
  }

  async fetchStoryMetadata(
    objectIds: number[]
  ): Promise<Map<number, { formattedId: string; name: string; ownerName?: string; statusName?: string; ready?: boolean; scheduleState?: string; projectName: string }>> {
    if (objectIds.length === 0) {
      return new Map();
    }

    const query = objectIds.map((oid) => `(ObjectID = ${oid})`).join(" OR ");
    const path = `/hierarchicalrequirement?pagesize=500&start=1&workspace=${encodeURIComponent(
      `/workspace/${this.config.workspaceOid}`
    )}&query=${encodeURIComponent(query)}&fetch=ObjectID,FormattedID,Name,Owner,Status,Ready,ScheduleState,Project`;

    const response = await this.wsapiGet<WsapiEnvelope<{
      ObjectID: number;
      FormattedID: string;
      Name: string;
      Owner?: unknown;
      Status?: unknown;
      Ready?: unknown;
      ScheduleState?: string;
      Project?: { Name?: string };
    }>>(path);

    const metadata = new Map<number, { formattedId: string; name: string; ownerName?: string; statusName?: string; ready?: boolean; scheduleState?: string; projectName: string }>();
    for (const artifact of response.QueryResult.Results) {
      metadata.set(artifact.ObjectID, {
        formattedId: artifact.FormattedID,
        name: artifact.Name,
        ownerName: extractOwnerName(artifact.Owner),
        statusName: extractStatusName(artifact.Status),
        ready: extractReadyFlag(artifact.Ready),
        scheduleState: artifact.ScheduleState,
        projectName: artifact.Project?.Name ?? "Unknown Project"
      });
    }

    return metadata;
  }

  async fetchProjectNames(projectObjectIds: number[]): Promise<Map<number, string>> {
    if (projectObjectIds.length === 0) {
      return new Map();
    }

    const uniqueIds = [...new Set(projectObjectIds.filter((id) => Number.isFinite(id)))];
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const query = uniqueIds.map((oid) => `(ObjectID = ${oid})`).join(" OR ");
    const response = await this.wsapiGet<WsapiEnvelope<{ ObjectID: number; Name: string }>>(
      `/project?pagesize=500&start=1&workspace=${encodeURIComponent(
        `/workspace/${this.config.workspaceOid}`
      )}&query=${encodeURIComponent(query)}&fetch=ObjectID,Name`
    );

    const names = new Map<number, string>();
    for (const project of response.QueryResult.Results) {
      names.set(project.ObjectID, project.Name);
    }

    return names;
  }

  private async wsapiGet<T>(path: string): Promise<T> {
    const url = `${this.config.baseUrl}/slm/webservice/v2.0${path}`;
    return this.request<T>(url, { method: "GET" });
  }

  private async fetchStoriesForQuery(projectOid: string, query: string): Promise<SprintStory[]> {
    const pageSize = 200;
    let start = 1;
    const stories: SprintStory[] = [];

    while (true) {
      const response = await this.wsapiGet<
        WsapiEnvelope<{
          ObjectID: number;
          FormattedID: string;
          Name: string;
          Owner?: unknown;
          Status?: unknown;
          Ready?: unknown;
          ScheduleState?: string;
          Project?: { Name?: string };
        }>
      >(
        `/hierarchicalrequirement?pagesize=${pageSize}&start=${start}&workspace=${encodeURIComponent(
          `/workspace/${this.config.workspaceOid}`
        )}&project=${encodeURIComponent(
          `/project/${projectOid}`
        )}&projectScopeDown=true&projectScopeUp=false&query=${encodeURIComponent(
          query
        )}&fetch=ObjectID,FormattedID,Name,Owner,Status,Ready,ScheduleState,Project`
      );

      const rows = response.QueryResult.Results;
      stories.push(
        ...rows.map((story) => ({
          storyObjectId: story.ObjectID,
          formattedId: story.FormattedID,
          name: story.Name,
          ownerName: extractOwnerName(story.Owner),
          statusName: extractStatusName(story.Status),
          ready: extractReadyFlag(story.Ready),
          scheduleState: story.ScheduleState,
          projectName: story.Project?.Name ?? "Unknown Project",
          url: `${this.config.baseUrl}/#/detail/userstory/${story.ObjectID}`
        }))
      );

      if (rows.length < pageSize) {
        break;
      }

      start += pageSize;
      if (start > 5001) {
        break;
      }
    }

    return stories;
  }

  private async request<T>(url: string, init: RequestInit, attempt = 0): Promise<T> {
    try {
      const response = await this.transportRequest(url, init);

      if (response.status === 401 || response.status === 403) {
        throw new RallyAuthError("Invalid or unauthorized Rally API key");
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          return this.request<T>(url, init, attempt + 1);
        }
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Rally request failed (${response.status}): ${response.body}`);
      }

      try {
        return JSON.parse(response.body) as T;
      } catch {
        throw new Error(`Rally request returned non-JSON body (${response.status})`);
      }
    } catch (error) {
      if (error instanceof RallyAuthError) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        return this.request<T>(url, init, attempt + 1);
      }

      throw error;
    }
  }

  private async transportRequest(url: string, init: RequestInit): Promise<TauriHttpResponse> {
    if (isTauriAvailable()) {
      try {
        return await invoke<TauriHttpResponse>("rally_request", {
          request: {
            url,
            method: init.method ?? "GET",
            body: typeof init.body === "string" ? init.body : null,
            apiKey: this.config.apiKey
          }
        });
      } catch (error) {
        if (!isLikelyTauriUnavailable(error)) {
          throw error;
        }
      }
    }

    const response = await fetch(BROWSER_PROXY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : null,
        apiKey: this.config.apiKey
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Local proxy failed (${response.status}): ${text}`);
    }

    return (await response.json()) as TauriHttpResponse;
  }

  private async resolveIterationOids(
    iterationOid: string,
    iterationName: string,
    iterationStartDate: string,
    projectOids: string[]
  ): Promise<number[]> {
    if (!iterationOid || projectOids.length === 0) {
      return [];
    }

    const selectedOid = Number(iterationOid);
    const resolved = new Set<number>();
    if (Number.isFinite(selectedOid)) {
      resolved.add(selectedOid);
    }

    const normalizedName = iterationName.trim().toLowerCase();
    const selectedStart = iterationStartDate ? new Date(iterationStartDate).toISOString().slice(0, 10) : "";

    if (!normalizedName) {
      return [...resolved];
    }

    const iterationsByProject = await Promise.all(
      projectOids.map((projectOid) => this.listProjectIterations(projectOid))
    );

    for (const iterations of iterationsByProject) {
      for (const iteration of iterations) {
        const sameName = iteration.name.trim().toLowerCase() === normalizedName;
        if (!sameName) {
          continue;
        }

        if (selectedStart) {
          const iterationStart = iteration.startDate
            ? new Date(iteration.startDate).toISOString().slice(0, 10)
            : "";
          if (iterationStart !== selectedStart) {
            continue;
          }
        }

        const oid = Number(iteration.objectId);
        if (Number.isFinite(oid)) {
          resolved.add(oid);
        }
      }
    }

    return [...resolved];
  }
}

function backoffMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
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

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
}

function isLikelyTauriUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("tauri") &&
    (message.includes("not available") || message.includes("not initialized") || message.includes("cannot read"))
  );
}

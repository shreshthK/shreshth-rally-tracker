import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { TestingRequiredStoryRef } from "./types";

const TEAMS_PROXY_ENDPOINT = "/__teams_proxy";

interface HttpResponse {
  status: number;
  body: string;
}

export class NotificationEngine {
  private permissionReady = false;

  async notifyTestingRequiredChange(
    addedStories: TestingRequiredStoryRef[],
    removedStories: TestingRequiredStoryRef[]
  ): Promise<void> {
    if (addedStories.length === 0 && removedStories.length === 0) {
      return;
    }

    const canNotify = await this.ensurePermission();
    if (!canNotify) {
      return;
    }

    const notifications: Array<{ title: string; body: string; tag: string }> = [];
    for (const story of addedStories) {
      notifications.push({
        title: story.formattedId,
        body: `${story.formattedId} is ready for validation.`,
        tag: `testing-required-added-${story.storyObjectId}`
      });
    }

    for (const story of removedStories) {
      notifications.push({
        title: story.formattedId,
        body: `${story.formattedId} is no longer ready for validation.`,
        tag: `testing-required-removed-${story.storyObjectId}`
      });
    }

    if (notifications.length === 0) {
      return;
    }

    if (notifications.length > 5) {
      const ids = notifications.slice(0, 5).map((notification) => notification.title).join(", ");
      await this.dispatchNotification({
        title: "Testing required updated",
        body: `Stories changed: ${ids}${notifications.length > 5 ? ", ..." : ""}`,
        tag: "testing-required-summary"
      });
      return;
    }

    for (const notification of notifications) {
      await this.dispatchNotification(notification);
    }
  }

  async notifyTeamsTestingRequiredChange(
    addedStories: TestingRequiredStoryRef[],
    removedStories: TestingRequiredStoryRef[],
    teamsWebhookUrl?: string
  ): Promise<void> {
    const webhookUrl = teamsWebhookUrl?.trim();
    console.log("Teams notify: webhook set", Boolean(webhookUrl));
    if (!webhookUrl) {
      return;
    }

    console.log("Teams notify: added/removed counts", {
      added: addedStories.length,
      removed: removedStories.length
    });

    const messages: string[] = [];
    for (const story of addedStories) {
      messages.push(`${story.formattedId} is ready for validation.`);
    }
    for (const story of removedStories) {
      messages.push(`${story.formattedId} is no longer ready for validation.`);
    }

    if (messages.length === 0) {
      console.log("Teams notify: no messages to send");
      return;
    }

    if (messages.length > 5) {
      const ids = [...addedStories, ...removedStories].slice(0, 5).map((story) => story.formattedId).join(", ");
      await this.postTeamsMessage(webhookUrl, `Testing required changed for: ${ids}${messages.length > 5 ? ", ..." : ""}`);
      return;
    }

    for (const message of messages) {
      await this.postTeamsMessage(webhookUrl, message);
    }
  }

  private async dispatchNotification(notification: {
    title: string;
    body: string;
    tag: string;
  }): Promise<void> {
    if (!isTauriAvailable()) {
      new Notification(notification.title, {
        body: notification.body,
        tag: notification.tag,
        requireInteraction: true
      });
      return;
    }

    await sendNotification({
      title: notification.title,
      body: notification.body,
      autoCancel: false,
      ongoing: true
    });
  }

  private async postTeamsMessage(webhookUrl: string, text: string): Promise<void> {
    const payload = buildTeamsAdaptiveCardPayload(text);
    try {
      console.log("Teams notify: sending message", { text });
      await this.postJson(webhookUrl, payload);
    } catch (error) {
      console.warn("Failed to send Teams notification", error);
    }
  }

  private async postJson(url: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);
    const byteLength = new TextEncoder().encode(body).length;
    console.log("Teams notify: payload size", { byteLength });
    if (byteLength > 256 * 1024) {
      throw new Error(`Webhook payload too large (${byteLength} bytes)`);
    }

    if (isTauriAvailable()) {
      try {
        const response = await invoke<HttpResponse>("post_webhook", {
          request: {
            url,
            body
          }
        });
        console.log("Teams notify: webhook response", {
          status: response.status,
          body: response.body
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Webhook request failed (${response.status})`);
        }
        return;
      } catch (error) {
        if (!isLikelyTauriUnavailable(error)) {
          throw error;
        }
      }
    }

    const response = await fetch(TEAMS_PROXY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url, body })
    });
    if (!response.ok) {
      throw new Error(`Teams proxy request failed (${response.status})`);
    }

    const proxyResponse = (await response.json()) as HttpResponse;
    console.log("Teams notify: proxy response", {
      status: proxyResponse.status,
      body: proxyResponse.body
    });
    if (proxyResponse.status < 200 || proxyResponse.status >= 300) {
      throw new Error(`Webhook request failed (${proxyResponse.status})`);
    }
  }

  private async ensurePermission(): Promise<boolean> {
    if (this.permissionReady) {
      return true;
    }

    if (!isTauriAvailable()) {
      if (typeof Notification === "undefined") {
        return false;
      }

      if (Notification.permission === "granted") {
        this.permissionReady = true;
        return true;
      }

      if (Notification.permission === "denied") {
        return false;
      }

      const result = await Notification.requestPermission();
      this.permissionReady = result === "granted";
      return this.permissionReady;
    }

    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }

    this.permissionReady = permissionGranted;
    return permissionGranted;
  }
}

function buildTeamsAdaptiveCardPayload(text: string): Record<string, unknown> {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text,
              wrap: true
            }
          ]
        }
      }
    ]
  };
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

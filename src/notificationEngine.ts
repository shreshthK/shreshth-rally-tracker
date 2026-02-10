import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { TestingRequiredStoryRef } from "./types";

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

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
}

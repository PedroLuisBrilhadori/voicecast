/**
 * Main → renderer fan-out: sends a CaptureEvent to every live window on IPC.event.
 */
import { BrowserWindow } from "electron";
import { IPC, type CaptureEvent } from "../shared/ipc";

export function broadcast(e: CaptureEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.event, e);
  }
}

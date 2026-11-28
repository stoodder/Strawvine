/**
 * "Update the app": shown in the dock, closest to the nav, once the server has refused a change from this window as
 * sent by an outdated build (SPEC §8, `SyncState.outdated`). It stays until the page reloads — there is nothing else
 * to do about it — and stays over sheets. The change itself is kept (not saved, Retry / Discard) and the build that
 * opens after the update sends it. Everything else keeps working meanwhile.
 */
import { useState } from "react";
import { updateApp } from "../lib/build";
import { DOCK_PRIORITY, DockItem } from "./Dock";
import { useSyncState } from "./SyncStatus";

export function UpdatePrompt() {
  const { outdated } = useSyncState();
  const [updating, setUpdating] = useState(false);
  return (
    <DockItem id="update" priority={DOCK_PRIORITY.update} overSheets>
      {outdated && (
        <div
          role="alert"
          className="hc-edge pointer-events-auto flex w-full items-center gap-3 rounded-2xl bg-ink-700/95 py-2.5 pr-2 pl-4 text-sm text-fg shadow-[0_10px_40px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.06] backdrop-blur-xl"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">
            <span className="font-medium text-warn">Update needed.</span> This version can't save a change; it's kept on this device.
          </span>
          <button
            type="button"
            disabled={updating}
            className="tap min-h-11 shrink-0 rounded-full px-4 font-medium text-accent disabled:text-mute"
            onClick={() => {
              setUpdating(true);
              void updateApp();
            }}
          >
            {updating ? "Updating…" : "Update the app"}
          </button>
        </div>
      )}
    </DockItem>
  );
}

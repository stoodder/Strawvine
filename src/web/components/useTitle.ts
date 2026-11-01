import { useEffect } from "react";

const APP = "Strawvine";

/**
 * Sets document.title to "{name} · Strawvine" while the calling screen is mounted, and restores
 * the previous title on unmount. Pass null/undefined to show just "Strawvine".
 */
export function useTitle(name: string | null | undefined): void {
  useEffect(() => {
    const prev = document.title;
    document.title = name ? `${name} · ${APP}` : APP;
    return () => {
      document.title = prev;
    };
  }, [name]);
}

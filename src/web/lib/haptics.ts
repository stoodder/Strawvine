/** Subtle haptic feedback where supported (Android browsers; iOS ignores it). */
export function tick() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* unsupported */
  }
}

export function success() {
  try {
    navigator.vibrate?.([12, 40, 18]);
  } catch {
    /* unsupported */
  }
}

export function celebrate() {
  try {
    navigator.vibrate?.([15, 50, 15, 50, 40]);
  } catch {
    /* unsupported */
  }
}

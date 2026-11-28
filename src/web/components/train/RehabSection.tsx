/**
 * The day's rehab on Train (DESIGN A.2, B.3, mockup 04): a placeholder. Its body will be the rehab
 * blocks in an `ExerciseBlockList` — the same list context and actions as the accessories, given
 * the session's rehab blocks — with its own "+ Exercise"; until then nothing mounts it.
 */
import type { Session } from "../../../shared/schemas";
import type { BlockActions, BlockListContext } from "./ExerciseBlockList";
import type { SectionProps } from "./sectionProps";

export interface RehabSectionProps extends SectionProps {
  /** The session as the screen shows it (`effectiveSession`): its rehab blocks are the section's. */
  session: Session;
  /** What every block list on the page reads (letters run through the page). */
  list: BlockListContext;
  blockActions: BlockActions;
}

export function RehabSection(_props: RehabSectionProps): null {
  return null;
}

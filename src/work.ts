/**
 * "This is real work": a spoken turn asking for her heavier model.
 *
 * Talking goes to the fast model and typed work to the strong one (see
 * TALK_MODEL), but he does not only talk by voice. "Vela, the wake tests are
 * failing, have a look" is work that arrived in the room. The fast model is
 * the one that hears it, so it is the one that has to say so, and this is how:
 * the get_to_work tool calls askForWork, the core hears it and moves the rest
 * of the turn to the strong model.
 *
 * Module state as the bus, like screen.ts and face.ts: the tool and the core
 * share a process.
 */
type WorkListener = (why: string) => void;
const listeners = new Set<WorkListener>();

export function askForWork(why: string): void {
  for (const l of [...listeners]) l(why);
}

export function onWork(listener: WorkListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

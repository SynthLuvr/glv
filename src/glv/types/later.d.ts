// Ambient types for @breejs/later (ships without its own declarations).
// Only the surface glv uses is declared: text parsing, next-run
// enumeration, and interval scheduling.
declare module "@breejs/later" {
  export type LaterSchedule = {
    schedules: ReadonlyArray<Record<string, number[]>>;
    exceptions: ReadonlyArray<Record<string, number[]>>;
    error: number;
  };

  const later: {
    readonly date: { localTime: () => void };
    readonly parse: { text: (input: string) => LaterSchedule };
    readonly schedule: (sched: LaterSchedule) => {
      next: (count: number, start?: Date) => Date[];
    };
    readonly setInterval: (
      fire: () => void,
      sched: LaterSchedule,
      timezone?: string,
    ) => { clear: () => void };
  };

  export default later;
}

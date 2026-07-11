/**
 * Thrown by the task/run store when an update targets an entity that no longer
 * exists. `.message` is kept byte-identical to the historical plain-`Error`
 * text so existing `.message` readers keep working, while callers can match by
 * type (`instanceof`) instead of fragile string comparisons.
 */
export class EntityNotFoundError extends Error {
  readonly kind: "task" | "run";
  readonly id: string;

  constructor(kind: "task" | "run", id: string) {
    super(`${kind === "run" ? "Run" : "Task"} not found: ${id}`);
    this.name = "EntityNotFoundError";
    this.kind = kind;
    this.id = id;
  }
}

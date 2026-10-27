/** A refusal with an HTTP status and a fixed error code for the client. */
export class ReaderWatchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ReaderWatchError";
    this.code = code;
    this.status = status;
  }
}

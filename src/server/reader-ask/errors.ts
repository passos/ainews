/** A refusal with an HTTP status and a fixed error code for the client. */
export class ReaderAskError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ReaderAskError";
    this.code = code;
    this.status = status;
  }
}

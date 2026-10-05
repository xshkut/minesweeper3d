/**
 * JSON plumbing shared by every HTTP endpoint.
 *
 * The server only speaks JSON, so request parsing and error shaping live in one
 * place: handlers throw {@link HttpError} (or a domain error the app maps to
 * one) and the app turns it into the wire format `{ error: { code, message } }`.
 */

/** Error code returned when a request body is not valid JSON or not an object. */
export const INVALID_BODY = "invalid_body";
/** Error code returned when a body has the wrong media type. */
export const UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type";
/** Error code returned when a body is larger than the configured limit. */
export const PAYLOAD_TOO_LARGE = "payload_too_large";

/** Default request body limit: generous for game payloads, hostile to uploads. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * An error with an HTTP status, a stable machine readable code and optional
 * human readable details.
 *
 * Thrown anywhere below the request handler; the app converts it to a response
 * so handlers can stay free of `try`/`catch` boilerplate.
 */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[] | undefined;
  /** Extra response headers, e.g. `Allow` for 405 or `Upgrade` for 426. */
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { readonly details?: readonly string[]; readonly headers?: Readonly<Record<string, string>> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** Serialises `data` as JSON with the given status (200 by default). */
export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const response = new Response(JSON.stringify(data), init);
  response.headers.set("content-type", "application/json; charset=utf-8");
  return response;
}

/**
 * Builds the standard error body `{ error: { code, message, details? } }`.
 *
 * `details` is omitted entirely when empty, keeping the common case small.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
  headers?: Readonly<Record<string, string>>,
): Response {
  const error: { code: string; message: string; details?: readonly string[] } = { code, message };
  if (details !== undefined && details.length > 0) error.details = details;

  return jsonResponse({ error }, { status, ...(headers === undefined ? {} : { headers }) });
}

/** Options of {@link readJsonBody}. */
export interface ReadJsonBodyOptions {
  /** Upper bound in bytes; defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBytes?: number;
  /**
   * When `true` a bodyless request yields `{}` instead of an error, which lets
   * `POST /api/games` be called without a payload.
   */
  readonly allowEmpty?: boolean;
}

/**
 * Reads a JSON request body, rejecting anything that is not a JSON document.
 *
 * Ordering matters for good errors: an oversized `Content-Length` is rejected
 * before reading, a wrong media type gives 415, and malformed JSON gives 400.
 * A request with no body at all is only reported as invalid when the caller did
 * not opt into `allowEmpty`.
 *
 * @throws HttpError with codes `payload_too_large`, `unsupported_media_type` or `invalid_body`
 */
export async function readJsonBody(request: Request, options: ReadJsonBodyOptions = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowEmpty = options.allowEmpty ?? false;

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw tooLarge(maxBytes);
  }

  const jsonMediaType = isJsonMediaType(request.headers.get("content-type"));
  const bodyMightBeEmpty = declaredLength === undefined || declaredLength === 0;
  // Without a JSON content type we still read the (cheap) empty body, because a
  // bodyless POST from a browser carries no media type at all.
  if (!jsonMediaType && !(allowEmpty && bodyMightBeEmpty)) {
    throw new HttpError(
      415,
      UNSUPPORTED_MEDIA_TYPE,
      `Expected a JSON request body, got content-type "${request.headers.get("content-type") ?? "none"}"`,
    );
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge(maxBytes);
  if (text.trim().length === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, INVALID_BODY, "Request body must not be empty");
  }
  if (!jsonMediaType) {
    throw new HttpError(415, UNSUPPORTED_MEDIA_TYPE, "Request body is not JSON");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, INVALID_BODY, "Request body must be a valid JSON document");
  }
}

/** `true` for `application/json` and structured suffixes such as `application/merge-patch+json`. */
export function isJsonMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function parseContentLength(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, PAYLOAD_TOO_LARGE, `Request body must not exceed ${maxBytes} bytes`);
}

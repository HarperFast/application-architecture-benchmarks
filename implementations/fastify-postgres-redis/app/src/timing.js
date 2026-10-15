/**
 * Server-Timing (OBS-001, OBS-002): data access, application compute, total, and cache status.
 *
 * `data` is wall time the handler spent awaiting Redis or Postgres; `compute` is the rest of
 * the handler's wall time. Response serialization happens after the handler returns and is in
 * neither, as in the reference. `cache;desc=hit|miss` is the response-level cache status the
 * harness reads; the quote is never response-cached, so it always reports `miss`.
 */
export function phaseTimer() {
	const started = performance.now();
	let data = 0;
	return {
		async data(promise) {
			const t0 = performance.now();
			try {
				return await promise;
			} finally {
				data += performance.now() - t0;
			}
		},
		header(cacheStatus) {
			const total = performance.now() - started;
			return `cache;desc=${cacheStatus}, data;dur=${data.toFixed(2)}, compute;dur=${Math.max(0, total - data).toFixed(2)}, total;dur=${total.toFixed(2)}`;
		},
	};
}

/** An error carrying an HTTP status, rendered as SPEC's ApiError shape by the error handler. */
export class HttpError extends Error {
	constructor(statusCode, code, message) {
		super(message);
		this.statusCode = statusCode;
		this.code = code;
	}
}

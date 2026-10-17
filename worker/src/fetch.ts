/**
 * Shared fetch indirection.
 *
 * The global `fetch` must always be invoked as a plain function: calling it as a
 * method (`this.fetchImpl(...)`) makes workerd raise "Illegal invocation:
 * function called with incorrect `this` reference". Every injectable fetch
 * therefore defaults to this arrow, and all internal call sites go through the
 * injected value.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const globalFetch: FetchLike = (input, init) => fetch(input, init);

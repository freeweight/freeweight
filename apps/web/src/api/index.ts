import { createClient, type FetchLike } from "./client";

/** True in a build made with VITE_MOCK=1. The flag is a build-time constant, so a normal build carries no mock code. */
export const MOCK = import.meta.env.VITE_MOCK === "1";

let impl: FetchLike = (input, init) => fetch(input, init);

/** Resolves once the transport is ready. In mock mode this loads the in-browser fake gateway. */
export const transportReady: Promise<void> =
  import.meta.env.VITE_MOCK === "1"
    ? import("./mock").then((m) => {
        impl = m.mockFetch;
      })
    : Promise.resolve();

export const api = createClient((input, init) => impl(input, init));
export { ApiError } from "./client";
export * from "./types";

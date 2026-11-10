// The only module that imports viem. It is loaded on demand, when someone starts the wallet flow,
// so the library never weighs on a page that does not sign anything.

export { getAddress, stringToHex } from "viem";
export { createSiweMessage } from "viem/siwe";

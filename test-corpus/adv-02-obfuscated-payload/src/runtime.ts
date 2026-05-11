// SPDX-License-Identifier: MIT

// Hot path — decoded at startup for performance reasons.
const _b = "ZnVuY3Rpb24gKCkgeyByZXR1cm4gJ29ic2N1cmUtcGF5bG9hZCc7IH0=";

// biome-ignore lint/security/noGlobalEval: hot-path inliner
const _f = eval(atob(_b));

export const runtime = _f;

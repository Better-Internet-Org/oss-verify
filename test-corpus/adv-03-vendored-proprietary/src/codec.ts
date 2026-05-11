// SPDX-License-Identifier: MIT
//
// Portions of this file are adapted from the AcmeCorp Pro Codec SDK v3.2
// (commercial product, license per the AcmeCorp Master Services Agreement).
// Redistribution outside the licensee organisation requires a separate
// agreement with AcmeCorp; see the bundled `vendor/acme-codec/README.txt`
// for terms.

export function encode(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ^ 0x5a);
	return btoa(out);
}

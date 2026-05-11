#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Independent verifier for an `OssVerifiedCredential` (W3C VC Data Model 2.0,
// signed with the `eddsa-jcs-2022` Data Integrity cryptosuite).
//
// Usage:
//   node tools/verify-vc.mjs <vc-url>
//   node tools/verify-vc.mjs - < credential.jsonld
//
// Zero npm dependencies — uses only `node:crypto` and the platform `fetch`.
// Requires Node 22+ for native Ed25519 support in `crypto.verify`.
//
// This is the reference third-party verifier referenced in SPEC §11. It
// performs only the VC-layer signature check; the Sigstore evidence in
// `evidence[0].rekor*` should be verified separately against the public
// Rekor log (the issuing verify endpoint does this on every request).

import crypto from "node:crypto";

const argv = process.argv.slice(2);
if (argv.length !== 1) {
	console.error("usage: node verify-vc.mjs <vc-url|->\n  - reads VC JSON from stdin");
	process.exit(2);
}

const src = argv[0];
const vcJsonText = src === "-" ? await readStdin() : await (await fetch(src)).text();

let vc;
try {
	vc = JSON.parse(vcJsonText);
} catch (e) {
	fail("vc_not_json", e.message);
}

run(vc).catch((e) => fail("internal_error", e.stack ?? e.message));

async function run(vc) {
	const result = {
		fetched: src,
		issuer: vc.issuer ?? null,
		id: vc.id ?? null,
		checks: {},
	};

	// 1. Structural sanity.
	const proof = vc.proof;
	if (!proof) fail("no_proof", "credential has no proof");
	check(
		result,
		"proof.type",
		proof.type === "DataIntegrityProof",
		`expected DataIntegrityProof, got ${proof.type}`,
	);
	check(
		result,
		"proof.cryptosuite",
		proof.cryptosuite === "eddsa-jcs-2022",
		`expected eddsa-jcs-2022, got ${proof.cryptosuite}`,
	);
	check(
		result,
		"proof.proofPurpose",
		proof.proofPurpose === "assertionMethod",
		`expected assertionMethod, got ${proof.proofPurpose}`,
	);
	check(result, "vc.type_contains_VerifiableCredential", Array.isArray(vc.type) && vc.type.includes("VerifiableCredential"));
	check(
		result,
		"vc.validFrom_in_past",
		typeof vc.validFrom === "string" && new Date(vc.validFrom) <= new Date(),
		`validFrom=${vc.validFrom} is in the future`,
	);

	// 2. Resolve issuer DID.
	const issuer = vc.issuer;
	if (typeof issuer !== "string" || !issuer.startsWith("did:web:")) {
		fail("unsupported_did_method", `only did:web is supported, got ${issuer}`);
	}
	const host = issuer.slice("did:web:".length).replace(/:/g, "/");
	const didUrl = `https://${host}/.well-known/did.json`;
	let didDoc;
	try {
		const r = await fetch(didUrl, { headers: { accept: "application/did+json, application/json" } });
		if (!r.ok) fail("did_fetch_failed", `${didUrl}: ${r.status}`);
		didDoc = await r.json();
	} catch (e) {
		fail("did_fetch_failed", `${didUrl}: ${e.message}`);
	}
	check(result, "did.id_matches_issuer", didDoc.id === issuer, `did.id=${didDoc.id}`);

	// 3. Locate verificationMethod.
	const vmId = proof.verificationMethod;
	check(result, "proof.verificationMethod_in_did", true);
	const [vmDid] = vmId.split("#");
	check(
		result,
		"vm.did_matches_issuer",
		vmDid === issuer,
		`verificationMethod refers to ${vmDid}, expected ${issuer}`,
	);
	const vm = (didDoc.verificationMethod || []).find((v) => v.id === vmId);
	if (!vm) fail("vm_not_found", `${vmId} not in didDocument.verificationMethod`);
	check(
		result,
		"vm.type",
		vm.type === "Ed25519VerificationKey2020" || vm.type === "Multikey",
		`unsupported verificationMethod type ${vm.type}`,
	);
	check(
		result,
		"vm.in_assertionMethod",
		(didDoc.assertionMethod || []).includes(vmId),
		`${vmId} not listed in didDocument.assertionMethod`,
	);

	// 4. Decode publicKeyMultibase → raw 32-byte Ed25519 public key.
	if (typeof vm.publicKeyMultibase !== "string") fail("vm_no_multibase", "publicKeyMultibase missing");
	const pubKeyRaw = decodeMultibaseKey(vm.publicKeyMultibase);

	// 5. Decode signature.
	if (typeof proof.proofValue !== "string") fail("proof_no_value", "proof.proofValue missing");
	const signature = decodeMultibaseSig(proof.proofValue);
	if (signature.length !== 64) fail("bad_signature_length", `expected 64 bytes, got ${signature.length}`);

	// 6. Build signing input per eddsa-jcs-2022:
	//    proofConfig = proof with proofValue removed + @context from credential
	//    transformedData = JCS(credential without proof)
	//    proofHash = SHA-256(JCS(proofConfig))
	//    dataHash = SHA-256(transformedData)
	//    signingInput = proofHash || dataHash
	const { proofValue: _, ...proofWithoutValue } = proof;
	const proofConfig = { ...proofWithoutValue, "@context": vc["@context"] };
	const { proof: __, ...credentialWithoutProof } = vc;

	const proofHash = sha256(jcs(proofConfig));
	const dataHash = sha256(jcs(credentialWithoutProof));
	const signingInput = Buffer.concat([proofHash, dataHash]);

	// 7. Reconstruct Ed25519 SPKI DER from the raw 32-byte key, then verify.
	const spki = Buffer.concat([
		Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
		pubKeyRaw,
	]);
	const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

	const ok = crypto.verify(null, signingInput, publicKey, signature);
	check(result, "signature_valid", ok, "Ed25519 signature did not verify");

	// 8. Surface evidence pointers for the operator to spot-check manually.
	const evidence = Array.isArray(vc.evidence) ? vc.evidence : [];
	for (const e of evidence) {
		if (e?.type === "SigstoreAttestation" && e.rekorUrl) {
			result.checks["evidence_rekor_url"] = { ok: true, value: e.rekorUrl };
		}
	}

	const allOk = Object.values(result.checks).every((c) => c.ok);
	console.log(JSON.stringify(result, null, 2));
	console.log(allOk ? "\n✅ VC verified" : "\n❌ VC verification FAILED");
	process.exit(allOk ? 0 : 1);
}

function check(result, name, ok, msg) {
	result.checks[name] = ok ? { ok: true } : { ok: false, reason: msg ?? "failed" };
}

function fail(code, detail) {
	console.error(JSON.stringify({ error: code, detail }, null, 2));
	process.exit(1);
}

// ---- JCS (RFC 8785) — keys sorted by codepoint, no whitespace, finite numbers only.

function jcs(value) {
	return Buffer.from(stringify(value), "utf8");
}

function stringify(value) {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(value[k])}`).join(",")}}`;
	}
	throw new Error(`JCS: unsupported type ${typeof value}`);
}

// ---- SHA-256

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest();
}

// ---- Multibase decode

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => {
	const m = new Int8Array(128).fill(-1);
	for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET.charCodeAt(i)] = i;
	return m;
})();

function decodeBase58btc(s) {
	if (s.length === 0) return Buffer.alloc(0);
	let zeros = 0;
	while (zeros < s.length && s[zeros] === "1") zeros++;
	const size = ((s.length - zeros) * 733) / 1000 + 1; // log(58)/log(256)
	const b256 = new Uint8Array(Math.floor(size) | 0);
	let length = 0;
	for (let i = zeros; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 0 || code > 127 || B58_MAP[code] === -1) {
			throw new Error(`base58btc: invalid character '${s[i]}' at position ${i}`);
		}
		let carry = B58_MAP[code];
		let j = 0;
		for (let k = b256.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
			carry += 58 * b256[k];
			b256[k] = carry & 0xff;
			carry >>= 8;
		}
		length = j;
	}
	let it = b256.length - length;
	while (it < b256.length && b256[it] === 0) it++;
	const out = Buffer.alloc(zeros + (b256.length - it));
	for (let i = 0; i < zeros; i++) out[i] = 0;
	for (let i = it; i < b256.length; i++) out[zeros + (i - it)] = b256[i];
	return out;
}

function decodeMultibaseKey(s) {
	// Expected: 'z' (base58btc) + multicodec_ed25519_pub(0xed 0x01) + 32 bytes
	if (!s.startsWith("z")) throw new Error(`unsupported multibase prefix '${s[0]}', expected 'z'`);
	const bytes = decodeBase58btc(s.slice(1));
	if (bytes.length !== 34) throw new Error(`expected 34 bytes (2 prefix + 32 key), got ${bytes.length}`);
	if (bytes[0] !== 0xed || bytes[1] !== 0x01) {
		throw new Error(`unexpected multicodec prefix 0x${bytes[0].toString(16)}${bytes[1].toString(16)}, expected ed01 (Ed25519)`);
	}
	return bytes.subarray(2);
}

function decodeMultibaseSig(s) {
	if (!s.startsWith("z")) throw new Error(`unsupported multibase prefix '${s[0]}', expected 'z'`);
	return decodeBase58btc(s.slice(1));
}

// ---- stdin

function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		process.stdin.on("data", (c) => chunks.push(c));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", reject);
	});
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyGithubOidc = verifyGithubOidc;
exports.resetReplayCacheForTests = resetReplayCacheForTests;
const node_crypto_1 = require("node:crypto");
const issuer = "https://token.actions.githubusercontent.com";
const jwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";
const replayCache = new Map();
let cachedJwks;
function decodePart(value) {
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("JWT section is not an object");
        }
        return parsed;
    }
    catch {
        throw new Error("OIDC token is malformed");
    }
}
function textClaim(payload, name) {
    const value = payload[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 500) {
        throw new Error(`OIDC claim ${name} is missing or malformed`);
    }
    return value;
}
function numericClaim(payload, name) {
    const value = payload[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`OIDC claim ${name} is missing or malformed`);
    }
    return value;
}
async function defaultJwksFetcher() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedJwks && cachedJwks.expiresAt > now) {
        return cachedJwks.value;
    }
    const response = await fetch(jwksUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
        throw new Error("GitHub OIDC signing keys are unavailable");
    }
    const value = (await response.json());
    if (!value || !Array.isArray(value.keys) || value.keys.length === 0) {
        throw new Error("GitHub OIDC signing keys are malformed");
    }
    cachedJwks = { expiresAt: now + 300, value };
    return value;
}
async function verifyGithubOidc(token, policy, jwksFetcher = defaultJwksFetcher) {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw new Error("OIDC token is malformed");
    }
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new Error("OIDC token algorithm or key ID is unsupported");
    }
    const jwks = await jwksFetcher();
    const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
        throw new Error("OIDC token signing key is unknown");
    }
    const validSignature = (0, node_crypto_1.verify)("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), (0, node_crypto_1.createPublicKey)({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!validSignature) {
        throw new Error("OIDC token signature is invalid");
    }
    const now = policy.nowSeconds ?? Math.floor(Date.now() / 1000);
    const issuedAt = numericClaim(payload, "iat");
    const notBefore = numericClaim(payload, "nbf");
    const expiresAt = numericClaim(payload, "exp");
    if (notBefore > now + 30 ||
        issuedAt > now + 30 ||
        issuedAt < now - 600 ||
        expiresAt <= now ||
        expiresAt > now + 900) {
        throw new Error("OIDC token lifetime is outside the accepted window");
    }
    if (textClaim(payload, "iss") !== issuer) {
        throw new Error("OIDC token issuer is invalid");
    }
    const audience = payload.aud;
    if (!(audience === policy.audience ||
        (Array.isArray(audience) &&
            audience.length === 1 &&
            audience[0] === policy.audience))) {
        throw new Error("OIDC token audience is invalid");
    }
    if (textClaim(payload, "repository") !== policy.repository) {
        throw new Error("OIDC token repository is invalid");
    }
    if (textClaim(payload, "ref") !== policy.ref) {
        throw new Error("OIDC token ref is invalid");
    }
    if (textClaim(payload, "sha") !== policy.expectedSha) {
        throw new Error("OIDC token SHA is invalid");
    }
    if (textClaim(payload, "workflow_sha") !== policy.expectedSha) {
        throw new Error("OIDC token workflow SHA is invalid");
    }
    const expectedWorkflowRef = `${policy.repository}/${policy.workflowPath}@${policy.ref}`;
    if (textClaim(payload, "workflow_ref") !== expectedWorkflowRef) {
        throw new Error("OIDC token workflow is invalid");
    }
    if (textClaim(payload, "sub") !== policy.subject) {
        throw new Error("OIDC token subject is invalid");
    }
    if (!policy.eventNames.includes(textClaim(payload, "event_name"))) {
        throw new Error("OIDC token event is invalid");
    }
    const jti = textClaim(payload, "jti");
    for (const [seen, expiry] of replayCache) {
        if (expiry <= now) {
            replayCache.delete(seen);
        }
    }
    if (replayCache.has(jti)) {
        throw new Error("OIDC token replay was rejected");
    }
    replayCache.set(jti, expiresAt);
    return payload;
}
function resetReplayCacheForTests() {
    replayCache.clear();
    cachedJwks = undefined;
}

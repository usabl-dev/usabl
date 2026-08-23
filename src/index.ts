/** Public library surface. Callers project a Result; they do not mint a verdict. */
export * from './contracts/index.js';
export { run } from './run.js';
export { gate } from './gate/index.js';
export { computePolicyHash, mintReceipt, verifyReceipt } from './evidence/receipt.js';
export { computeGuardDivergence } from './guard/index.js';
export { computeIdentity, IDENTITY_WEAK } from './primitives/identity.js';
export { canonicalize, sha256, canonicalHash } from './primitives/canonical.js';
export { sortBy } from './primitives/sortKey.js';
export { makeFakeDeps } from './deps/fakes.js';
export { formatSummary } from './output/summary.js';
export { computeConformance } from './output/conformance.js';

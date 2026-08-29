/** Public library surface. Callers project a Result; they do not mint a verdict. */
export * from './contracts/index.js';
export { run } from './run.js';
export { gate } from './gate/index.js';
export { computePolicyHash, mintReceipt, verifyReceipt } from './evidence/receipt.js';
export { computeIdentity, IDENTITY_WEAK } from './primitives/identity.js';
export { canonicalize, sha256, canonicalHash } from './primitives/canonical.js';
export { sortBy } from './primitives/sortKey.js';
export { makeFakeDeps } from './deps/fakes.js';
export { formatSummary } from './output/summary.js';
export { computeConformance } from './output/conformance.js';
export { collectDocArtifacts, projectDocs } from './surfaces/docs.js';
export { makeVirtualSrProvider } from './voicing/virtual-sr-provider.js';
export { runStructuralTier } from './voicing/structural.js';
export { runVoicingTier } from './voicing/voicing.js';
export { normalizeToken, obligationSatisfied } from './voicing/normalize.js';

// ---------------------------------------------------------------------------
// Where is this code running?
//
// Guards that fail closed need to distinguish "deployed" from "someone's laptop",
// and NODE_ENV is the wrong signal for that: `next start` sets it to "production"
// for a local production build too. Using it would make a local build refuse to
// start without cloud credentials, which breaks both `npm start` and the E2E
// suite that runs against a locally built app.
//
// Vercel sets VERCEL on every deployment and VERCEL_ENV to
// production | preview | development. Those are the signals that actually mean
// what the guards need them to mean.
// ---------------------------------------------------------------------------

/** True on any Vercel deployment (production or preview); false locally and in tests. */
export function isDeployed(): boolean {
  return Boolean(process.env.VERCEL)
}

/** True only on the production deployment. */
export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === "production"
}
